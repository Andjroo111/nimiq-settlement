// Paying out, exactly once.
//
// Every failure here spends real money twice, so the module is built out of
// refusals rather than retries. Four independent guards, each of which has
// caught a real incident in the field:
//
//   1. An idempotency claim taken BEFORE the chain call, not after. A second
//      caller gets a store error instead of a second send.
//   2. An in-flight lock, because a claim in a database does not stop the
//      dispatch, the retry loop and an admin force-retry from each signing
//      their own transaction inside the same tick.
//   3. A treasury pre-flight, because a node accepts a send the treasury
//      cannot fund and still returns a hash. The tx is dropped at inclusion
//      while the caller has already zeroed the user's balance.
//   4. An aggregate invariant, because a bug anywhere upstream in attribution
//      is invisible to all three of the above.
//
// ⚠️ ONE ASYMMETRY, and it is deliberate. Everywhere else in this package an
// unreadable node means "unknown", never "proceed". Here an unreadable
// treasury BALANCE lets the payout through. The two failure modes are not
// symmetric: proceeding on an unreadable balance risks a tx the node rejects,
// which costs a fee and moves nothing, while blocking on it stops every payout
// in the fleet on a node blip. Refusal is reserved for a balance we can read
// and that genuinely falls short.

/** Luna. */
export type Luna = number;

export interface PayoutRecord {
  key: string;
  status: "claimed" | "sent" | "failed";
  txHash?: string;
  amountLuna?: Luna;
  recipient?: string;
  updatedAt: number;
}

/**
 * The store seam.
 *
 * `claim` must be ATOMIC against concurrent callers: a single INSERT into a
 * UNIQUE column, or a conditional UPDATE that matches only the prior state. A
 * read-then-write is not an implementation of this interface, it is the bug
 * this interface exists to prevent.
 */
export interface LedgerLike {
  /** True if this caller now owns the key. False means someone else does. */
  claim(key: string, meta?: Partial<PayoutRecord>): Promise<boolean>;
  /** Give the key back so it can be retried. Called when the chain call FAILED. */
  release(key: string): Promise<void>;
  /** Record the send. After this the key is spent for good. */
  complete(key: string, txHash: string): Promise<void>;
  get(key: string): Promise<PayoutRecord | null>;
}

/**
 * Reference implementation. Correct for a single process and NOT durable: a
 * restart forgets every claim and reopens the window this module exists to
 * close. Use it in tests and in dev. In production supply a store whose
 * `claim` is a real atomic write.
 */
