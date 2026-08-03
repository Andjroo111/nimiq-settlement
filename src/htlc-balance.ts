// HTLC-aware balance — the DISPLAY half of the settlement seam.
//
// A Nimiq Pay user's basic account balance UNDER-REPORTS whenever Pay has locked NIM in a
// swap HTLC, sometimes all the way to zero. Every fleet screen that renders a balance from
// `getAccountByAddress` alone will therefore tell a solvent user they are broke. This walks
// the address's history, finds the HTLC contracts it funded, and adds back the ones that
// are still ours.
//
// SCOPE — DISPLAY ONLY. Never gate a spend or a credit on this. Proving a money movement by
// re-reading BOTH balances after the fact is strictly stronger than any balance snapshot,
// HTLC-aware or not (see nimiq.kids#276, where the affordability pre-check was deleted
// rather than made cleverer). This module exists so a screen stops lying, nothing more.
//
// COST — measured on our own mainnet node (127.0.0.1:8649), 2026-08-03:
//     getAccountByAddress          ~0.35 s
//     getTransactionsByAddress     ~13.3 s      ← 37x
// Unshippable inline on a request handler. Callers MUST put this behind their existing
// cache and refresh it in the background. This module deliberately does no caching of its
// own: a cache with the wrong TTL is worse than no cache, and the caller knows its screen.
//
// THE NODE MATTERS — a validator / non-history node cannot answer getTransactionsByAddress
// at all. Silently returning the basic balance there is the exact under-report this module
// exists to fix, so by default it THROWS instead (`onDegraded: "throw"`). A caller that
// would rather render a partial number opts into it explicitly and gets a count of the
// addresses whose walk did not finish.
//
// FIELD SHAPES — verified against live mainnet, 2026-08-03, not read off a type:
//   getAccountByAddress on an HTLC returns
//     { type: "htlc", balance, sender, recipient, hashRoot, hashCount, timeout, totalAmount }
//   - `timeout` is a MILLISECOND UNIX TIMESTAMP, not a block height. Nothing in
//     @nimiq/core's PlainHtlcContract says which it is; this was measured.
//   - `sender` / `recipient` come back SPACED. Addresses must also be sent SPACED at the
//     RPC boundary. Normalize on the way in, format on the way out.
//   - Transaction `fromType` / `toType` are numeric; 2 is HTLC.

import type { FetchLike } from "./nimiq-rpc-client";

/** Numeric account type for an HTLC in transaction `fromType` / `toType`. */
export const ACCOUNT_TYPE_HTLC = 2;

/** An HTLC contract account, as `getAccountByAddress` returns it. */
export interface HtlcAccount {
  type?: string;
  balance?: number;
  sender?: string;
  recipient?: string;
  /** MILLISECOND unix timestamp. Not a block height. */
  timeout?: number;
  totalAmount?: number;
}

/** The subset of a history transaction this walk reads. */
export interface HistoryTx {
  from?: string;
  to?: string;
  fromType?: number;
  toType?: number;
}

/** Why an address's walk did not finish. Absent when it did. */
export type IncompleteReason =
  /** The node has no history index — it cannot answer getTransactionsByAddress at all. */
  | "no_history_index"
  /** A required RPC call kept failing after every retry. */
  | "rpc_failed"
  /** More candidate contracts than `maxContracts` — some were never queried. */
  | "contract_capped";

export interface AddressBalance {
  /** Echoed back exactly as passed in, so a caller can key its cache on its own string. */
  address: string;
  /** What `getAccountByAddress` alone would have reported. */
  basicLuna: number;
  /** Unexpired HTLCs we funded: in flight, still ours. */
  htlcLuna: number;
  htlcCount: number;
  /** basicLuna + htlcLuna. The number to render. */
  totalLuna: number;
  /**
   * EXPIRED HTLCs we funded that still hold a balance — refundable to us, so arguably more
   * definitely ours than the in-flight ones. Deliberately NOT in `totalLuna`: the decided
   * gate is `timeout > now`, and reporting a claimable-but-unclaimed amount as spendable
   * would be its own lie. Surfaced rather than dropped so nothing goes missing silently.
   */
  reclaimableLuna: number;
  reclaimableCount: number;
  /** false ⇒ `totalLuna` may under-report by an unknown amount. Never ignore this. */
  complete: boolean;
  incompleteReason?: IncompleteReason;
}

