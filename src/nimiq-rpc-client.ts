// RPC-backed NimiqClientLike — the production settlement client that actually
// works on our hosts. It implements the SAME NimiqClientLike surface that
// NimiqProvider already consumes (so the matcher, detected→paid staging, expiry,
// and ALL their tests stay byte-identical); it just reads the chain over a
// Nimiq Albatross JSON-RPC node instead of the @nimiq/core browser/light client
// (which does not run under Bun — config is dropped in the worker postMessage —
// nor sync under Node here).
//
// WHY BLOCK-SCAN (not getTransactionsByAddress)
//   A validator / non-history node CANNOT answer getTransactionsByAddress (no
//   history index). That's fine for a POS: every sale is watched from creation
//   onward, so we forward-scan each NEW block's transactions from the height at
//   which we start and fire the listener for any tx to a watched address. This
//   mirrors the proven nimiq.tech Beelink watcher.
//
// RPC CONTRACT (verified against a live MainAlbatross node)
//   - JSON-RPC 2.0 over HTTP POST; results are wrapped: result.data.
//   - getBlockNumber() -> head height (number)
//   - getBlockByNumber(n, true) -> block; block.transactions[] when includeTxs
//   - isConsensusEstablished() -> boolean
//   - getTransactionByHash(h) -> tx (used to re-verify a payment before "paid")
//   - tx fields read: hash, from, to, value (luna), recipientData (hex memo),
//     confirmations, executionResult, blockNumber.
//
// MAPPING tx JSON -> TxDetails (the shape matchTransaction reads)
//   hash -> transactionHash ; from -> sender ; to -> recipient ;
//   value -> value (luna) ; recipientData(hex) -> data.raw, data.type="raw".
//   state is SYNTHESIZED from confirmation depth:
//     first sighting in a block        -> "included"  (provider fires "detected")
//     >= confirmations (re-verified)    -> "confirmed" (provider fires "paid")
//
// NON-CUSTODIAL: read-only. We never hold keys, sign, or move funds.

import type { NimiqClientLike, TxDetails } from "./nimiq-provider";

/** Narrow fetch shape we actually use (global `fetch` is assignable to it; a
 *  test can pass a tiny fake without implementing `preconnect` et al.). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RpcClientOptions {
  /** Node JSON-RPC base, e.g. http://127.0.0.1:8648 */
  url: string;
  /** Confirmation depth at which a payment is reported "paid". Default 10. */
  confirmations?: number;
  /** Head-poll cadence in ms. Default 1000 (Albatross ~1 block/s). */
  pollMs?: number;
  /**
   * Height to begin scanning from. Default: the node's current head at the time
   * the listener is registered (so we never scan history — a POS only cares
   * about payments made after it started watching). Pass a number to override.
   */
  startHeight?: number | null;
  /**
   * One-time boot backfill: how many blocks BEFORE the start height to re-scan on
   * the first tick, so a payment that landed while the process was down is still
   * caught (the armed map is in-memory and re-armed on boot). Default 0. Sized to
   * the oldest open sale by the server. Ignored if `startHeight` is set.
   */
  backfillBlocks?: number;
  /** Safety cap on blocks scanned per tick when catching up. Default 600. */
  maxBlocksPerPoll?: number;
  /** Per-RPC timeout in ms. Default 15000. */
  rpcTimeoutMs?: number;
  /** Injectable fetch (tests). Default global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable logger (tests). Default console. */
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

const norm = (a: string | undefined | null) => (a ?? "").replace(/\s+/g, "").toUpperCase();

interface RegisteredListener {
  listener: (tx: TxDetails) => unknown;
  addresses: Set<string>;
}

/** A matched-address tx we are tracking through detected → paid. */
interface Pending {
  base: Omit<TxDetails, "state">;
  blockNumber: number;
  emittedDetected: boolean;
  emittedConfirmed: boolean;
}

export class RpcNimiqClient implements NimiqClientLike {
  private readonly url: string;
  private readonly confirmations: number;
  private readonly pollMs: number;
  private readonly startHeightOpt: number | null;
  private readonly backfillBlocks: number;
  private readonly maxBlocksPerPoll: number;
  private readonly rpcTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

