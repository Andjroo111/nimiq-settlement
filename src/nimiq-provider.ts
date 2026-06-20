// LIVE settlement watcher via @nimiq/core — implements the existing
// SettlementProvider interface (kind:"nimiq", simulated:false), so there are
// ZERO route/state-machine changes. the consuming app stays NON-CUSTODIAL: this only
// watches the merchant's OWN receive address; it never holds keys or funds.
//
// HOW IT WORKS
//   - One shared light-client per process (NOT one per sale). Created lazily by
//     the production factory in index.ts; tests inject a fake client instead.
//   - ONE persistent transaction listener over [merchantAddress]. Each armed
//     sale lives in an in-memory map keyed by reference ("snap:xxxxxxxx").
//   - On a tx callback, matchTransaction() binds tx → sale by:
//       recipient === merchantAddress (guaranteed by the listener filter) AND
//       value (luna) >= req.amountLuna (guard) AND
//       data.type==="raw" && hex→utf8(data.raw) === req.reference (primary key).
//   - SETTLEMENT STAGING (detected → paid): onSettled fires for each state advance.
//       * "included"  → fire status:"detected" (seen on-chain), keep the entry
//         armed and unsettled so the later "confirmed" tx still fires "paid".
//       * "confirmed" → fire status:"paid", clear timer, drop the entry.
//     Each status fires at most once: a duplicate "included" does NOT re-fire
//     detected, and detected never fires after paid. A "confirmed"-first sighting
//     (no prior included) fires a single "paid".
//   - OVERPAYMENT (Defect 3): matchTransaction accepts value >= amountLuna, so an
//     exact-or-over pay settles (merchant made whole or better; non-custodial — we
//     never refund). The actual tx.value is forwarded as valueLuna so the sale row
//     records what was really sent. Underpay does not match and rides to expiry.
//   - EXPIRY (Defect 1): an optional per-sale timeout, on elapse, invokes the
//     onExpired callback (the route moves the sale pending/detected → expired) and
//     drops the armed entry. Expiry NEVER fires onSettled.
//   - Idempotency: settled entries are removed; cancel() is idempotent.
//   - Reconnect safety: on consensus (re)established, backfill via
//     getTransactionsByAddress to catch payments that landed during a gap.
//
// ── RUNNING THE LIVE PATH (testnet) ──────────────────────────────────────────
//   APP_SETTLEMENT=nimiq \
//   APP_RATE_SOURCE=live \
//   APP_NETWORK=TestAlbatross \
//   APP_MERCHANT_ADDRESS="NQ.. your testnet receive address" \
//   bun run src/server.ts
//   Then create a sale, send testnet NIM to the address with the sale's
//   `snap:xxxxxxxx` message (extraData). The watcher detects it and marks paid.
//   Get testnet NIM from the Nimiq testnet faucet. See index.ts for all knobs.

import type { PaymentRequest, Settlement, SettlementProvider } from "./provider";

// ── Minimal client surface (subset of @nimiq/core Client) ────────────────────
// The real Client satisfies this structurally; tests pass a tiny fake. We never
// import the real Client here — index.ts owns its construction.

/** The fields of a @nimiq/core PlainTransactionDetails this matcher reads. */
export interface TxDetails {
  transactionHash: string;
  /** PUBLIC user-friendly NQ.. address that sent the payment (the buyer). On-chain
   *  public data, never a secret — captured so a merchant-initiated refund can
   *  prefill the buyer's address. Non-custodial: the consuming app only records it. */
  sender: string;
  recipient: string;
  value: number;
  state: "new" | "pending" | "included" | "confirmed" | "invalidated" | "expired";
  data: { type: string; raw?: string } & Record<string, unknown>;
}

export interface NimiqClientLike {
  addTransactionListener(listener: (tx: TxDetails) => unknown, addresses: string[]): Promise<number>;
  removeListener(handle: number): Promise<void>;
  getTransactionsByAddress(address: string, sinceBlockHeight?: number | null): Promise<TxDetails[]>;
  waitForConsensusEstablished(): Promise<void>;
  addConsensusChangedListener?(listener: (state: string) => unknown): Promise<number>;
}

