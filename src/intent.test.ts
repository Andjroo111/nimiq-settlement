import { describe, expect, test } from "bun:test";
import {
  createInMemoryNonceStore,
  createIntentGuard,
  type NonceStore,
  type SignedAction,
} from "./intent";

const ADDR = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const OTHER = "NQ99 1111 1111 1111 1111 1111 1111 1111 1111";

/** Stands in for E3's verifier: signature "good" means the key is the signer. */
const verify = (_m: string, sig: string, pk: string) => (sig === "good" ? pk : null);

function guardWith(store: NonceStore = createInMemoryNonceStore(), now = () => 1000) {
  return { store, guard: createIntentGuard({ store, verify, now }) };
}

const action = (over: Partial<SignedAction> = {}): SignedAction => ({
  message: "payout:n1",
  signature: "good",
  publicKey: ADDR,
  nonce: "n1",
  action: "payout",
  ...over,
});

describe("issue", () => {
  test("binds a nonce to one action and one address", async () => {
    const { store, guard } = guardWith();
    const rec = await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect(rec.usedAt).toBe(null);
    expect((await store.get("n1"))?.action).toBe("payout");
    expect((await store.get("n1"))?.expiresAt).toBe(61_000);
  });
});

describe("authorise", () => {
  test("a correctly signed, correctly scoped call is authorised once", async () => {
    const { guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    const r = await guard.authorise(action());
    expect(r.ok).toBe(true);
  });

  test("THE POINT: a nonce cannot be spent twice", async () => {
    const { guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect((await guard.authorise(action())).ok).toBe(true);
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "nonce-used" });
  });

  test("CONCURRENT calls with one nonce authorise exactly one", async () => {
    // A store that does real I/O, so every caller is past the read before any
    // of them writes. Only the conditional write separates them.
    const rows = new Map<string, { usedAt: number | null }>();
    const slow: NonceStore = {
      async issue(rec) {
        rows.set(rec.nonce, { usedAt: null });
      },
      async get(nonce) {
        await new Promise((r) => setTimeout(r, 5));
        const r = rows.get(nonce);
        return r
          ? { nonce, action: "payout", address: ADDR, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, usedAt: r.usedAt }
          : null;
      },
      async consume(nonce, atMs) {
        const r = rows.get(nonce);
        if (!r || r.usedAt !== null) return false;
        r.usedAt = atMs;
        return true;
      },
    };
    const guard = createIntentGuard({ store: slow, verify });
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    const out = await Promise.all([
      guard.authorise(action()),
      guard.authorise(action()),
      guard.authorise(action()),
    ]);
    expect(out.filter((o) => o.ok).length).toBe(1);
    expect(out.filter((o) => !o.ok).length).toBe(2);
  });

  test("a signature valid for ANOTHER action is refused", async () => {
    // The attack: harvest a signature from a read-only endpoint, replay it at
    // a payout. A server that only asks "did they sign this" lets it through.
    const { guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "read-profile", address: ADDR, ttlMs: 60_000 });
    expect(await guard.authorise(action({ action: "payout" }))).toEqual({
      ok: false,
      reason: "wrong-action",
    });
  });

  test("a valid signature from the WRONG address is refused", async () => {
    const { guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect(await guard.authorise(action({ publicKey: OTHER }))).toEqual({
      ok: false,
      reason: "wrong-address",
    });
  });

  test("address comparison ignores spacing and case", async () => {
    const { guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    const r = await guard.authorise(action({ publicKey: ADDR.replace(/\s/g, "").toLowerCase() }));
    expect(r.ok).toBe(true);
  });

  test("a bad signature is refused and does NOT spend the nonce", async () => {
    const { store, guard } = guardWith();
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect(await guard.authorise(action({ signature: "bad" }))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    // Still spendable by the legitimate holder.
    expect((await store.get("n1"))?.usedAt).toBe(null);
    expect((await guard.authorise(action())).ok).toBe(true);
  });

  test("a THROWING verifier is a refusal, never a pass", async () => {
    const store = createInMemoryNonceStore();
    const guard = createIntentGuard({
      store,
      verify: () => {
        throw new Error("wasm exploded");
      },
      now: () => 1000,
    });
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "bad-signature" });
  });

  test("an expired nonce is refused", async () => {
    const store = createInMemoryNonceStore();
    let t = 1000;
    const guard = createIntentGuard({ store, verify, now: () => t });
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    t = 61_001;
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "nonce-expired" });
  });

  test("an ALREADY-USED nonce is refused without consulting the verifier", async () => {
    // The early usedAt check is what stops a spent nonce burning verification
    // work; without it the refusal is the same but the verifier still runs.
    let asked = 0;
    const store = createInMemoryNonceStore();
    const guard = createIntentGuard({
      store,
      verify: (...a) => {
        asked++;
        return verify(...a);
      },
      now: () => 1000,
    });
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    await guard.authorise(action());
    expect(asked).toBe(1);
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "nonce-used" });
    expect(asked).toBe(1); // not asked again
  });

  test("an unknown nonce is refused without consulting the verifier", async () => {
    let asked = 0;
    const guard = createIntentGuard({
      store: createInMemoryNonceStore(),
      verify: (...a) => {
        asked++;
        return verify(...a);
      },
      now: () => 1000,
    });
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "unknown-nonce" });
    expect(asked).toBe(0);
  });

  test("a store that loses the consume race is believed", async () => {
    const base = createInMemoryNonceStore();
    const racy: NonceStore = { ...base, consume: async () => false };
    const guard = createIntentGuard({ store: racy, verify, now: () => 1000 });
    await guard.issue({ nonce: "n1", action: "payout", address: ADDR, ttlMs: 60_000 });
    expect(await guard.authorise(action())).toEqual({ ok: false, reason: "nonce-used" });
  });
});

describe("the reference store", () => {
  test("it is honest about not being durable", () => {
    expect(createInMemoryNonceStore().durable).toBe(false);
  });

  test("consume is CONDITIONAL: only the first call transitions the row", async () => {
    // Tested directly, because the guard's own usedAt pre-check would otherwise
    // mask a store that spends unconditionally.
    const store = createInMemoryNonceStore();
    await store.issue({ nonce: "n1", action: "a", address: ADDR, issuedAt: 0, expiresAt: 1e15, usedAt: null });
    expect(await store.consume("n1", 5)).toBe(true);
    expect(await store.consume("n1", 6)).toBe(false);
    expect((await store.get("n1"))?.usedAt).toBe(5); // not overwritten by the loser
  });

  test("consume refuses an unknown nonce rather than creating one", async () => {
    const store = createInMemoryNonceStore();
    expect(await store.consume("never-issued", 1)).toBe(false);
    expect(await store.get("never-issued")).toBe(null);
  });
});
