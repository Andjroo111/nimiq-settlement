import { describe, expect, test } from "bun:test";
import {
  GUARD_PREFIX,
  NotHydratedError,
  createReplayGuard,
  createSendGuard,
  guardKey,
  matchPending,
  type ConsumedRecord,
  type ConsumedStore,
  type GuardStorage,
  type SendIntent,
} from "./resume";

const H = "A".repeat(64);
const h = "a".repeat(64);
const MERCHANT = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

function store(seed: ConsumedRecord[] = [], opts: { failOn?: string } = {}): ConsumedStore & { rows: ConsumedRecord[] } {
  const rows = [...seed];
  return {
    rows,
    async all() {
      return [...rows];
    },
    async record(rec) {
      if (opts.failOn === rec.txHash) throw new Error("UNIQUE constraint failed");
      if (rows.some((r) => r.txHash === rec.txHash || r.orderId === rec.orderId)) {
        throw new Error("UNIQUE constraint failed");
      }
      rows.push(rec);
    },
  };
}

/** No unique constraint, so the in-memory guard is the only thing being tested. */
function laxStore(seed: ConsumedRecord[] = []): ConsumedStore & { rows: ConsumedRecord[] } {
  const rows = [...seed];
  return { rows, async all() { return [...rows]; }, async record(rec) { rows.push(rec); } };
}

describe("replay guard", () => {
  test("refuses to answer before hydrate, rather than answering from an empty set", () => {
    const g = createReplayGuard(store());
    expect(g.ready()).toBe(false);
    expect(() => g.isConsumed(h, "o1")).toThrow(NotHydratedError);
    expect(g.consume(h, "o1")).rejects.toThrow(NotHydratedError);
  });

  test("a restart does NOT reopen the window", async () => {
    const s = store();
    const first = createReplayGuard(s);
    await first.hydrate();
    expect(await first.consume(h, "o1")).toBe(true);

    // Process dies. New guard, same store.
    const second = createReplayGuard(s);
    await second.hydrate();
    expect(second.isConsumed(h, "o1")).toBe(true);
    expect(await second.consume(h, "o1")).toBe(false);
  });

  test("guards on the hash AND the order id, since either alone leaks one replay", async () => {
    // Deliberately a store with no constraints: if the store rejected the
    // duplicate, it would mask whichever half of this check was missing.
    const g = createReplayGuard(laxStore());
    await g.hydrate();
    await g.consume(h, "o1");
    // Same payment, different order: only the HASH set catches this.
    expect(await g.consume(h, "o2")).toBe(false);
    // Different payment, same order: only the ORDER set catches this.
    expect(await g.consume("b".repeat(64), "o1")).toBe(false);
  });

  test("hash matching is case-insensitive in BOTH directions", async () => {
    const g = createReplayGuard(laxStore());
    await g.hydrate();
    await g.consume(H, "o1"); // stored upper, normalised to lower
    expect(g.isConsumed(h, "other")).toBe(true); // asked lower
    expect(g.isConsumed(H, "other")).toBe(true); // asked UPPER
    expect(await g.consume(H, "o2")).toBe(false);
  });

  test("a store constraint violation means ALREADY, never fresh", async () => {
    const g = createReplayGuard(store([], { failOn: h }));
    await g.hydrate();
    expect(await g.consume(h, "o1")).toBe(false);
    // And it is remembered locally, so it stays refused.
    expect(g.isConsumed(h, "o1")).toBe(true);
  });

  test("hydrate loads what the store already had", async () => {
    const g = createReplayGuard(store([{ txHash: h, orderId: "o1", at: 0 }]));
    await g.hydrate();
    expect(g.isConsumed(h, "nope")).toBe(true);
    expect(g.isConsumed("c".repeat(64), "o1")).toBe(true);
  });
});