export function createInMemoryLedger(now: () => number = Date.now): LedgerLike & { durable: false } {
  const rows = new Map<string, PayoutRecord>();
  return {
    durable: false,
    async claim(key, meta) {
      if (rows.has(key)) return false;
      rows.set(key, { key, status: "claimed", updatedAt: now(), ...meta });
      return true;
    },
    async release(key) {
      rows.delete(key);
    },
    async complete(key, txHash) {
      const row = rows.get(key);
      rows.set(key, { ...row, key, status: "sent", txHash, updatedAt: now() });
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };
}

// ── retry cadence ────────────────────────────────────────────────────────────

/**
 * Two numbers, and conflating them is a documented incident.
 *
 * `wakeMs` is how often the loop looks for work: cheap, a store scan.
 * `cooldownMs` is the minimum gap between two attempts on the SAME item.
 *
 * Wiring the cooldown to the wake interval means every failed payout is
 * re-signed and re-broadcast on every tick, forever. That produced both the
 * RPC rate limiting and "transaction already in mempool" on top of it.
 */
export interface RetryCadence {
  wakeMs: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_CADENCE: RetryCadence = {
  wakeMs: 15_000,
  cooldownMs: 180_000,
  maxCooldownMs: 900_000,
};

/** Exponential backoff on the per-item cooldown, capped. */
export function nextCooldownMs(attempt: number, c: RetryCadence = DEFAULT_CADENCE): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new TypeError(`bad attempt ${attempt}`);
  const grown = c.cooldownMs * 2 ** attempt;
  return Math.min(grown, c.maxCooldownMs);
}

/** True when enough time has passed since the last attempt on this item. */
export function mayRetry(
  lastAttemptAtMs: number | null,
  attempt: number,
  nowMs: number,
  c: RetryCadence = DEFAULT_CADENCE,
): boolean {
  if (lastAttemptAtMs === null) return true;
  return nowMs - lastAttemptAtMs >= nextCooldownMs(attempt, c);
}

// ── treasury pre-flight ──────────────────────────────────────────────────────

export type PreflightVerdict =
  | { ok: true; reason: "sufficient" | "balance-unreadable" }
  | { ok: false; reason: "underfunded" | "over-cap" | "bad-amount" };

export interface PreflightInput {
  /** Total to send. */
  totalLuna: Luna;
  /** Treasury balance, or null when it could not be read. */
  balanceLuna: Luna | null;
  /** Hard ceiling on a single payout run. */
  maxPayoutLuna?: Luna;
}

/**
 * A node accepts a send the treasury cannot fund and still returns a hash; the
 * tx is only dropped at inclusion, by which time the caller has reported
 * success and zeroed a user's balance. So read the balance first.
 */
export function preflight(input: PreflightInput): PreflightVerdict {
  const { totalLuna, balanceLuna, maxPayoutLuna } = input;
  if (!Number.isFinite(totalLuna) || totalLuna <= 0) return { ok: false, reason: "bad-amount" };
  if (maxPayoutLuna !== undefined && totalLuna > maxPayoutLuna) return { ok: false, reason: "over-cap" };
  // See the asymmetry note at the top of this file.
  if (balanceLuna === null) return { ok: true, reason: "balance-unreadable" };
  if (balanceLuna < totalLuna) return { ok: false, reason: "underfunded" };
  return { ok: true, reason: "sufficient" };
}

// ── boot refusal ─────────────────────────────────────────────────────────────

export class TreasuryKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreasuryKeyError";
  }
}

export class TreasuryNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreasuryNetworkError";
  }
}

export interface TreasuryConfig {
  /** The address the configured private key actually derives. */
  derivedAddress: string;
  /** The address the config SAYS the treasury is. */
  configuredAddress: string;
  /** The network the node reports, or null when it could not be read. */
  nodeNetwork: string | null;
  /** The network the config says. */
  configuredNetwork: string;
}

const sameAddr = (a: string, b: string) =>
  a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();

/**
 * Refuse to start a process that can spend, unless the key really is the
 * treasury and the node really is the right chain.
 *
 * The two failures are NOT the same and must not be handled the same way:
 * a key mismatch is a config error that will never fix itself, so it throws
 * immediately. A node that cannot be read is transient, so it throws a
 * distinct error the caller retries with backoff, keeping a health page up
 * that can say why nothing is paying.
 */
export function assertTreasuryConfig(cfg: TreasuryConfig): void {
  if (!sameAddr(cfg.derivedAddress, cfg.configuredAddress)) {
    throw new TreasuryKeyError(
      `treasury key derives ${cfg.derivedAddress}, config says ${cfg.configuredAddress}`,
    );
  }
  if (cfg.nodeNetwork === null) {
    throw new TreasuryNetworkError("node did not report its network");
  }
  if (cfg.nodeNetwork.toLowerCase() !== cfg.configuredNetwork.toLowerCase()) {
    throw new TreasuryNetworkError(
      `node serves ${cfg.nodeNetwork}, config says ${cfg.configuredNetwork}`,
    );
  }
}

// ── integrity backstop ───────────────────────────────────────────────────────

export interface SolvencyInput {
  /** Principal being paid out. Sponsor-funded bonuses are EXCLUDED. */
  principalOutLuna: Luna;
  /** Deposits actually confirmed on chain. */
  confirmedInLuna: Luna;
  /** Number of confirmed deposits, for the rounding allowance. */
  depositCount: number;
  /** Luna of slack per deposit. Default 1. */
  tolerancePerDeposit?: Luna;
}

