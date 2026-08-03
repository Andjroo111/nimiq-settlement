// The failure this module exists to prevent is QUIET and DIRECTIONAL: a basic balance that
// reads low (sometimes zero) while the user's NIM sits in a Pay swap HTLC. So these tests
// pin the under-report from both sides — that a live HTLC is added back, and that a walk
// which could not finish is never allowed to pass itself off as a complete number.

import { expect, test } from "bun:test";
import {
  ACCOUNT_TYPE_HTLC,
  compactAddress,
  createHtlcAwareBalance,
  spaceAddress,
} from "./htlc-balance";

const OWNER = "NQ44 ABCD ABCD ABCD ABCD ABCD ABCD ABCD ABCD";
const HTLC_A = "NQ14 1111 1111 1111 1111 1111 1111 1111 1111";
const HTLC_B = "NQ14 2222 2222 2222 2222 2222 2222 2222 2222";
const OTHER = "NQ14 9999 9999 9999 9999 9999 9999 9999 9999";

const NOW = 1_786_000_000_000; // fixed ms clock; real HTLC timeouts are ms timestamps
const noSleep = async () => {};
const quiet = { warn: () => {}, error: () => {} };

type Accounts = Record<string, unknown>;
type Histories = Record<string, unknown>;

/** A fake Albatross node. Accounts and histories are keyed by COMPACT address, so a test
 *  cannot accidentally pass by matching the spacing the RPC actually requires. */
function fakeNode(accounts: Accounts, histories: Histories = {}, opts: { noHistory?: boolean } = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fails = new Map<string, number>(); // method::address -> remaining failures
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    const addr = compactAddress(String(params?.[0] ?? ""));
    const key = `${method}::${addr}`;
    const left = fails.get(key) ?? 0;
    if (left > 0) {
      fails.set(key, left - 1);
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { message: "boom" }, id: 1 }), { status: 200 });
    }
    if (method === "getTransactionsByAddress") {
      if (opts.noHistory) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { message: "no history index" }, id: 1 }),
          { status: 200 },
        );
      }
      return ok(histories[addr] ?? []);
    }
    if (method === "getAccountByAddress") return ok(accounts[addr] ?? null);
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { message: "?" }, id: 1 }), { status: 200 });
  };
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", result: { data }, id: 1 }), { status: 200 });
  return {
    fetchImpl,
    calls,
    /** Make the next `n` calls of `method` for `address` fail. */
    failNext: (method: string, address: string, n: number) => fails.set(`${method}::${compactAddress(address)}`, n),
  };
}

const make = (node: ReturnType<typeof fakeNode>, extra: Record<string, unknown> = {}) =>
  createHtlcAwareBalance({
    url: "http://fake",
    fetchImpl: node.fetchImpl,
    logger: quiet,
    now: () => NOW,
    sleep: noSleep,
    ...extra,
  });

const fundedHtlc = (to: string, from = OWNER) => ({ from, to, fromType: 0, toType: ACCOUNT_TYPE_HTLC });

// ---- address formatting: the RPC boundary is SPACED, comparison is COMPACT ----

test("addresses go out to the node SPACED, however they were passed in", async () => {
  const node = fakeNode({ [compactAddress(OWNER)]: { balance: 1_000 } });
  await make(node, { onDegraded: "report" }).read(compactAddress(OWNER)); // passed in unspaced
  const sent = String(node.calls[0]!.params[0]);
  expect(sent).toBe(OWNER);
  expect(sent).toMatch(/^NQ\d{2}( [0-9A-Z]{4}){8}$/);
});

test("spaceAddress and compactAddress round-trip", () => {
  expect(spaceAddress(compactAddress(OWNER))).toBe(OWNER);
  expect(compactAddress("nq44 abcd")).toBe("NQ44ABCD");
});

// ---- the core read ----

test("a live HTLC we funded is added back to the basic balance", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 0 }, // the under-report: reads BROKE
      [compactAddress(HTLC_A)]: {
        type: "htlc", balance: 44_209_318, sender: OWNER, recipient: OTHER,
        timeout: NOW + 60_000, totalAmount: 44_209_318,
      },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)] },
  );
  const r = await make(node).read(OWNER);
  expect(r.basicLuna).toBe(0);
  expect(r.htlcLuna).toBe(44_209_318);
  expect(r.htlcCount).toBe(1);
  expect(r.totalLuna).toBe(44_209_318);
  expect(r.complete).toBe(true);
});

test("the node's SPACED sender is matched against our address, not compared raw", async () => {
  // The contract reports `sender` spaced; the caller asked with an unspaced address.
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 500 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 7_000, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)] },
  );
  const r = await make(node).read(compactAddress(OWNER));
  expect(r.totalLuna).toBe(7_500);
});

test("an HTLC where we are the RECIPIENT is not money we hold yet", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 100 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 9_000_000, sender: OTHER, recipient: OWNER, timeout: NOW + 60_000 },
    },
    { [compactAddress(OWNER)]: [{ from: HTLC_A, to: OWNER, fromType: ACCOUNT_TYPE_HTLC, toType: 0 }] },
  );
  const r = await make(node).read(OWNER);
  expect(r.htlcLuna).toBe(0);
  expect(r.totalLuna).toBe(100);
});

