// The RPC transport: which node, is it the right chain, may we call it, and
// what does a failure mean.
//
// `rpc.nimiqwatch.com` is a single point of failure the fleet hardcodes in
// twenty places. This module owns the ordered endpoint chain instead, so the
// shell and every app import one list rather than a literal each.
//
// Four things it refuses to do:
//   - talk to a node without proving which chain it serves. A mainnet config
//     pointed at a testnet RPC passes every other guard silently.
//   - spend a rate budget it has not reserved. The public limit is a fixed
//     window, not a leaky bucket: 20 requests per 10 seconds, no refill inside
//     the window, so a burst that looks fine locally gets the whole app 429'd.
//   - retry a user's refusal. "cancelled" is a decision, not a transient error.
//   - report a balance of 0 for an address it could not read.

/** Ordered fallback chains. First entry is tried first. */
export const RPC_ENDPOINTS = {
  main: ["https://rpc.nimiqwatch.com", "https://rpc.mainnet.nimiq.network"],
  test: ["https://rpc.testnet.nimiqwatch.com"],
} as const;

/**
 * Genesis block HEIGHT per network. Not 0: the PoS chain starts where it took
 * over from PoW, and a proof that reads "block 0" reads the wrong block.
 */
export const GENESIS_BLOCK = { main: 3_456_000, test: 3_032_010 } as const;

export type NetworkName = keyof typeof RPC_ENDPOINTS;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ── addresses ────────────────────────────────────────────────────────────────

/** Albatross RPC wants the SPACED user-friendly form. Compact input is rewritten. */
export function toRpcAddress(v: string): string {
  const compact = v.replace(/\s+/g, "").toUpperCase();
  if (!/^NQ[0-9A-Z]{34}$/.test(compact)) return v;
  return compact.replace(/(.{4})(?=.)/g, "$1 ");
}

/** Rewrite every NQ-looking string anywhere in a params array or object. */
export function normaliseParams(params: unknown): unknown {
  if (typeof params === "string") return toRpcAddress(params);
  if (Array.isArray(params)) return params.map(normaliseParams);
  if (params && typeof params === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) out[k] = normaliseParams(v);
    return out;
  }
  return params;
}

// ── error classification ─────────────────────────────────────────────────────

export type ErrorClass =
  /** Transient. The same call may succeed shortly. */
  | "retry"
  /** The user said no. NEVER retried, never reconciled as a failure to fix. */
  | "cancelled"
  /** A hard rejection. Retrying cannot help. */
  | "terminal";

const SYNC_RE = /\bsync(ing|hroni[sz]ing)?\b|not established|consensus/i;
const CANCEL_RE = /\b(reject(ed)?|denied|cancel(l?ed)?|abort(ed)? by user|user closed)\b/i;
const RATE_RE = /\b(429|rate.?limit|too many requests)\b/i;
const NET_RE = /\b(timeout|timed out|econnreset|etimedout|socket hang up|network|fetch failed)\b/i;

/**
 * What a failure means.
 *
 * Order matters and is not arbitrary: cancellation is checked BEFORE the
 * transient patterns, because a message can contain both ("request cancelled
 * while syncing") and treating a refusal as retryable re-prompts a user who
 * already said no.
 */
export function classifyRpcError(err: unknown): ErrorClass {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown })?.message === "string"
          ? String((err as { message: string }).message)
          : "";
  if (CANCEL_RE.test(msg)) return "cancelled";
  if (RATE_RE.test(msg) || NET_RE.test(msg) || SYNC_RE.test(msg)) return "retry";
  return "terminal";
}

/**
 * The C1-442 wire protocol: a transient failure carries a literal `PENDING:`
 * prefix so a client keeps polling instead of showing a failure to a user whose
 * money already left.
 *
 * OPT-IN PER CALLER, and there is no global switch: `emit` is a required
 * parameter so each call site states its intent.
 *
 * As of 2026-09-22 the fleet CAN read it. All 15 shell-dependent apps pin
 * v0.30.0 and all 8 that vendor a browser bundle serve one rebuilt from it, so
 * `classifySendResult` and the prefix are reachable in every served client.
 * Before that they were not, and passing `true` would have made settlement
 * reporting worse: a client that does not know the convention reads `PENDING:`
 * as an unrecognised error, which is the hard-failure path this protocol
 * exists to prevent.
 *
 * ⚠️ Still check the specific app before passing `true`. An app pinned to an
 * older shell, or serving a stale cached bundle, is back in that state.
 */