export interface HtlcBalanceReport {
  balances: AddressBalance[];
  /** Sum of every address's `totalLuna`. Under-reports if `unreadableCount > 0`. */
  totalLuna: number;
  /** The addresses whose walk did not finish, exactly as they were passed in. */
  unreadable: string[];
  /** The explicit count. Check it before rendering `totalLuna` as a fact. */
  unreadableCount: number;
  /** false ⇒ the node has no history index and no HTLC could be seen at all. */
  historySupported: boolean;
}

export interface HtlcBalanceOptions {
  /** Node JSON-RPC base, e.g. http://127.0.0.1:8649 */
  url: string;
  /** Per-RPC timeout in ms. Default 20000 — a history read measures ~13.3s. */
  rpcTimeoutMs?: number;
  /** Injectable fetch (tests). Default global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable logger (tests). Default console. */
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** Injectable clock (tests) — the HTLC expiry gate reads it. Default Date.now. */
  now?: () => number;
  /** Injectable sleep (tests) — the retry backoff reads it. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** History transactions to request per address. Default 500. */
  maxHistory?: number;
  /** Hard cap on contract accounts queried per address. Default 64. */
  maxContracts?: number;
  /**
   * How many HTLC→HTLC hops to follow beyond the contracts our own history names.
   * Default 0, and that is usually right: a chained contract's `sender` is the swap
   * counterparty, not us, so it fails the ownership gate anyway — while each hop costs
   * another ~13.3s history read. Raise it only for a Pay flow proven to re-fund a chained
   * HTLC from our own address.
   */
  maxHops?: number;
  /** Retries per RPC call before giving up. Default 3. */
  retries?: number;
  /** First backoff delay in ms; doubles each retry. Default 250. */
  backoffMs?: number;
  /**
   * What to do when the walk cannot complete. "throw" (default) refuses to hand back a
   * number that silently under-reports — the failure mode this module exists to prevent.
   * "report" returns the partial read with `complete: false` and a reason.
   */
  onDegraded?: "throw" | "report";
}

export interface HtlcAwareBalance {
  /** One address, HTLCs included. Throws on an incomplete walk unless onDegraded="report". */
  read(address: string): Promise<AddressBalance>;
  /**
   * Many addresses. Sequential on purpose — a history read is ~13.3s and parallel ones
   * rate-limit the node. Per-address failures are always REPORTED, never thrown, because
   * the count of addresses it could not read is the point of this call.
   */
  readMany(addresses: string[]): Promise<HtlcBalanceReport>;
  /** Whether the node has a history index. Probed once, then cached for this instance. */
  historySupported(): Promise<boolean>;
}

/** Compact, comparable form: no spaces, upper case. */
export const compactAddress = (a: string | null | undefined): string =>
  (a ?? "").replace(/\s+/g, "").toUpperCase();

/** Wire form: addresses must be SPACED at the RPC boundary. */
export const spaceAddress = (a: string | null | undefined): string =>
  compactAddress(a).replace(/(.{4})(?=.)/g, "$1 ");

class DegradedError extends Error {
  constructor(public readonly reason: IncompleteReason, address: string) {
    super(
      `htlc-balance: incomplete walk for ${address} (${reason}). Refusing to report a ` +
        `balance that under-reports. Point at a history node, or pass onDegraded:"report".`,
    );
    this.name = "DegradedError";
  }
}