test("`timeout` is read as MILLISECONDS: expired goes to reclaimable, never into the total", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 100 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 3_000, sender: OWNER, timeout: NOW - 1 },
      [compactAddress(HTLC_B)]: { type: "htlc", balance: 5_000, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A), fundedHtlc(HTLC_B)] },
  );
  const r = await make(node).read(OWNER);
  expect(r.htlcLuna).toBe(5_000);
  expect(r.totalLuna).toBe(5_100);
  expect(r.reclaimableLuna).toBe(3_000);
  expect(r.reclaimableCount).toBe(1);
  expect(r.complete).toBe(true); // reclaimable is reported, not a failure
});

// A block height where a ms timestamp belongs compares as long expired. That is the SAFE
// direction (it lands outside totalLuna); this pins that it never inflates the number.
test("a block-height-shaped timeout cannot inflate the rendered total", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 100 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 8_000, sender: OWNER, timeout: 3_500_000 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)] },
  );
  const r = await make(node).read(OWNER);
  expect(r.totalLuna).toBe(100);
  expect(r.reclaimableLuna).toBe(8_000);
});

test("a non-HTLC counterparty and a drained contract both count nothing", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 100 },
      [compactAddress(HTLC_A)]: { type: "basic", balance: 999_999, sender: OWNER, timeout: NOW + 60_000 },
      [compactAddress(HTLC_B)]: { type: "htlc", balance: 0, sender: OWNER, timeout: NOW + 60_000 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A), fundedHtlc(HTLC_B)] },
  );
  const r = await make(node).read(OWNER);
  expect(r.totalLuna).toBe(100);
  expect(r.htlcCount).toBe(0);
});

test("the same contract named twice in history is queried once", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 0 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 1_000, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A), fundedHtlc(HTLC_A), fundedHtlc(HTLC_A)] },
  );
  const r = await make(node).read(OWNER);
  expect(r.htlcLuna).toBe(1_000);
  expect(node.calls.filter((c) => c.method === "getAccountByAddress" && compactAddress(String(c.params[0])) === compactAddress(HTLC_A))).toHaveLength(1);
});

// ---- degrading LOUDLY ----

test("a node with no history index THROWS by default rather than return the basic balance", async () => {
  const node = fakeNode({ [compactAddress(OWNER)]: { balance: 0 } }, {}, { noHistory: true });
  await expect(make(node).read(OWNER)).rejects.toThrow(/no_history_index/);
});

test("onDegraded:'report' hands back the partial read, flagged and reasoned", async () => {
  const node = fakeNode({ [compactAddress(OWNER)]: { balance: 250 } }, {}, { noHistory: true });
  const r = await make(node, { onDegraded: "report" }).read(OWNER);
  expect(r.complete).toBe(false);
  expect(r.incompleteReason).toBe("no_history_index");
  expect(r.totalLuna).toBe(250); // the basic balance, explicitly marked as not the whole story
});

// A history read is ~13.3s, so a dedicated probe on the happy path would nearly double the
// cost of the cheapest possible call. A read that SUCCEEDS has already answered the question.
test("no probe is spent when the history reads work", async () => {
  const node = fakeNode(
    { [compactAddress(OWNER)]: { balance: 1 }, [compactAddress(OTHER)]: { balance: 2 } },
    { [compactAddress(OWNER)]: [], [compactAddress(OTHER)]: [] },
  );
  const rep = await make(node).readMany([OWNER, OTHER]);
  expect(rep.historySupported).toBe(true);
  const probes = node.calls.filter(
    (c) => c.method === "getTransactionsByAddress" && compactAddress(String(c.params[0])).startsWith("NQ0700000"),
  );
  expect(probes).toHaveLength(0);
  expect(node.calls.filter((c) => c.method === "getTransactionsByAddress")).toHaveLength(2);
});

test("the probe that explains a failure runs once per instance, not once per address", async () => {
  const node = fakeNode(
    { [compactAddress(OWNER)]: { balance: 1 }, [compactAddress(OTHER)]: { balance: 2 } },
    {}, { noHistory: true },
  );
  const rep = await make(node, { onDegraded: "report" }).readMany([OWNER, OTHER]);
  expect(rep.unreadableCount).toBe(2);
  expect(rep.historySupported).toBe(false);
  const probes = node.calls.filter(
    (c) => c.method === "getTransactionsByAddress" && compactAddress(String(c.params[0])).startsWith("NQ0700000"),
  );
  expect(probes).toHaveLength(1);
});

