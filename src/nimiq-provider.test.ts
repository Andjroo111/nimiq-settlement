// NimiqProvider tests — NO network, NO @nimiq/core import. A fake client lets us
// push synthetic tx events; the pure matcher is tested with hand-built fixtures.
import { expect, test } from "bun:test";
import { hexToUtf8, matchTransaction, NimiqProvider, type NimiqClientLike, type TxDetails } from "./nimiq-provider";
import type { PaymentRequest, Settlement } from "./provider";

const MERCHANT = "NQ07 0000 0000 0000 0000 0000 0000 0000 0001";
// PUBLIC buyer (sender) NQ.. address on the synthetic txs — forwarded as senderAddress.
const SENDER = "NQ07 9999 9999 9999 9999 9999 9999 9999 9999";

/** UTF-8 → hex (mirrors how a wallet encodes the nimiq: `message` into extraData). */
function utf8ToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function tx(over: Partial<TxDetails>): TxDetails {
  return {
    transactionHash: "hash-1",
    sender: SENDER,
    recipient: MERCHANT,
    value: 5500 * 100_000,
    state: "confirmed",
    data: { type: "raw", raw: utf8ToHex("snap:ab12cd34") },
    ...over,
  };
}

const req = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  saleId: "sale-ab12cd34-xxxx",
  address: MERCHANT,
  amountLuna: 5500 * 100_000,
  reference: "snap:ab12cd34",
  ...over,
});

// ── hex helper ────────────────────────────────────────────────────────────────

test("hexToUtf8 decodes and rejects malformed input", () => {
  expect(hexToUtf8(utf8ToHex("snap:ab12cd34"))).toBe("snap:ab12cd34");
  expect(hexToUtf8("zz")).toBeNull(); // non-hex
  expect(hexToUtf8("abc")).toBeNull(); // odd length
  expect(hexToUtf8(undefined)).toBeNull();
  expect(hexToUtf8("")).toBeNull(); // empty extraData is treated as no-reference
});

// ── pure matcher ──────────────────────────────────────────────────────────────

test("matcher: reference + sufficient value + confirmed → paid", () => {
  expect(matchTransaction(req(), tx({}), MERCHANT)).toBe("paid");
});

test("matcher: included → detected", () => {
  expect(matchTransaction(req(), tx({ state: "included" }), MERCHANT)).toBe("detected");
});

test("matcher: non-event states → null", () => {
  for (const s of ["new", "pending", "invalidated", "expired"] as const) {
    expect(matchTransaction(req(), tx({ state: s }), MERCHANT)).toBeNull();
  }
});

test("matcher: wrong recipient → null", () => {
  expect(matchTransaction(req(), tx({ recipient: "NQ07 9999 9999 9999 9999 9999 9999 9999 9999" }), MERCHANT)).toBeNull();
});

test("matcher: value below amountLuna → null; equal/greater → match", () => {
  expect(matchTransaction(req(), tx({ value: 5500 * 100_000 - 1 }), MERCHANT)).toBeNull();
  expect(matchTransaction(req(), tx({ value: 5500 * 100_000 }), MERCHANT)).toBe("paid");
  expect(matchTransaction(req(), tx({ value: 5500 * 100_000 + 999 }), MERCHANT)).toBe("paid");
});

test("matcher: wrong/missing/garbled extraData → null", () => {
  expect(matchTransaction(req(), tx({ data: { type: "raw", raw: utf8ToHex("snap:wrong000") } }), MERCHANT)).toBeNull();
  expect(matchTransaction(req(), tx({ data: { type: "raw" } }), MERCHANT)).toBeNull();
  expect(matchTransaction(req(), tx({ data: { type: "raw", raw: "zzzz" } }), MERCHANT)).toBeNull();
});

test("matcher: non-raw data type (e.g. staking) → null", () => {
  expect(matchTransaction(req(), tx({ data: { type: "add-stake" } }), MERCHANT)).toBeNull();
});

test("matcher: address spacing/case differences still match", () => {
  expect(matchTransaction(req(), tx({ recipient: MERCHANT.toLowerCase() }), MERCHANT)).toBe("paid");
});