  private listeners = new Map<number, RegisteredListener>();
  private nextHandle = 1;
  /** All watched addresses (union across listeners), normalized. */
  private watched = new Set<string>();
  private pending = new Map<string, Pending>(); // by tx hash
  private seen = new Set<string>(); // hashes already fully handled (paid) — avoid re-add
  private lastScanned = -1;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: RpcClientOptions) {
    this.url = opts.url;
    this.confirmations = Math.max(1, opts.confirmations ?? 10);
    this.pollMs = Math.max(200, opts.pollMs ?? 1000);
    this.startHeightOpt = opts.startHeight ?? null;
    this.backfillBlocks = Math.max(0, opts.backfillBlocks ?? 0);
    // Per-tick cap must be able to cover the boot backfill in one sweep, else the
    // catch-up clamp would skip past the very downtime blocks we want to re-scan.
    this.maxBlocksPerPoll = Math.max(opts.maxBlocksPerPoll ?? 600, this.backfillBlocks + 10);
    this.rpcTimeoutMs = Math.max(1000, opts.rpcTimeoutMs ?? 15000);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? console;
  }

  // ── JSON-RPC ───────────────────────────────────────────────────────────────
  async rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.rpcTimeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: { data?: T }; error?: unknown };
      if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      return json.result?.data as T;
    } finally {
      clearTimeout(t);
    }
  }

  private getBlockNumber(): Promise<number> {
    return this.rpc<number>("getBlockNumber", []);
  }
  private getBlockByNumber(n: number): Promise<{ transactions?: RpcTx[] } | null> {
    return this.rpc<{ transactions?: RpcTx[] } | null>("getBlockByNumber", [n, true]);
  }

  async waitForConsensusEstablished(): Promise<void> {
    // Poll until the node reports consensus; resolves immediately if already up.
    // Bounded patience: a freshly-started node may need a moment.
    for (let i = 0; i < 600 && !this.stopped; i++) {
      try {
        if (await this.rpc<boolean>("isConsensusEstablished", [])) return;
      } catch (e) {
        this.log.warn("[nimiq-rpc] isConsensusEstablished failed:", (e as Error).message);
      }
      await delay(Math.min(this.pollMs, 1000));
    }
  }

  // ── Listener registration ────────────────────────────────────────────────
  async addTransactionListener(
    listener: (tx: TxDetails) => unknown,
    addresses: string[],
  ): Promise<number> {
    const handle = this.nextHandle++;
    const set = new Set(addresses.map(norm));
    this.listeners.set(handle, { listener, addresses: set });
    for (const a of set) this.watched.add(a);
    // Anchoring is deferred to the first SUCCESSFUL scan (see scanOnce): the RPC
    // node may be unreachable at boot (e.g. the SSH tunnel isn't up yet), and we
    // must not anchor off a failed head fetch — that would skip the backfill window.
    this.startPolling();
    return handle;
  }

  async removeListener(handle: number): Promise<void> {
    this.listeners.delete(handle);
    // Recompute the watched union.
    this.watched = new Set();
    for (const l of this.listeners.values()) for (const a of l.addresses) this.watched.add(a);
    if (this.listeners.size === 0) this.stop();
  }

  /**
   * Without a history index we cannot truly query by address. The continuous
   * poller already catches every live payment (and self-heals by always scanning
   * lastScanned→head), so backfill is a no-op that returns nothing rather than a
   * misleading partial. Reconnect recovery is inherent to the catch-up scan.
   */
  async getTransactionsByAddress(_address: string, _sinceBlockHeight?: number | null): Promise<TxDetails[]> {
    return [];
  }

  // ── Poll loop ────────────────────────────────────────────────────────────
  private startPolling(): void {
    if (this.pollTimer || this.stopped) return;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.scanOnce();
      } catch (e) {
        this.log.warn("[nimiq-rpc] scan tick failed:", (e as Error).message);
      }
      if (!this.stopped) this.pollTimer = setTimeout(tick, this.pollMs);
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  private stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** One scan: ingest new blocks, then stage pending txs detected→paid. */
  private async scanOnce(): Promise<void> {
    const head = await this.getBlockNumber();
    if (typeof head !== "number") return;

    // Anchor on the FIRST successful scan (head is valid here) so a node that was
    // unreachable at boot doesn't skip the backfill window. Default: head minus the
    // one-time boot backfill; an explicit startHeight overrides and disables it.
    if (this.lastScanned < 0) {
      this.lastScanned =
        this.startHeightOpt != null
          ? Math.max(-1, this.startHeightOpt - 1)
          : Math.max(-1, head - 1 - this.backfillBlocks);
    }

    let from = this.lastScanned + 1;
    if (head - from + 1 > this.maxBlocksPerPoll) {
      // Fell far behind (long stall / fresh start with a high override): skip the
      // gap and scan only the most recent window. A POS doesn't care about old
      // blocks, and unbounded catch-up would hammer the node.
      from = head - this.maxBlocksPerPoll + 1;
      this.log.warn(`[nimiq-rpc] behind by >${this.maxBlocksPerPoll} blocks; skipping to ${from}`);
    }
    for (let n = from; n <= head; n++) {
      const blk = await this.getBlockByNumber(n);
      const txs = (blk?.transactions ?? []) as RpcTx[];
      for (const tx of txs) this.ingestTx(tx, n);
      // Advance per-block: a transient mid-scan RPC failure (getBlockByNumber throws) aborts the
      // tick, and the next tick resumes from the failed block — never re-scanning the blocks already
      // ingested (no double-work on a large backfill), and never skipping one (a skip could miss a
      // payment). Already-ingested entries persist in `pending` across the aborted tick.
      this.lastScanned = n;
    }

    await this.stagePending(head);
  }

  /** Track a tx if it pays a watched address and we haven't finished it. */
  private ingestTx(tx: RpcTx, blockNumber: number): void {
    const to = norm(tx.to);
    if (!this.watched.has(to)) return;
    if (tx.executionResult === false) return; // failed tx never settles
    const hash = tx.hash;
    if (!hash || this.seen.has(hash) || this.pending.has(hash)) return;
    this.pending.set(hash, {
      base: {
        transactionHash: hash,
        sender: tx.from ?? "",
        recipient: tx.to ?? "",
        value: typeof tx.value === "number" ? tx.value : Number(tx.value) || 0,
        data: { type: "raw", raw: tx.recipientData ?? "" },
      },
      blockNumber: typeof tx.blockNumber === "number" ? tx.blockNumber : blockNumber,
      emittedDetected: false,
      emittedConfirmed: false,
    });
  }

  /** Fire "included" (detected) then, at depth, re-verified "confirmed" (paid). */
  private async stagePending(head: number): Promise<void> {
    for (const [hash, p] of this.pending) {
      if (!p.emittedDetected) {
        this.emit({ ...p.base, state: "included" });
        p.emittedDetected = true;
      }
      const depth = head - p.blockNumber + 1;
      if (depth >= this.confirmations && !p.emittedConfirmed) {
        // Re-verify against the node before declaring paid (guards micro-fork
        // reverts): the tx must still exist with enough confirmations.
        const ok = await this.confirmStillIncluded(hash);
        if (ok) {
          this.emit({ ...p.base, state: "confirmed" });
          p.emittedConfirmed = true;
          this.seen.add(hash);
          this.pending.delete(hash);
        }
      }
    }
  }

  private async confirmStillIncluded(hash: string): Promise<boolean> {
    try {
      const tx = await this.rpc<RpcTx | null>("getTransactionByHash", [hash]);
      if (!tx || tx.executionResult === false) return false;
      const confs = typeof tx.confirmations === "number" ? tx.confirmations : 0;
      return confs >= this.confirmations;
    } catch {
      // If the node can't answer by-hash (e.g. no history for an older tx),
      // fall back to trusting the depth we already computed from head.
      return true;
    }
  }

  private emit(tx: TxDetails): void {
    const to = norm(tx.recipient);
    for (const { listener, addresses } of this.listeners.values()) {
      if (addresses.has(to)) {
        try {
          listener(tx);
        } catch (e) {
          this.log.error("[nimiq-rpc] listener threw:", (e as Error).message);
        }
      }
    }
  }
}

/** Raw Albatross RPC transaction (subset we read). */
interface RpcTx {
  hash?: string;
  from?: string;
  to?: string;
  value?: number;
  recipientData?: string;
  confirmations?: number;
  executionResult?: boolean;
  blockNumber?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Factory used by the provider's clientFactory in index.ts. */
export function createRpcClient(opts: RpcClientOptions): NimiqClientLike {
  return new RpcNimiqClient(opts);
}