export const PENDING_PREFIX = "PENDING:";

export function pendingMessage(reason: string, emit: boolean): string {
  return emit ? `${PENDING_PREFIX} ${reason}` : reason;
}

// ── rate budget ──────────────────────────────────────────────────────────────

/**
 * The public limit is a FIXED WINDOW: measured 20 requests per 10 seconds with
 * no refill inside the window, and `Reset` is the unix second the next window
 * opens. One budget is shared by every caller through one transport, because
 * the limit is per IP and counting it per caller overspends it.
 */
export interface RateBudget {
  /** Claim a slot. False means do not send. */
  reserve(): boolean;
  /** Learn from a response's headers. */
  observe(headers: { get(name: string): string | null }): void;
  /** Mark the window spent, e.g. on a 429. */
  exhaust(resetAtMs?: number): void;
  /** Introspection for tests and diagnostics. */
  state(): { remaining: number | null; resetAtMs: number | null };
}

export interface RateBudgetOptions {
  /** Assumed slots when the server has not told us. Default 20. */
  defaultLimit?: number;
  /** Window length used only when a reset time is unknown. Default 10_000. */
  windowMs?: number;
  now?: () => number;
}

export function createRateBudget(opts: RateBudgetOptions = {}): RateBudget {
  const { defaultLimit = 20, windowMs = 10_000, now = Date.now } = opts;
  let remaining: number | null = null;
  let resetAtMs: number | null = null;

  const rollIfExpired = () => {
    if (resetAtMs !== null && now() >= resetAtMs) {
      remaining = null;
      resetAtMs = null;
    }
  };

  return {
    reserve() {
      rollIfExpired();
      // Unknown budget sends: refusing on no information would deadlock a node
      // that never sets the headers.
      if (remaining === null) {
        remaining = defaultLimit - 1;
        if (resetAtMs === null) resetAtMs = now() + windowMs;
        return true;
      }
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
    observe(headers) {
      const rem = Number(headers.get("X-RateLimit-Remaining"));
      const reset = Number(headers.get("X-RateLimit-Reset"));
      // The LOWER number wins inside a window: another caller on this IP may
      // have spent slots we never saw.
      if (Number.isFinite(rem) && rem >= 0) {
        remaining = remaining === null ? rem : Math.min(remaining, rem);
      }
      if (Number.isFinite(reset) && reset > 0) resetAtMs = reset * 1000;
    },
    exhaust(at) {
      remaining = 0;
      resetAtMs = at ?? now() + windowMs;
    },
    state: () => {
      rollIfExpired();
      return { remaining, resetAtMs };
    },
  };
}

// ── transport ────────────────────────────────────────────────────────────────

export type NetworkProof =
  | { state: "unproven" }
  | { state: "proven"; genesisHash: string }
  | { state: "rejected"; reason: string };

export interface RpcTransportOptions {
  /** Ordered endpoints. Defaults to RPC_ENDPOINTS[network]. */
  urls?: readonly string[];
  network: NetworkName;
  /**
   * Genesis block hash this transport will accept. Without it the network is
   * never proven, and `requireProof` decides whether that blocks calls.
   */
  expectedGenesisHash?: string;
  /** Refuse every call until the network is proven. Default false. */
  requireProof?: boolean;
  /** Methods the transport will send. Omit to allow all. */
  allowlist?: readonly string[];
  /** Per-endpoint abort. Default 10_000. */
  timeoutMs?: number;
  budget?: RateBudget;
  fetchImpl?: FetchLike;
  logger?: { warn: (...a: unknown[]) => void };
}

export interface RpcTransport {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Fetch the genesis block once and compare. Cached; a rejection LATCHES. */
  proveNetwork(): Promise<NetworkProof>;
  proof(): NetworkProof;
  budget(): RateBudget;
  /** The endpoint that answered last, for diagnostics. */
  lastUrl(): string | null;
}

export class RpcRefusedError extends Error {
  constructor(public readonly reason: "budget" | "allowlist" | "network") {
    super(`rpc refused: ${reason}`);
    this.name = "RpcRefusedError";
  }
}

/** Unwrap `{result:{data}}` / `{result}`; surface `error.data` over `error.message`. */
function readBody(json: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!json || typeof json !== "object") return { ok: false, message: "empty response" };
  const o = json as Record<string, unknown>;
  if (o.error) {
    const e = o.error as Record<string, unknown>;
    // `data` carries the real cause; `message` is often a useless "Internal error".
    const msg = (typeof e.data === "string" && e.data) || (typeof e.message === "string" && e.message) || JSON.stringify(e);
    return { ok: false, message: String(msg) };
  }
  const r = o.result;
  if (r && typeof r === "object" && "data" in (r as Record<string, unknown>)) {
    return { ok: true, value: (r as Record<string, unknown>).data };
  }
  return { ok: true, value: r ?? null };
}