// ── fake client + provider behavior ────────────────────────────────────────────

class FakeClient implements NimiqClientLike {
  listener: ((tx: TxDetails) => unknown) | null = null;
  removed = false;
  backfillTxs: TxDetails[] = [];
  consensusCb: ((s: string) => unknown) | null = null;

  async addTransactionListener(listener: (tx: TxDetails) => unknown): Promise<number> {
    this.listener = listener;
    return 1;
  }
  async removeListener(): Promise<void> {
    this.removed = true;
  }
  async getTransactionsByAddress(): Promise<TxDetails[]> {
    return this.backfillTxs;
  }
  async waitForConsensusEstablished(): Promise<void> {}
  async addConsensusChangedListener(listener: (s: string) => unknown): Promise<number> {
    this.consensusCb = listener;
    return 2;
  }
  /** Push a synthetic tx through the live listener (after it's registered). */
  emit(t: TxDetails) {
    this.listener?.(t);
  }
}

function makeProvider(opts: { payTimeoutMs?: number } = {}) {
  const fake = new FakeClient();
  const provider = new NimiqProvider({
    merchantAddress: MERCHANT,
    clientFactory: async () => fake,
    payTimeoutMs: opts.payTimeoutMs,
  });
  return { provider, fake };
}

/** Wait for the listener to be registered (provider arms it async). */
async function ready(fake: FakeClient) {
  for (let i = 0; i < 50 && !fake.listener; i++) await new Promise((r) => setTimeout(r, 1));
  expect(fake.listener).not.toBeNull();
}

test("getReceiveAddress returns the configured merchant address (not MOCK)", async () => {
  const { provider } = makeProvider();
  expect(await provider.getReceiveAddress()).toBe(MERCHANT);
  expect(provider.kind).toBe("nimiq");
  expect(provider.simulated).toBe(false);
});

test("watch → matching tx fires onSettled exactly once", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  fake.emit(tx({ transactionHash: "tx-paid" }));
  fake.emit(tx({ transactionHash: "tx-paid" })); // duplicate — must not double-fire
  expect(seen.length).toBe(1);
  expect(seen[0]!.saleId).toBe(req().saleId);
  expect(seen[0]!.txHash).toBe("tx-paid");
  expect(seen[0]!.detectedAt).toBeGreaterThan(0);
});

test("non-matching txs do not fire onSettled", async () => {
  const { provider, fake } = makeProvider();
  let fired = 0;
  provider.watch(req(), () => fired++);
  await ready(fake);

  fake.emit(tx({ value: 1 })); // too small
  fake.emit(tx({ data: { type: "raw", raw: utf8ToHex("snap:other000") } })); // wrong ref
  fake.emit(tx({ state: "pending" })); // non-event
  expect(fired).toBe(0);
});

test("cancel() is idempotent and stops further fires", async () => {
  const { provider, fake } = makeProvider();
  let fired = 0;
  const cancel = provider.watch(req(), () => fired++);
  await ready(fake);

  cancel();
  cancel(); // idempotent — no throw
  fake.emit(tx({})); // payment lands after cancel → ignored
  expect(fired).toBe(0);
});

test("two concurrent sales are matched independently by reference", async () => {
  const { provider, fake } = makeProvider();
  const a: Settlement[] = [];
  const b: Settlement[] = [];
  provider.watch(req({ reference: "snap:aaaa1111", saleId: "sale-a" }), (s) => a.push(s));
  provider.watch(req({ reference: "snap:bbbb2222", saleId: "sale-b" }), (s) => b.push(s));
  await ready(fake);

  fake.emit(tx({ data: { type: "raw", raw: utf8ToHex("snap:bbbb2222") }, transactionHash: "tx-b" }));
  expect(a.length).toBe(0);
  expect(b.length).toBe(1);
  expect(b[0]!.saleId).toBe("sale-b");
});

// ── Defect 2: detected → paid staging ──────────────────────────────────────────

