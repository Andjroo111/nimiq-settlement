// Finding a transaction on chain, and saying honestly when it cannot be found.
//
// Three things go wrong in the gap between a wallet returning and a tx being
// visible, and each one has produced a real double-send in the field:
//
//   1. The SDK does not always return a hash. It may return the serialized
//      transaction, or something opaque. Guessing which is what caused the
//      double-sends, so `resolveHandle` refuses rather than guesses.
//   2. `getTransactionByHash` returns not-found for a tx that is real and still
//      propagating. Reading that as "it never happened" makes the caller re-send.
//      The mempool is the second place to look.
//   3. Public RPCs return null for a tx that IS confirmed. The third place is
//      the expected address's own history, and only an EXACT hash match that
//      also passes recipient and value checks is accepted there.
//
// And the outcome that is neither success nor failure: a tx can be INCLUDED and
// have failed (`executionResult === false`). A height comparison cannot see it.

/** Where a transaction stands, as far as the chain will say right now. */
export type LookupState =
  /** Nothing anywhere. Not proof it does not exist. */
  | "notSeen"
  /** Seen in the mempool, not in a block yet. */
  | "mempool"
  /** In a block and it executed. */
  | "ok"
  /** In a block and it did NOT go through. Nothing moved. */
  | "failed"
  /** The handle could not be turned into a hash. Never look, never guess. */
  | "unresolvable";

export interface ChainTx {
  hash: string;
  blockNumber: number | null;
  sender: string | null;
  recipient: string | null;
  /** Luna. */
  value: number | null;
  /** Hex, as the node returns it. */
  recipientData: string | null;
  executionResult: boolean | null;
}

export interface LookupResult {
  state: LookupState;
  hash: string | null;
  tx: ChainTx | null;
  /** Which of the three places answered. */
  via: "hash" | "mempool" | "addressHistory" | null;
}

/**
 * The WASM-free tx-hash deriver, injected rather than imported.
 *
 * This package does not depend on it: a caller that never sees a serialized
 * handle needs no deriver at all, and a caller that does supplies one.
 *
 * The contract that matters: `transactionHash` returns a 64-lowercase-hex
 * string or null, NEVER a partial answer and never a throw-as-signal. A null is
 * information ("I could not parse this"), not an error to swallow.
 *
 * ⚠️ A deriver must fork its content layout on network id. Albatross ids carry
 * a sender-data field that legacy ids omit, so the same serialized bytes hash
 * differently. Getting it wrong does not throw: it yields a valid-looking hash
 * that is never found on chain, which reads on this lane as "not settled" for
 * something that settled.
 */
