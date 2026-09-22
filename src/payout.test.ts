import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CADENCE,
  TreasuryKeyError,
  TreasuryNetworkError,
  assertSolvent,
  assertTreasuryConfig,
  createInMemoryLedger,
  createPayoutGuard,
  mayRetry,
  nextCooldownMs,
  preflight,
  type LedgerLike,
} from "./payout";

const ADDR = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const HASH = "a".repeat(64);

describe("retry cadence", () => {
  test("wake and cooldown are two DIFFERENT numbers", () => {
    // Conflating them re-signs every failed payout on every tick, forever.
    expect(DEFAULT_CADENCE.wakeMs).toBe(15_000);
    expect(DEFAULT_CADENCE.cooldownMs).toBe(180_000);
    expect(DEFAULT_CADENCE.cooldownMs).not.toBe(DEFAULT_CADENCE.wakeMs);
    expect(DEFAULT_CADENCE.cooldownMs).toBeGreaterThan(DEFAULT_CADENCE.wakeMs);
  });

  test("backs off exponentially and caps", () => {
    expect(nextCooldownMs(0)).toBe(180_000);
    expect(nextCooldownMs(1)).toBe(360_000);
    expect(nextCooldownMs(2)).toBe(720_000);
    expect(nextCooldownMs(3)).toBe(900_000); // capped
    expect(nextCooldownMs(99)).toBe(900_000);
  });

  test("a first attempt is always allowed", () => {
    expect(mayRetry(null, 0, 0)).toBe(true);
  });

  test("a waking loop does NOT re-attempt the same item", () => {
    // The loop wakes at 15s. The item is not due for 180s.
    expect(mayRetry(0, 0, 15_000)).toBe(false);
    expect(mayRetry(0, 0, 179_999)).toBe(false);
    expect(mayRetry(0, 0, 180_000)).toBe(true);
  });

  test("a bad attempt number throws rather than silently backing off wrong", () => {
    expect(() => nextCooldownMs(-1)).toThrow();
    expect(() => nextCooldownMs(1.5)).toThrow();
  });
});

describe("preflight", () => {
  test("refuses a genuinely underfunded treasury", () => {
    expect(preflight({ totalLuna: 100, balanceLuna: 99 })).toEqual({ ok: false, reason: "underfunded" });
  });

  test("passes when the balance covers it", () => {
    expect(preflight({ totalLuna: 100, balanceLuna: 100 })).toEqual({ ok: true, reason: "sufficient" });
  });

  test("an UNREADABLE balance lets it through, and that is the asymmetry", () => {
    // Elsewhere in this package an unreadable node means unknown, never
    // proceed. Here blocking would stop every payout in the fleet on a blip,
    // while proceeding risks a tx the node rejects: a fee, not a loss.
    expect(preflight({ totalLuna: 100, balanceLuna: null })).toEqual({
      ok: true,
      reason: "balance-unreadable",
    });
  });

  test("the cap is checked before the balance", () => {
    expect(preflight({ totalLuna: 5000, balanceLuna: 1e9, maxPayoutLuna: 1000 })).toEqual({
      ok: false,
      reason: "over-cap",
    });
  });

  test("a nonsense amount is refused, never sent", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(preflight({ totalLuna: bad, balanceLuna: 1e9 }).ok).toBe(false);
    }
  });
});