test("a history read that keeps failing marks the address unreadable, and readMany counts it", async () => {
  const node = fakeNode(
    { [compactAddress(OWNER)]: { balance: 400 }, [compactAddress(OTHER)]: { balance: 600 } },
    { [compactAddress(OWNER)]: [], [compactAddress(OTHER)]: [] },
  );
  node.failNext("getTransactionsByAddress", OWNER, 99);
  const rep = await make(node, { retries: 2 }).readMany([OWNER, OTHER]);
  expect(rep.unreadable).toEqual([OWNER]);
  expect(rep.unreadableCount).toBe(1);
  expect(rep.balances[0]!.incompleteReason).toBe("rpc_failed");
  expect(rep.balances[1]!.complete).toBe(true);
  // readMany REPORTS rather than throws: the count is the whole point of the call.
  expect(rep.totalLuna).toBe(1_000);
  expect(rep.historySupported).toBe(true);
});

test("one unreadable contract does not discard the others, but does flag the total as a floor", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 0 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 1_000, sender: OWNER, timeout: NOW + 1 },
      [compactAddress(HTLC_B)]: { type: "htlc", balance: 2_000, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A), fundedHtlc(HTLC_B)] },
  );
  node.failNext("getAccountByAddress", HTLC_B, 99);
  const r = await make(node, { retries: 1, onDegraded: "report" }).read(OWNER);
  expect(r.htlcLuna).toBe(1_000); // A still counted
  expect(r.complete).toBe(false);
  expect(r.incompleteReason).toBe("rpc_failed");
});

test("more contracts than maxContracts is a capped read, not a quiet truncation", async () => {
  const accounts: Accounts = { [compactAddress(OWNER)]: { balance: 0 } };
  const txs = [];
  for (let i = 0; i < 5; i++) {
    const a = `NQ14 ${String(i).repeat(4)} 0000 0000 0000 0000 0000 0000 0000`;
    accounts[compactAddress(a)] = { type: "htlc", balance: 100, sender: OWNER, timeout: NOW + 1 };
    txs.push(fundedHtlc(a));
  }
  const node = fakeNode(accounts, { [compactAddress(OWNER)]: txs });
  const r = await make(node, { maxContracts: 2, onDegraded: "report" }).read(OWNER);
  expect(r.htlcCount).toBe(2);
  expect(r.complete).toBe(false);
  expect(r.incompleteReason).toBe("contract_capped");
});

// ---- backoff ----

test("a transient failure is retried with a doubling backoff, then succeeds", async () => {
  const waits: number[] = [];
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 10 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 5_000, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)] },
  );
  node.failNext("getAccountByAddress", HTLC_A, 2);
  const b = createHtlcAwareBalance({
    url: "http://fake", fetchImpl: node.fetchImpl, logger: quiet, now: () => NOW,
    sleep: async (ms) => { waits.push(ms); }, retries: 3, backoffMs: 100,
  });
  const r = await b.read(OWNER);
  expect(r.totalLuna).toBe(5_010);
  expect(waits).toEqual([100, 200]);
});

test("retries are bounded: it gives up rather than hammering the node forever", async () => {
  const node = fakeNode({ [compactAddress(OWNER)]: { balance: 1 } }, { [compactAddress(OWNER)]: [] });
  node.failNext("getAccountByAddress", OWNER, 99);
  const r = await make(node, { retries: 2, onDegraded: "report" }).read(OWNER);
  expect(r.complete).toBe(false);
  const tries = node.calls.filter(
    (c) => c.method === "getAccountByAddress" && compactAddress(String(c.params[0])) === compactAddress(OWNER),
  );
  expect(tries).toHaveLength(3); // the first attempt plus 2 retries
});

// ---- hops ----

test("maxHops defaults to 0: the contracts our own history names, and no further reads", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 0 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 1_000, sender: OWNER, timeout: NOW + 1 },
      [compactAddress(HTLC_B)]: { type: "htlc", balance: 2_000, sender: OWNER, timeout: NOW + 1 },
    },
    {
      [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)],
      [compactAddress(HTLC_A)]: [fundedHtlc(HTLC_B, HTLC_A)],
    },
  );
  const noHop = await make(node).read(OWNER);
  expect(noHop.htlcLuna).toBe(1_000);
  // Exactly one history read: the owner's own. Each hop would cost another ~13.3s.
  expect(node.calls.filter((c) => c.method === "getTransactionsByAddress")).toHaveLength(1);

  const hopped = await make(node, { maxHops: 1 }).read(OWNER);
  expect(hopped.htlcLuna).toBe(3_000); // B is ours too, and only a hop finds it
});

test("readMany sums the addresses and reports the node's history support", async () => {
  const node = fakeNode(
    {
      [compactAddress(OWNER)]: { balance: 100 },
      [compactAddress(OTHER)]: { balance: 200 },
      [compactAddress(HTLC_A)]: { type: "htlc", balance: 700, sender: OWNER, timeout: NOW + 1 },
    },
    { [compactAddress(OWNER)]: [fundedHtlc(HTLC_A)], [compactAddress(OTHER)]: [] },
  );
  const rep = await make(node).readMany([OWNER, OTHER]);
  expect(rep.totalLuna).toBe(1_000);
  expect(rep.unreadableCount).toBe(0);
  expect(rep.balances.map((b) => b.address)).toEqual([OWNER, OTHER]);
});
