// Surviving a restart, and a user who closed the app mid-payment.
//
// Two windows, both of which have been exploited by accident rather than
// malice:
//
//   1. A consumed-set held only in memory forgets every spent tx hash on
//      restart, so the same payment can be redeemed twice. The set is seeded
//      from the store at boot, and guards on tx hash AND order id, because
//      either alone lets one of the two replays through.
//   2. A wallet call that neither resolved nor clearly failed leaves money
//      possibly sent. Offering "try again" there is how a user pays twice.
//      A guard is written BEFORE the wallet call so the next open can find it.

export interface ConsumedRecord {
  txHash: string;
  orderId: string;
  at: number;
}

/**
 * Durable store for spent payments. `record` must be atomic enough that a
 * unique-constraint violation is possible: that violation IS the second-claim
 * signal, and swallowing it as "already recorded" is correct.
 */
export interface ConsumedStore {
  /** Everything already spent. Read once at boot. */
  all(): Promise<ConsumedRecord[]>;
  /** Persist. Throwing on a duplicate is expected and handled. */
  record(rec: ConsumedRecord): Promise<void>;
}

export interface ReplayGuard {
  /** Seed from the store. Call before serving traffic. */
  hydrate(): Promise<void>;
  /** True once hydrate() has completed. */
  ready(): boolean;
  /** Has either the hash or the order id been spent? */
  isConsumed(txHash: string, orderId: string): boolean;
  /** Spend it. False means it was already spent. */
  consume(txHash: string, orderId: string): Promise<boolean>;
}

export class NotHydratedError extends Error {
  constructor() {
    super("replay guard used before hydrate(): an empty set is not proof of nothing spent");
    this.name = "NotHydratedError";
  }
}

export function createReplayGuard(
  store: ConsumedStore,
  now: () => number = Date.now,
): ReplayGuard {
  const hashes = new Set<string>();
  const orders = new Set<string>();
  let hydrated = false;

  return {
    async hydrate() {
      for (const r of await store.all()) {
        hashes.add(r.txHash.toLowerCase());
        orders.add(r.orderId);
      }
      hydrated = true;
    },
    ready: () => hydrated,
    isConsumed(txHash, orderId) {
      // Refusing to answer beats answering "not spent" from an empty set that
      // was never loaded. That is the restart replay window, exactly.
      if (!hydrated) throw new NotHydratedError();
      return hashes.has(txHash.toLowerCase()) || orders.has(orderId);
    },
    async consume(txHash, orderId) {
      if (!hydrated) throw new NotHydratedError();
      const h = txHash.toLowerCase();
      if (hashes.has(h) || orders.has(orderId)) return false;
      try {
        await store.record({ txHash: h, orderId, at: now() });
      } catch {
        // A constraint violation means another process got there first. Mark it
        // locally and report "already", never "fresh".
        hashes.add(h);
        orders.add(orderId);
        return false;
      }
      hashes.add(h);
      orders.add(orderId);
      return true;
    },
  };
}

// ── send guard ───────────────────────────────────────────────────────────────

export interface SendIntent {
  network: string;
  intent: string;
  recipient: string;
  amountLuna: number;
  /** Hex memo, when the payment carries one. */
  memoHex?: string;
}

export interface PendingSend extends SendIntent {
  startedAt: number;
  /** Set once the wallet returns something, even something unusable. */
  handle?: string;
}

/** Per-viewer storage. Every read and write must tolerate throwing. */
export interface GuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const GUARD_PREFIX = "nimiq-settlement:send-guard:v1:";

export function guardKey(i: SendIntent): string {
  return `${GUARD_PREFIX}${i.network}:${i.intent}:${i.recipient.replace(/\s+/g, "").toUpperCase()}:${i.amountLuna}`;
}

export interface SendGuardOptions {
  storage: GuardStorage;
  /** How long a guard stays live. Default 10 minutes. */
  ttlMs?: number;
  now?: () => number;
}

export interface SendGuard {
  /** Write the guard BEFORE calling the wallet. */
  begin(i: SendIntent): void;
  /** The live guard for this intent, or null. Expired guards are cleared. */
  pending(i: SendIntent): PendingSend | null;
  /** Record whatever the wallet returned, however unusable. */
  note(i: SendIntent, handle: string): void;
  /** Clear it. Only for a resolved outcome, success or a clean cancellation. */
  clear(i: SendIntent): void;
}

export function createSendGuard(opts: SendGuardOptions): SendGuard {
  const { storage, ttlMs = 600_000, now = Date.now } = opts;

  const read = (key: string): PendingSend | null => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return null;
      const p = JSON.parse(raw) as PendingSend;
      return typeof p?.startedAt === "number" ? p : null;
    } catch {
      // A private window, blocked site data, or corrupt JSON. No guard.
      return null;
    }
  };

  const write = (key: string, p: PendingSend): void => {
    try {
      storage.setItem(key, JSON.stringify(p));
    } catch {
      // Storage refused. The caller still sends; it just cannot reconcile
      // later, which is the pre-existing behaviour, not a new failure.
    }
  };

  const drop = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  };

  return {
    begin(i) {
      write(guardKey(i), { ...i, startedAt: now() });
    },
    pending(i) {
      const key = guardKey(i);
      const p = read(key);
      if (!p) return null;
      if (now() - p.startedAt > ttlMs) {
        drop(key);
        return null;
      }
      return p;
    },
    note(i, handle) {
      const key = guardKey(i);
      const p = read(key) ?? { ...i, startedAt: now() };
      write(key, { ...p, handle });
    },
    clear(i) {
      drop(guardKey(i));
    },
  };
}

// ── reconcile ────────────────────────────────────────────────────────────────

export type ReconcileVerdict =
  /** A matching payment is already on chain. Do NOT send again. */
  | { state: "found"; txHash: string }
  /** Nothing matching. Safe to offer another attempt. */
  | { state: "clear" }
  /** Could not tell. Refuse to offer another attempt; recover by hash. */
  | { state: "unknown" };

export interface ReconcileTx {
  hash: string;
  recipient: string | null;
  value: number | null;
  recipientData: string | null;
}

/**
 * After an ambiguous wallet outcome, look for the payment before letting the
 * user pay again.
 *
 * The match is recipient, exact amount and memo. The SENDER is not checked:
 * Nimiq Pay pays from an HTLC it controls, so a sender test rejects the very
 * payments this is trying to find.
 */
export function matchPending(pending: SendIntent, txs: readonly ReconcileTx[]): ReconcileVerdict {
  const want = pending.recipient.replace(/\s+/g, "").toUpperCase();
  for (const tx of txs) {
    if (!tx.hash) continue;
    if ((tx.recipient ?? "").replace(/\s+/g, "").toUpperCase() !== want) continue;
    if (tx.value !== pending.amountLuna) continue;
    if (
      pending.memoHex !== undefined &&
      (tx.recipientData ?? "").toLowerCase() !== pending.memoHex.toLowerCase()
    ) {
      continue;
    }
    return { state: "found", txHash: tx.hash };
  }
  return { state: "clear" };
}