export type SolvencyVerdict =
  | { ok: true; marginLuna: Luna }
  | { ok: false; overspendLuna: Luna };

/**
 * The cheap, independent invariant: total principal out never exceeds value
 * confirmed in. It survives a bug anywhere upstream in attribution, which is
 * exactly what the idempotency ledger and the in-flight lock cannot do, since
 * both trust the amount they are handed.
 */
export function assertSolvent(input: SolvencyInput): SolvencyVerdict {
  const { principalOutLuna, confirmedInLuna, depositCount, tolerancePerDeposit = 1 } = input;
  const allowance = Math.max(0, depositCount) * tolerancePerDeposit;
  const overspend = principalOutLuna - (confirmedInLuna + allowance);
  return overspend > 0 ? { ok: false, overspendLuna: overspend } : { ok: true, marginLuna: -overspend };
}

// ── the guard ────────────────────────────────────────────────────────────────

export type PayoutOutcome =
  | { state: "sent"; txHash: string }
  | { state: "already"; txHash?: string }
  | { state: "in-flight" }
  | { state: "refused"; reason: PreflightVerdict extends { ok: false } ? never : string }
  | { state: "failed"; error: unknown };

export interface PayoutGuardOptions {
  ledger: LedgerLike;
  logger?: { warn: (...a: unknown[]) => void };
}

export interface PayoutGuard {
  /**
   * Run `send` at most once for `key`, ever.
   *
   * Order is load-bearing: in-flight lock, then ledger claim, then the chain
   * call. The lock is taken first because it is synchronous and free; the
   * claim is the durable one and is what survives a restart.
   */
  once(
    key: string,
    send: () => Promise<string>,
    opts?: { preflight?: PreflightInput; meta?: Partial<PayoutRecord> },
  ): Promise<PayoutOutcome>;
  /** Keys currently mid-send in this process. */
  inFlight(): string[];
}

export function createPayoutGuard(opts: PayoutGuardOptions): PayoutGuard {
  const { ledger, logger } = opts;
  const inFlight = new Set<string>();

  return {
    inFlight: () => [...inFlight],

    async once(key, send, o = {}) {
      if (typeof key !== "string" || key === "") {
        return { state: "refused", reason: "empty key" } as PayoutOutcome;
      }

      // 1. Same tick, same process. The dispatch, the retry loop and an admin
      //    force-retry all land here before any of them reaches the store.
      //
      //    ⚠️ The claim is taken SYNCHRONOUSLY, before the first `await`. Adding
      //    it after awaiting the store is the bug this lock exists to prevent:
      //    a real store does I/O, so every caller would be inside claim() at
      //    once and sail past a check that is still looking at an empty set.
      if (inFlight.has(key)) return { state: "in-flight" };
      inFlight.add(key);

      try {
        // 2. Pre-flight BEFORE claiming, so a refusal leaves the key retryable
        //    without a release round-trip.
        if (o.preflight) {
          const v = preflight(o.preflight);
          if (!v.ok) return { state: "refused", reason: v.reason } as PayoutOutcome;
        }

        // 3. The durable claim. A concurrent caller gets false, not a second send.
        const mine = await ledger.claim(key, o.meta);
        if (!mine) {
          const row = await ledger.get(key);
          return { state: "already", txHash: row?.txHash };
        }

        const txHash = await send();
        if (typeof txHash !== "string" || txHash === "") {
          // A send that cannot say what it sent is not a success. Release so it
          // can be retried, rather than burning the key on an unknown outcome.
          await ledger.release(key);
          return { state: "failed", error: new Error("send returned no tx hash") };
        }
        await ledger.complete(key, txHash);
        return { state: "sent", txHash };
      } catch (e) {
        logger?.warn(`payout ${key} failed`, e);
        // Release so the key is retryable. This is the ONLY path that gives a
        // key back: a completed send never does.
        await ledger.release(key);
        return { state: "failed", error: e };
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