export function createRpcTransport(opts: RpcTransportOptions): RpcTransport {
  const {
    network,
    urls = RPC_ENDPOINTS[network],
    expectedGenesisHash,
    requireProof = false,
    allowlist,
    timeoutMs = 10_000,
    budget = createRateBudget(),
    fetchImpl = fetch,
    logger,
  } = opts;

  if (urls.length === 0) throw new Error("createRpcTransport: no endpoints");

  let proof: NetworkProof = { state: "unproven" };
  let proving: Promise<NetworkProof> | null = null;
  let lastUrl: string | null = null;

  const once = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
    if (!budget.reserve()) throw new RpcRefusedError("budget");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params: normaliseParams(params), id: 1 }),
        signal: ctrl.signal,
      });
      budget.observe(res.headers);
      if (res.status === 429) {
        budget.exhaust();
        throw new Error(`${method}: 429 rate limited`);
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = readBody(await res.json());
      if (!body.ok) throw new Error(`${method}: ${body.message}`);
      lastUrl = url;
      return body.value;
    } finally {
      clearTimeout(timer);
    }
  };

  const call = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    if (allowlist && !allowlist.includes(method)) throw new RpcRefusedError("allowlist");
    if (proof.state === "rejected") throw new RpcRefusedError("network");
    if (requireProof && proof.state !== "proven") {
      const p = await proveNetwork();
      if (p.state !== "proven") throw new RpcRefusedError("network");
    }

    let last: unknown = null;
    for (const url of urls) {
      try {
        return (await once(url, method, params)) as T;
      } catch (e) {
        last = e;
        // A refusal is ours, not the endpoint's: trying the next one repeats it.
        if (e instanceof RpcRefusedError) throw e;
        if (classifyRpcError(e) === "cancelled") throw e;
        logger?.warn(`[rpc] ${url} failed for ${method}`, e);
      }
    }
    throw last instanceof Error ? last : new Error(`${method}: all endpoints failed`);
  };

  const proveNetwork = async (): Promise<NetworkProof> => {
    if (proof.state !== "unproven") return proof;
    if (proving) return proving;
    proving = (async () => {
      if (!expectedGenesisHash) {
        proof = { state: "unproven" };
        return proof;
      }
      const height = GENESIS_BLOCK[network];
      try {
        const block = (await call<{ hash?: string } | null>("getBlockByNumber", [height, false])) ?? null;
        const hash = typeof block?.hash === "string" ? block.hash.toLowerCase() : null;
        if (!hash) {
          // Could not read it. NOT a rejection: an unreadable node is unknown,
          // and latching on unknown would take the fleet down on a blip.
          proof = { state: "unproven" };
        } else if (hash !== expectedGenesisHash.toLowerCase()) {
          // Wrong chain. This LATCHES: no retry, no second opinion.
          proof = {
            state: "rejected",
            reason: `genesis ${hash} is not ${expectedGenesisHash.toLowerCase()} (expected ${network})`,
          };
          logger?.warn(`[rpc] ${proof.reason}`);
        } else {
          proof = { state: "proven", genesisHash: hash };
        }
      } catch (e) {
        logger?.warn("[rpc] network proof failed", e);
        proof = { state: "unproven" };
      }
      return proof;
    })();
    try {
      return await proving;
    } finally {
      proving = null;
    }
  };

  return {
    call,
    proveNetwork,
    proof: () => proof,
    budget: () => budget,
    lastUrl: () => lastUrl,
  };
}