export interface TxHashDeriver {
  transactionHash(input: string): string | null;
  /** Cheap shape filter. True never implies the bytes parse. */
  looksLikeSerializedTransaction?(input: string): boolean;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^(0x)?[0-9a-fA-F]*$/;

export type Handle =
  | { kind: "hash"; hash: string }
  | { kind: "serialized"; hash: string }
  | { kind: "unresolvable"; reason: "opaque" | "no-deriver" | "underivable" };

/**
 * Turn whatever the wallet returned into a hash, or refuse.
 *
 * Never invents a hash. An input this cannot resolve comes back
 * `unresolvable`, and the caller reconciles by address scan or reports the
 * outcome unknown. Reporting unknown is correct; guessing is not.
 */
export function resolveHandle(raw: unknown, deriver?: TxHashDeriver): Handle {
  if (typeof raw !== "string") return { kind: "unresolvable", reason: "opaque" };
  const s = raw.trim();
  if (s === "") return { kind: "unresolvable", reason: "opaque" };

  const lower = s.toLowerCase();
  if (HASH_RE.test(lower)) return { kind: "hash", hash: lower };

  const body = lower.startsWith("0x") ? lower.slice(2) : lower;
  const looksHex = HEX_RE.test(s) && body.length % 2 === 0 && body.length > 64;
  if (!looksHex) return { kind: "unresolvable", reason: "opaque" };

  if (!deriver) return { kind: "unresolvable", reason: "no-deriver" };
  if (deriver.looksLikeSerializedTransaction && !deriver.looksLikeSerializedTransaction(s)) {
    return { kind: "unresolvable", reason: "opaque" };
  }

  const hash = deriver.transactionHash(s);
  // A deriver saying null outranks its own shape filter saying true.
  if (typeof hash !== "string" || !HASH_RE.test(hash)) {
    return { kind: "unresolvable", reason: "underivable" };
  }
  return { kind: "serialized", hash };
}

/** Unwrap `{result:{data}}`, `{result}`, or a flat body. One level, never deeper. */
export function unwrapRpcResult<T = unknown>(body: unknown): T | null {
  if (body === null || typeof body !== "object") return (body ?? null) as T | null;
  const o = body as Record<string, unknown>;
  if ("data" in o) return (o.data ?? null) as T | null;
  return o as T;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Map a node's transaction JSON onto ChainTx, across the shapes nodes use. */
export function normalizeTx(raw: unknown): ChainTx | null {
  const t = unwrapRpcResult<Record<string, unknown>>(raw);
  if (!t || typeof t !== "object") return null;
  const hash = str(t.hash) ?? str(t.transactionHash);
  if (!hash) return null;
  return {
    hash: hash.toLowerCase(),
    blockNumber: num(t.blockNumber) ?? num(t.block_height) ?? num(t.blockHeight),
    sender: str(t.from) ?? str(t.sender),
    recipient: str(t.to) ?? str(t.recipient),
    value: num(t.value),
    recipientData: str(t.recipientData) ?? str(t.data),
    executionResult: typeof t.executionResult === "boolean" ? t.executionResult : null,
  };
}

/** What a recovered tx must match before it is believed. */
export interface Expectation {
  /** Required. Address history is only searched when we know whose. */
  recipient: string;
  /** Exact Luna, when known. */
  valueLuna?: number;
  /** Hex memo the tx must carry, when known. */
  recipientDataHex?: string;
}

export interface LookupRpc {
  getTransactionByHash(hash: string): Promise<unknown>;
  getTransactionFromMempool?(hash: string): Promise<unknown>;
  getTransactionsByAddress?(address: string, max: number): Promise<unknown>;
}

export interface LookupOptions {
  rpc: LookupRpc;
  deriver?: TxHashDeriver;
  /** How many history entries to scan on recovery. Default 25. */
  historyMax?: number;
  logger?: { warn: (...a: unknown[]) => void };
}

export interface Lookup {
  /** Resolve a wallet return value into a hash, or refuse. */
  resolve(raw: unknown): Handle;
  /** Find a tx by hash: mined, then mempool, then address history. */
  find(hash: string, expect?: Expectation): Promise<LookupResult>;
  /** resolve() then find(). `unresolvable` never touches the node. */
  findByHandle(raw: unknown, expect?: Expectation): Promise<LookupResult>;
}

const norm = (a: string | null | undefined): string =>
  (a ?? "").replace(/\s+/g, "").toUpperCase();

const NOT_SEEN: LookupResult = { state: "notSeen", hash: null, tx: null, via: null };

/** A tx in a block is `ok` or `failed`; without a block it is still in flight. */
function stateOfMined(tx: ChainTx): LookupState {
  if (tx.executionResult === false) return "failed";
  return tx.blockNumber === null ? "mempool" : "ok";
}

export function createLookup(opts: LookupOptions): Lookup {
  const { rpc, deriver, historyMax = 25, logger } = opts;

  const byHash = async (hash: string): Promise<ChainTx | null> => {
    try {
      return normalizeTx(await rpc.getTransactionByHash(hash));
    } catch (e) {
      logger?.warn(`getTransactionByHash(${hash}) failed`, e);
      return null;
    }
  };

  const inMempool = async (hash: string): Promise<ChainTx | null> => {
    if (!rpc.getTransactionFromMempool) return null;
    try {
      return normalizeTx(await rpc.getTransactionFromMempool(hash));
    } catch (e) {
      logger?.warn(`getTransactionFromMempool(${hash}) failed`, e);
      return null;
    }
  };

  /**
   * C2-293: a public RPC can answer null for a tx that is confirmed. Scan the
   * expected recipient's history and accept ONLY an exact hash match that also
   * passes the recipient, value and memo checks we were given.
   *
   * The sender is deliberately not checked. Nimiq Pay pays from an HTLC it
   * controls, so a sender equality test rejects real payments.
   */
  const fromHistory = async (hash: string, expect: Expectation): Promise<ChainTx | null> => {
    if (!rpc.getTransactionsByAddress) return null;
    let list: unknown;
    try {
      list = unwrapRpcResult(await rpc.getTransactionsByAddress(expect.recipient, historyMax));
    } catch (e) {
      logger?.warn(`getTransactionsByAddress(${expect.recipient}) failed`, e);
      return null;
    }
    if (!Array.isArray(list)) return null;

    for (const entry of list) {
      const tx = normalizeTx(entry);
      if (!tx || tx.hash !== hash) continue;
      if (norm(tx.recipient) !== norm(expect.recipient)) continue;
      if (expect.valueLuna !== undefined && tx.value !== expect.valueLuna) continue;
      if (
        expect.recipientDataHex !== undefined &&
        (tx.recipientData ?? "").toLowerCase() !== expect.recipientDataHex.toLowerCase()
      ) {
        continue;
      }
      return tx;
    }
    return null;
  };

  const find = async (hash: string, expect?: Expectation): Promise<LookupResult> => {
    if (!HASH_RE.test(hash)) return { ...NOT_SEEN, state: "unresolvable" };

    const mined = await byHash(hash);
    if (mined) return { state: stateOfMined(mined), hash, tx: mined, via: "hash" };

    const pooled = await inMempool(hash);
    if (pooled) {
      // A mempool answer carrying a failure is still a failure.
      const state = pooled.executionResult === false ? "failed" : "mempool";
      return { state, hash, tx: pooled, via: "mempool" };
    }

    if (expect) {
      const recovered = await fromHistory(hash, expect);
      if (recovered) {
        return { state: stateOfMined(recovered), hash, tx: recovered, via: "addressHistory" };
      }
    }

    // Not found in three places. That is not proof it does not exist, and the
    // caller must not re-send on it.
    return { ...NOT_SEEN, hash };
  };

  return {
    resolve: (raw) => resolveHandle(raw, deriver),
    find,
    findByHandle: async (raw, expect) => {
      const h = resolveHandle(raw, deriver);
      if (h.kind === "unresolvable") return { ...NOT_SEEN, state: "unresolvable" };
      return find(h.hash, expect);
    },
  };
}