describe("assertTreasuryConfig", () => {
  test("a matching key and network passes", () => {
    expect(() =>
      assertTreasuryConfig({
        derivedAddress: ADDR,
        configuredAddress: ADDR.replace(/\s/g, ""),
        nodeNetwork: "MainAlbatross",
        configuredNetwork: "mainalbatross",
      }),
    ).not.toThrow();
  });

  test("a key mismatch throws a KEY error, which never fixes itself", () => {
    expect(() =>
      assertTreasuryConfig({
        derivedAddress: ADDR,
        configuredAddress: "NQ99 1111 1111 1111 1111 1111 1111 1111 1111",
        nodeNetwork: "MainAlbatross",
        configuredNetwork: "MainAlbatross",
      }),
    ).toThrow(TreasuryKeyError);
  });

  test("a wrong network throws a distinct NETWORK error the caller retries", () => {
    try {
      assertTreasuryConfig({
        derivedAddress: ADDR,
        configuredAddress: ADDR,
        nodeNetwork: "TestAlbatross",
        configuredNetwork: "MainAlbatross",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TreasuryNetworkError);
      expect(e).not.toBeInstanceOf(TreasuryKeyError);
    }
  });

  test("an unreadable network is a NETWORK error, not a pass", () => {
    expect(() =>
      assertTreasuryConfig({
        derivedAddress: ADDR,
        configuredAddress: ADDR,
        nodeNetwork: null,
        configuredNetwork: "MainAlbatross",
      }),
    ).toThrow(TreasuryNetworkError);
  });
});

describe("assertSolvent", () => {
  test("paying out more than came in fails", () => {
    expect(assertSolvent({ principalOutLuna: 1000, confirmedInLuna: 900, depositCount: 3 })).toEqual({
      ok: false,
      overspendLuna: 97,
    });
  });

  test("one luna per confirmed deposit of rounding slack", () => {
    expect(assertSolvent({ principalOutLuna: 903, confirmedInLuna: 900, depositCount: 3 }).ok).toBe(true);
    expect(assertSolvent({ principalOutLuna: 904, confirmedInLuna: 900, depositCount: 3 }).ok).toBe(false);
  });

  test("zero deposits means zero slack", () => {
    expect(assertSolvent({ principalOutLuna: 1, confirmedInLuna: 0, depositCount: 0 }).ok).toBe(false);
  });

  test("reports the margin when solvent", () => {
    expect(assertSolvent({ principalOutLuna: 800, confirmedInLuna: 900, depositCount: 0 })).toEqual({
      ok: true,
      marginLuna: 100,
    });
  });
});

describe("createPayoutGuard", () => {
  test("sends once and records the hash", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    let sends = 0;
    const r = await g.once("r1", async () => {
      sends++;
      return HASH;
    });
    expect(r).toEqual({ state: "sent", txHash: HASH });
    expect(sends).toBe(1);
    expect((await ledger.get("r1"))?.status).toBe("sent");
  });

  test("a second call for the same key never sends again", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    let sends = 0;
    const send = async () => {
      sends++;
      return HASH;
    };
    await g.once("r1", send);
    const again = await g.once("r1", send);
    expect(again).toEqual({ state: "already", txHash: HASH });
    expect(sends).toBe(1);
  });

  test("CONCURRENT calls in the same tick produce exactly one send", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    let sends = 0;
    const send = async () => {
      sends++;
      await new Promise((r) => setTimeout(r, 5));
      return HASH;
    };
    // The dispatch, the retry loop and an admin force-retry, all at once.
    const out = await Promise.all([g.once("r1", send), g.once("r1", send), g.once("r1", send)]);
    expect(sends).toBe(1);
    expect(out.filter((o) => o.state === "sent").length).toBe(1);
    expect(out.filter((o) => o.state === "in-flight" || o.state === "already").length).toBe(2);
  });

  test("the in-flight lock holds when the store AWAITS, as a database does", async () => {
    // The in-memory ledger claims synchronously, which hides this: the first
    // caller's claim lands before the second even asks. A real store does I/O,
    // so all three callers are inside claim() at once and only the in-flight
    // lock stands between them and three signed transactions.
    const rows = new Set<string>();
    const slowLedger: LedgerLike = {
      claim: async (key) => {
        await new Promise((r) => setTimeout(r, 10)); // the round-trip
        if (rows.has(key)) return false;
        rows.add(key);
        return true;
      },
      release: async (key) => void rows.delete(key),
      complete: async () => {},
      get: async () => null,
    };
    const g = createPayoutGuard({ ledger: slowLedger });
    let sends = 0;
    const send = async () => {
      sends++;
      return HASH;
    };
    const out = await Promise.all([g.once("r1", send), g.once("r1", send), g.once("r1", send)]);
    expect(sends).toBe(1);
    expect(out.filter((o) => o.state === "in-flight").length).toBe(2);
  });

  test("a FAILED send releases the key so it can be retried", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    const r1 = await g.once("r1", async () => {
      throw new Error("node refused");
    });
    expect(r1.state).toBe("failed");
    expect(await ledger.get("r1")).toBe(null);

    const r2 = await g.once("r1", async () => HASH);
    expect(r2).toEqual({ state: "sent", txHash: HASH });
  });

  test("a send that cannot say what it sent is a failure, not a success", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    const r = await g.once("r1", async () => "");
    expect(r.state).toBe("failed");
    // Released, because the outcome is unknown rather than spent.
    expect(await ledger.get("r1")).toBe(null);
  });

  test("a refused pre-flight never claims the key and never sends", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    let sends = 0;
    const r = await g.once(
      "r1",
      async () => {
        sends++;
        return HASH;
      },
      { preflight: { totalLuna: 100, balanceLuna: 1 } },
    );
    expect(r).toEqual({ state: "refused", reason: "underfunded" });
    expect(sends).toBe(0);
    expect(await ledger.get("r1")).toBe(null);
  });

  test("an unreadable balance does NOT block the payout", async () => {
    const ledger = createInMemoryLedger();
    const g = createPayoutGuard({ ledger });
    const r = await g.once("r1", async () => HASH, {
      preflight: { totalLuna: 100, balanceLuna: null },
    });
    expect(r.state).toBe("sent");
  });

  test("a store whose claim loses the race is believed, not overridden", async () => {
    // Stands in for a UNIQUE-constraint violation on a real database.
    const ledger: LedgerLike = {
      claim: async () => false,
      release: async () => {},
      complete: async () => {},
      get: async () => ({ key: "r1", status: "sent", txHash: HASH, updatedAt: 0 }),
    };
    const g = createPayoutGuard({ ledger });
    let sends = 0;
    const r = await g.once("r1", async () => {
      sends++;
      return HASH;
    });
    expect(r).toEqual({ state: "already", txHash: HASH });
    expect(sends).toBe(0);
  });

  test("an empty key is refused rather than treated as a valid one", async () => {
    const g = createPayoutGuard({ ledger: createInMemoryLedger() });
    let sends = 0;
    const r = await g.once("", async () => {
      sends++;
      return HASH;
    });
    expect(r.state).toBe("refused");
    expect(sends).toBe(0);
  });

  test("the in-flight set empties even when the send throws", async () => {
    const g = createPayoutGuard({ ledger: createInMemoryLedger() });
    await g.once("r1", async () => {
      throw new Error("boom");
    });
    expect(g.inFlight()).toEqual([]);
  });
});

describe("the reference ledger is honest about not being durable", () => {
  test("it says so in the type", () => {
    expect(createInMemoryLedger().durable).toBe(false);
  });
});