test("included then confirmed fires onSettled TWICE: detected then paid, valueLuna set", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  fake.emit(tx({ state: "included", transactionHash: "tx-1", value: 5500 * 100_000 }));
  fake.emit(tx({ state: "confirmed", transactionHash: "tx-1", value: 5500 * 100_000 }));

  expect(seen.length).toBe(2);
  expect(seen[0]!.status).toBe("detected");
  expect(seen[1]!.status).toBe("paid");
  expect(seen[0]!.txHash).toBe("tx-1");
  expect(seen[1]!.txHash).toBe("tx-1");
  expect(seen[0]!.valueLuna).toBe(5500 * 100_000);
  expect(seen[1]!.valueLuna).toBe(5500 * 100_000);
});

test("duplicate included does NOT re-fire detected", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  fake.emit(tx({ state: "included" }));
  fake.emit(tx({ state: "included" })); // duplicate
  expect(seen.length).toBe(1);
  expect(seen[0]!.status).toBe("detected");
});

test("confirmed-first (no prior included) fires a single paid", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  fake.emit(tx({ state: "confirmed" }));
  expect(seen.length).toBe(1);
  expect(seen[0]!.status).toBe("paid");
});

// ── Defect 3: overpayment captured, not clamped ────────────────────────────────

test("overpayment: confirmed value above amount → paid with the actual valueLuna", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  const over = 5500 * 100_000 + 999;
  fake.emit(tx({ state: "confirmed", value: over }));
  expect(seen.length).toBe(1);
  expect(seen[0]!.status).toBe("paid");
  expect(seen[0]!.valueLuna).toBe(over); // captured, not clamped to amountLuna
});

test("underpayment never fires at the provider level", async () => {
  const { provider, fake } = makeProvider();
  let fired = 0;
  provider.watch(req(), () => fired++);
  await ready(fake);

  fake.emit(tx({ state: "confirmed", value: 5500 * 100_000 - 1 }));
  expect(fired).toBe(0);
});

// ── Defect 1: expiry fires onExpired, not onSettled ────────────────────────────

test("expiry timer removes the armed sale WITHOUT firing onSettled", async () => {
  const { provider, fake } = makeProvider({ payTimeoutMs: 5 });
  let fired = 0;
  provider.watch(req(), () => fired++);
  await ready(fake);

  await new Promise((r) => setTimeout(r, 15)); // let the timer elapse
  fake.emit(tx({})); // late payment → not matched (entry already dropped)
  expect(fired).toBe(0);
});

test("expiry invokes onExpired with saleId/reference; onSettled never fires; late tx is ignored", async () => {
  const { provider, fake } = makeProvider({ payTimeoutMs: 5 });
  let settled = 0;
  const expired: Array<{ saleId: string; reference: string }> = [];
  provider.watch(
    req(),
    () => settled++,
    (saleId, reference) => expired.push({ saleId, reference }),
  );
  await ready(fake);

  await new Promise((r) => setTimeout(r, 15)); // elapse the timer
  expect(expired.length).toBe(1);
  expect(expired[0]!.saleId).toBe(req().saleId);
  expect(expired[0]!.reference).toBe(req().reference);
  expect(settled).toBe(0);

  fake.emit(tx({})); // late payment after expiry → entry already dropped
  expect(settled).toBe(0);
});

test("backfill on consensus-established catches a missed payment", async () => {
  const { provider, fake } = makeProvider();
  const seen: Settlement[] = [];
  provider.watch(req(), (s) => seen.push(s));
  await ready(fake);

  // Payment arrived during a gap: only available via getTransactionsByAddress.
  fake.backfillTxs = [tx({ transactionHash: "tx-missed" })];
  fake.consensusCb?.("established");
  await new Promise((r) => setTimeout(r, 5));
  expect(seen.length).toBe(1);
  expect(seen[0]!.txHash).toBe("tx-missed");
});

test("dispose() removes the listener and clears armed sales", async () => {
  const { provider, fake } = makeProvider({ payTimeoutMs: 10_000 });
  provider.watch(req(), () => {});
  await ready(fake);
  await provider.dispose();
  expect(fake.removed).toBe(true);
});