function mem(): GuardStorage & { map: Map<string, string>; fail?: boolean } {
  const map = new Map<string, string>();
  const s = {
    map,
    fail: false,
    getItem: (k: string) => {
      if (s.fail) throw new Error("blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (s.fail) throw new Error("blocked");
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (s.fail) throw new Error("blocked");
      map.delete(k);
    },
  };
  return s;
}

const INTENT: SendIntent = { network: "main", intent: "ticket", recipient: MERCHANT, amountLuna: 5000 };

describe("send guard", () => {
  test("keys on network, intent, recipient and amount, ignoring address spacing", () => {
    const a = guardKey(INTENT);
    const b = guardKey({ ...INTENT, recipient: MERCHANT.replace(/\s/g, "").toLowerCase() });
    expect(a).toBe(b);
    expect(a.startsWith(GUARD_PREFIX)).toBe(true);
    expect(guardKey({ ...INTENT, amountLuna: 5001 })).not.toBe(a);
  });

  test("a guard written before the wallet call is found on the next open", () => {
    const storage = mem();
    const g = createSendGuard({ storage });
    g.begin(INTENT);
    expect(g.pending(INTENT)?.amountLuna).toBe(5000);
  });

  test("expires, so a guard from last week does not block a real payment", () => {
    let t = 0;
    const g = createSendGuard({ storage: mem(), ttlMs: 1000, now: () => t });
    g.begin(INTENT);
    t = 1001;
    expect(g.pending(INTENT)).toBe(null);
  });

  test("records an unusable handle, because that is exactly when reconcile is needed", () => {
    const g = createSendGuard({ storage: mem() });
    g.begin(INTENT);
    g.note(INTENT, "some-opaque-thing");
    expect(g.pending(INTENT)?.handle).toBe("some-opaque-thing");
  });

  test("clear removes it", () => {
    const g = createSendGuard({ storage: mem() });
    g.begin(INTENT);
    g.clear(INTENT);
    expect(g.pending(INTENT)).toBe(null);
  });

  test("throwing storage never throws out of the guard", () => {
    const storage = mem();
    storage.fail = true;
    const g = createSendGuard({ storage });
    expect(() => g.begin(INTENT)).not.toThrow();
    expect(() => g.note(INTENT, "x")).not.toThrow();
    expect(() => g.clear(INTENT)).not.toThrow();
    expect(g.pending(INTENT)).toBe(null);
  });

  test("corrupt stored JSON is treated as no guard, not a crash", () => {
    const storage = mem();
    storage.map.set(guardKey(INTENT), "{not json");
    const g = createSendGuard({ storage });
    expect(g.pending(INTENT)).toBe(null);
  });
});

describe("matchPending", () => {
  const tx = (over: Partial<{ hash: string; recipient: string; value: number; recipientData: string }> = {}) => ({
    hash: h,
    recipient: MERCHANT,
    value: 5000,
    recipientData: null,
    ...over,
  });

  test("finds the payment that already went through", () => {
    expect(matchPending(INTENT, [tx()])).toEqual({ state: "found", txHash: h });
  });

  test("a wrong amount is not a match, so the user is not told they paid", () => {
    expect(matchPending(INTENT, [tx({ value: 4999 })])).toEqual({ state: "clear" });
  });

  test("a wrong recipient is not a match", () => {
    expect(matchPending(INTENT, [tx({ recipient: "NQ99 1111 1111 1111 1111 1111 1111 1111 1111" })])).toEqual({
      state: "clear",
    });
  });

  test("the memo must match when one is expected", () => {
    const withMemo = { ...INTENT, memoHex: "beef" };
    expect(matchPending(withMemo, [tx({ recipientData: "dead" })])).toEqual({ state: "clear" });
    expect(matchPending(withMemo, [tx({ recipientData: "BEEF" })])).toEqual({ state: "found", txHash: h });
  });

  test("the SENDER is not checked, because Pay pays from an HTLC", () => {
    // No sender field is even read. A sender test would reject real payments.
    expect(matchPending(INTENT, [tx()])).toEqual({ state: "found", txHash: h });
  });

  test("an empty history is clear, not found", () => {
    expect(matchPending(INTENT, [])).toEqual({ state: "clear" });
  });
});