// ── Pure matcher (unit-tested with hand-built fixtures, no client) ────────────

/** Decode a hex string to UTF-8. Returns null on malformed input. */
export function hexToUtf8(hex: string | undefined): string | null {
  if (!hex || typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type MatchResult = "detected" | "paid" | null;

/**
 * Bind a tx to a payment request. Returns:
 *   "paid"     — confirmed, reference + amount match
 *   "detected" — included (seen on-chain), reference + amount match
 *   null       — not a match (wrong recipient/amount/reference, or non-event state)
 *
 * Reference (extraData) is the primary key; amount is a guard so two same-price
 * sales can't be confused. Recipient must equal the merchant address.
 */
export function matchTransaction(req: PaymentRequest, tx: TxDetails, merchantAddress: string): MatchResult {
  // Normalize addresses (strip spaces) so user-friendly formatting differences don't matter.
  const norm = (a: string) => a.replace(/\s+/g, "").toUpperCase();
  if (norm(tx.recipient) !== norm(merchantAddress)) return null;
  // OVERPAYMENT POLICY (explicit): an EXACT or OVER payment matches — the merchant
  // is made whole or better, and the consuming app never refunds (non-custodial; refunds, if
  // any, are a merchant wallet-to-wallet action outside the app). An UNDER payment
  // does NOT match: the sale stays pending and rides to expiry. The actual tx.value
  // is forwarded to the caller (as valueLuna) so overpay is recorded, not dropped.
  if (!(typeof tx.value === "number" && tx.value >= req.amountLuna)) return null;
  if (tx.data?.type !== "raw") return null;
  if (hexToUtf8(tx.data.raw) !== req.reference) return null;

  if (tx.state === "confirmed") return "paid";
  if (tx.state === "included") return "detected";
  // "new" | "pending" | "invalidated" | "expired" → not a settlement event.
  return null;
}

// ── Provider ─────────────────────────────────────────────────────────────────

interface Armed {
  req: PaymentRequest;
  cb: (s: Settlement) => void;
  onExpired?: (saleId: string, reference: string) => void;
  /** true once "paid" has fired (terminal); the entry is then removed. */
  settled: boolean;
  /** true once "detected" has fired (so a duplicate "included" won't re-fire). */
  detected: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface NimiqProviderOptions {
  /** Merchant receive address (user-friendly NQ..). Validated by the factory. */
  merchantAddress: string;
  /**
   * Async factory for the shared client. Called once, lazily. Production passes
   * a factory that builds a real @nimiq/core Client; tests pass a fake.
   */
  clientFactory: () => Promise<NimiqClientLike>;
  /**
   * Per-sale expiry; on elapse the entry is dropped and onExpired (passed to
   * watch) is invoked WITHOUT firing onSettled. 0 = off.
   */
  payTimeoutMs?: number;
}

export class NimiqProvider implements SettlementProvider {
  readonly kind = "nimiq" as const;
  readonly simulated = false;

  private readonly merchantAddress: string;
  private readonly clientFactory: () => Promise<NimiqClientLike>;
  private readonly payTimeoutMs: number;

  /** Armed sales keyed by reference (the snap:xxxxxxxx primary key). */
  private armed = new Map<string, Armed>();

  private clientPromise: Promise<NimiqClientLike> | null = null;
  private client: NimiqClientLike | null = null;
  private listenerHandle: number | null = null;
  private listenerReady: Promise<void> | null = null;

  constructor(opts: NimiqProviderOptions) {
    this.merchantAddress = opts.merchantAddress;
    this.clientFactory = opts.clientFactory;
    this.payTimeoutMs = opts.payTimeoutMs ?? 0;
    // Kick off client creation eagerly so the first sale has the least latency.
    void this.ensureListener().catch((e) => console.error("[nimiq] client init failed:", (e as Error).message));
  }

  async getReceiveAddress(): Promise<string> {
    return this.merchantAddress;
  }

  /** Lazily create the shared client + register the single persistent listener. */
  private ensureListener(): Promise<void> {
    if (this.listenerReady) return this.listenerReady;
    this.listenerReady = (async () => {
      if (!this.clientPromise) this.clientPromise = this.clientFactory();
      const client = await this.clientPromise;
      this.client = client;
      this.listenerHandle = await client.addTransactionListener((tx) => this.onTx(tx), [this.merchantAddress]);

      // Backfill on consensus (re)established to recover payments missed during a gap.
      if (client.addConsensusChangedListener) {
        void client.addConsensusChangedListener((state) => {
          if (state === "established") void this.backfill();
        });
      }
    })();
    return this.listenerReady;
  }

  /** Feed every armed sale through getTransactionsByAddress to catch missed txs. */
  private async backfill(): Promise<void> {
    if (!this.client || this.armed.size === 0) return;
    try {
      const txs = await this.client.getTransactionsByAddress(this.merchantAddress);
      for (const tx of txs) this.onTx(tx);
    } catch (e) {
      console.warn("[nimiq] backfill failed:", (e as Error).message);
    }
  }

  /**
   * Listener callback: match against armed sales and stage detected → paid.
   * Uses the MatchResult so "included" fires "detected" (entry stays armed) and
   * "confirmed" fires "paid" (entry removed). Each status fires at most once.
   */
  private onTx(tx: TxDetails): void {
    for (const entry of this.armed.values()) {
      if (entry.settled) continue; // already paid → ignore
      const m = matchTransaction(entry.req, tx, this.merchantAddress);
      if (m === null) continue;

      if (m === "detected") {
        if (entry.detected) continue; // duplicate "included" → don't re-fire
        entry.detected = true;
        // Keep the entry armed + unsettled so the later "confirmed" still fires paid.
        entry.cb({
          saleId: entry.req.saleId,
          txHash: tx.transactionHash,
          detectedAt: Date.now(),
          status: "detected",
          valueLuna: tx.value,
          senderAddress: tx.sender,
        });
        continue;
      }

      // m === "paid" (confirmed): terminal. Clear timer first so an in-flight
      // expiry can't race the paid write, drop the entry, then fire.
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.armed.delete(entry.req.reference);
      entry.cb({
        saleId: entry.req.saleId,
        txHash: tx.transactionHash,
        detectedAt: Date.now(),
        status: "paid",
        valueLuna: tx.value,
        senderAddress: tx.sender,
      });
    }
  }

  watch(
    req: PaymentRequest,
    onSettled: (s: Settlement) => void,
    onExpired?: (saleId: string, reference: string) => void,
  ): () => void {
    const entry: Armed = { req, cb: onSettled, onExpired, settled: false, detected: false };
    if (this.payTimeoutMs > 0) {
      entry.timer = setTimeout(() => {
        // Expiry: drop WITHOUT firing onSettled, then notify the route so it can
        // move pending/detected → expired. We never resurrect a settled entry.
        const cur = this.armed.get(req.reference);
        if (cur && !cur.settled) {
          this.armed.delete(req.reference);
          cur.onExpired?.(req.saleId, req.reference);
        }
      }, this.payTimeoutMs);
    }
    this.armed.set(req.reference, entry);

    // Make sure the listener is live, then backfill in case the payment already
    // landed before this sale was armed (e.g. fast scanner, reconnect).
    void this.ensureListener()
      .then(() => this.backfill())
      .catch((e) => console.error("[nimiq] watch arm failed:", (e as Error).message));

    return () => {
      const cur = this.armed.get(req.reference);
      if (cur?.timer) clearTimeout(cur.timer);
      this.armed.delete(req.reference); // idempotent
    };
  }

  /** Clean shutdown: unregister the listener (call on SIGTERM). */
  async dispose(): Promise<void> {
    if (this.client && this.listenerHandle !== null) {
      try {
        await this.client.removeListener(this.listenerHandle);
      } catch {
        /* ignore */
      }
    }
    for (const e of this.armed.values()) if (e.timer) clearTimeout(e.timer);
    this.armed.clear();
  }
}
