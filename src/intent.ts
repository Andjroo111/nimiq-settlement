// Signed intents: a nonce that can be spent once, and a signature scoped to
// one action.
//
// This is session state in a database, not settlement and not crypto. The
// signature VERIFIER is injected, because verifying is E3's lane; what lives
// here is the part a verifier cannot do:
//
//   - a nonce is single-use, enforced by a conditional write, not by reading
//     then writing. A read-then-write nonce is two callers both seeing unused.
//   - a signature is scoped to ONE action. A signature harvested from a
//     read-only endpoint must not authorise a payout, which is what happens
//     when a server verifies "is this signed by them" and stops there.

export interface NonceRecord {
  nonce: string;
  /** What this nonce was issued for. A mismatch is a refusal, not a warning. */
  action: string;
  /** Who it was issued to, as a user-friendly address. */
  address: string;
  issuedAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/**
 * The nonce store seam.
 *
 * `consume` MUST be a conditional write: the SQL shape is
 * `UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL`, and the
 * affected-row count is the answer. Returning a row you read and then updating
 * it is the bug this interface exists to prevent.
 */
export interface NonceStore {
  issue(rec: NonceRecord): Promise<void>;
  get(nonce: string): Promise<NonceRecord | null>;
  /** True only if THIS call transitioned it from unused to used. */
  consume(nonce: string, atMs: number): Promise<boolean>;
}

/** Reference store. Single process, not durable, and it says so. */
export function createInMemoryNonceStore(): NonceStore & { durable: false } {
  const rows = new Map<string, NonceRecord>();
  return {
    durable: false,
    async issue(rec) {
      rows.set(rec.nonce, { ...rec });
    },
    async get(nonce) {
      const r = rows.get(nonce);
      return r ? { ...r } : null;
    },
    async consume(nonce, atMs) {
      const r = rows.get(nonce);
      // The conditional part: only an unused row transitions.
      if (!r || r.usedAt !== null) return false;
      rows.set(nonce, { ...r, usedAt: atMs });
      return true;
    },
  };
}

export type IntentRefusal =
  | "unknown-nonce"
  | "nonce-used"
  | "nonce-expired"
  | "wrong-action"
  | "wrong-address"
  | "bad-signature";

export type IntentVerdict =
  | { ok: true; record: NonceRecord }
  | { ok: false; reason: IntentRefusal };

/**
 * The signature verifier, injected. Returns the signing address, or null when
 * the signature does not verify. Never throws as a signal.
 */
export interface SignatureVerifier {
  (message: string, signature: string, publicKey: string): string | null;
}

export interface SignedAction {
  /** The exact message that was signed. E3 owns its grammar. */
  message: string;
  signature: string;
  publicKey: string;
  nonce: string;
  /** The action the caller claims this authorises. */
  action: string;
}

export interface IntentGuardOptions {
  store: NonceStore;
  verify: SignatureVerifier;
  now?: () => number;
}

export interface IntentGuard {
  /** Mint a nonce bound to one action and one address. */
  issue(input: { nonce: string; action: string; address: string; ttlMs: number }): Promise<NonceRecord>;
  /**
   * Authorise one mutating call. On success the nonce is spent and can never
   * authorise anything again, including a retry of this same call.
   */
  authorise(a: SignedAction): Promise<IntentVerdict>;
}

const sameAddr = (a: string, b: string) =>
  a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();

export function createIntentGuard(opts: IntentGuardOptions): IntentGuard {
  const { store, verify, now = Date.now } = opts;

  return {
    async issue({ nonce, action, address, ttlMs }) {
      const at = now();
      const rec: NonceRecord = {
        nonce,
        action,
        address,
        issuedAt: at,
        expiresAt: at + ttlMs,
        usedAt: null,
      };
      await store.issue(rec);
      return rec;
    },

    async authorise(a) {
      const rec = await store.get(a.nonce);
      if (!rec) return { ok: false, reason: "unknown-nonce" };
      if (rec.usedAt !== null) return { ok: false, reason: "nonce-used" };
      if (now() > rec.expiresAt) return { ok: false, reason: "nonce-expired" };

      // Scope BEFORE signature: a valid signature for the wrong action is the
      // attack this check exists for, and checking it first also avoids
      // spending verification work on a request that cannot be authorised.
      if (rec.action !== a.action) return { ok: false, reason: "wrong-action" };

      let signer: string | null = null;
      try {
        signer = verify(a.message, a.signature, a.publicKey);
      } catch {
        // A verifier that throws is treated as a refusal, never as a pass.
        signer = null;
      }
      if (!signer) return { ok: false, reason: "bad-signature" };
      if (!sameAddr(signer, rec.address)) return { ok: false, reason: "wrong-address" };

      // The conditional write is LAST and is the only thing that spends it.
      // Losing this race means another caller got there first, which is a
      // refusal even though every check above passed.
      const spent = await store.consume(a.nonce, now());
      if (!spent) return { ok: false, reason: "nonce-used" };

      return { ok: true, record: { ...rec, usedAt: now() } };
    },
  };
}