export function createHtlcAwareBalance(opts: HtlcBalanceOptions): HtlcAwareBalance {
  const url = opts.url;
  const timeoutMs = Math.max(1000, opts.rpcTimeoutMs ?? 20_000);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.logger ?? console;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxHistory = Math.max(1, opts.maxHistory ?? 500);
  const maxContracts = Math.max(1, opts.maxContracts ?? 64);
  const maxHops = Math.max(0, opts.maxHops ?? 0);
  const retries = Math.max(0, opts.retries ?? 3);
  const backoffMs = Math.max(1, opts.backoffMs ?? 250);
  const onDegraded = opts.onDegraded ?? "throw";

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
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

  /** Exponential backoff. The public node rate-limits in bursts, so a retry that comes
   *  straight back is worse than no retry at all. */
  async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt === retries) break;
        const wait = backoffMs * 2 ** attempt;
        log.warn(`[htlc-balance] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${wait}ms:`, (e as Error).message);
        await sleep(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  const account = (address: string) =>
    withRetry(`getAccountByAddress ${address}`, () =>
      rpc<HtlcAccount | null>("getAccountByAddress", [spaceAddress(address)]),
    );

  const history = (address: string) =>
    withRetry(`getTransactionsByAddress ${address}`, () =>
      rpc<HistoryTx[] | null>("getTransactionsByAddress", [spaceAddress(address), maxHistory]),
    );

  // Whether the node has a history index is a property of the NODE, so it is settled once
  // per instance rather than once per address. It is also settled LAZILY: a history read
  // that succeeds has already proved the answer, and a dedicated probe would cost another
  // ~13.3s on every happy path. So the probe only runs to explain a read that FAILED —
  // telling "this node cannot do it at all" apart from "the node hiccuped", which is the
  // difference between a config error and a retry.
  let provenHistory = false;
  let historyProbe: Promise<boolean> | null = null;

  /** The burn address: well-formed, exists on every network, owned by nobody. */
  const PROBE_ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

  function historySupported(): Promise<boolean> {
    if (provenHistory) return Promise.resolve(true);
    if (!historyProbe) {
      historyProbe = (async () => {
        try {
          // A history node answers with an array (here, an empty one). A validator or
          // other non-history node errors out instead.
          const res = await rpc<HistoryTx[] | null>("getTransactionsByAddress", [
            spaceAddress(PROBE_ADDRESS),
            1,
          ]);
          if (Array.isArray(res)) {
            provenHistory = true;
            return true;
          }
          return false;
        } catch (e) {
          log.error(
            "[htlc-balance] this node cannot answer getTransactionsByAddress, so it has no " +
              "history index. HTLC-locked NIM will be INVISIBLE and every balance read here " +
              "under-reports:",
            (e as Error).message,
          );
          return false;
        }
      })();
    }
    return historyProbe;
  }

  /** The ownership gate, in one place: an HTLC counts only when WE funded it. */
  function classify(acct: HtlcAccount | null, ownerCompact: string, at: number):
    | { kind: "live" | "reclaimable"; luna: number }
    | null {
    if (!acct || acct.type !== "htlc") return null;
    if (compactAddress(acct.sender) !== ownerCompact) return null; // being the RECIPIENT of an
    // unexpired HTLC is not money we hold yet — only funds we put in are ours to count.
    const luna = typeof acct.balance === "number" ? acct.balance : 0;
    if (luna <= 0) return null;
    // `timeout` is milliseconds. A blockheight-shaped number here would compare as long
    // expired against a ms clock, which is the safe direction: it lands in `reclaimable`,
    // outside `totalLuna`, rather than inflating the number we render.
    const live = typeof acct.timeout === "number" && acct.timeout > at;
    return { kind: live ? "live" : "reclaimable", luna };
  }

  /** HTLC counterparties named by one address's history, compact form. */
  function contractsFrom(txs: HistoryTx[], selfCompact: string): string[] {
    const out = new Set<string>();
    for (const tx of txs) {
      if (tx.toType === ACCOUNT_TYPE_HTLC) {
        const to = compactAddress(tx.to);
        if (to && to !== selfCompact) out.add(to);
      }
      if (tx.fromType === ACCOUNT_TYPE_HTLC) {
        const from = compactAddress(tx.from);
        if (from && from !== selfCompact) out.add(from);
      }
    }
    return [...out];
  }

  async function readOne(address: string): Promise<AddressBalance> {
    const ownerCompact = compactAddress(address);
    const base: AddressBalance = {
      address,
      basicLuna: 0,
      htlcLuna: 0,
      htlcCount: 0,
      totalLuna: 0,
      reclaimableLuna: 0,
      reclaimableCount: 0,
      complete: true,
    };

    try {
      const acct = await account(address);
      base.basicLuna = typeof acct?.balance === "number" ? acct.balance : 0;
      base.totalLuna = base.basicLuna;
    } catch {
      // Without the basic balance there is no number at all, not merely an incomplete one.
      return { ...base, complete: false, incompleteReason: "rpc_failed" };
    }

    const at = now();
    const seen = new Set<string>([ownerCompact]);
    let frontier: string[];
    try {
      frontier = contractsFrom((await history(address)) ?? [], ownerCompact);
      provenHistory = true; // it answered, so the node has the index
    } catch {
      // Now, and only now, is it worth asking WHY: a node that cannot do this at all is a
      // config error the caller must fix, not a hiccup worth retrying.
      const reason: IncompleteReason = (await historySupported()) ? "rpc_failed" : "no_history_index";
      return { ...base, complete: false, incompleteReason: reason };
    }

    let queried = 0;
    let capped = false;
    let failed = false;

    for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
      const next: string[] = [];
      for (const contract of frontier) {
        if (seen.has(contract)) continue;
        seen.add(contract);
        if (queried >= maxContracts) {
          capped = true;
          break;
        }
        queried++;
        let acct: HtlcAccount | null;
        try {
          acct = await account(contract);
        } catch {
          // One unreadable contract is not a reason to discard the rest, but it does mean
          // the total is a floor rather than a fact.
          failed = true;
          continue;
        }
        const hit = classify(acct, ownerCompact, at);
        if (hit?.kind === "live") {
          base.htlcLuna += hit.luna;
          base.htlcCount++;
        } else if (hit?.kind === "reclaimable") {
          base.reclaimableLuna += hit.luna;
          base.reclaimableCount++;
        }
        if (hop < maxHops && acct?.type === "htlc") {
          try {
            next.push(...contractsFrom((await history(contract)) ?? [], contract));
          } catch {
            failed = true;
          }
        }
      }
      if (capped) break;
      frontier = next;
    }

    base.totalLuna = base.basicLuna + base.htlcLuna;
    if (failed || capped) {
      return { ...base, complete: false, incompleteReason: failed ? "rpc_failed" : "contract_capped" };
    }
    return base;
  }

  return {
    historySupported,

    async read(address) {
      const r = await readOne(address);
      if (!r.complete && onDegraded === "throw") {
        throw new DegradedError(r.incompleteReason ?? "rpc_failed", address);
      }
      return r;
    },

    async readMany(addresses) {
      const balances: AddressBalance[] = [];
      // Sequential: a history read is ~13.3s and parallel ones rate-limit the node.
      for (const a of addresses) balances.push(await readOne(a));
      const unreadable = balances.filter((b) => !b.complete).map((b) => b.address);
      if (unreadable.length) {
        log.error(
          `[htlc-balance] ${unreadable.length}/${balances.length} address(es) could not be ` +
            `fully read; the total under-reports by an unknown amount:`,
          unreadable.join(", "),
        );
      }
      return {
        balances,
        totalLuna: balances.reduce((s, b) => s + b.totalLuna, 0),
        unreadable,
        unreadableCount: unreadable.length,
        historySupported: await historySupported(),
      };
    },
  };
}
