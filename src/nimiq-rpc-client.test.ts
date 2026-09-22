// Unit tests for the RPC-backed NimiqClientLike. We drive a FAKE JSON-RPC chain
// (no network, no node) and step the scanner deterministically, asserting the
// tx-JSON → TxDetails mapping and the included→confirmed (detected→paid) staging
// that the proven NimiqProvider relies on.

import { describe, expect, test } from "bun:test";
import { RpcNimiqClient } from "./nimiq-rpc-client";
import type { TxDetails } from "./nimiq-provider";

const MERCHANT = "NQ63 9K3A TULC 1SFU BYSE 11VP 36BT REST BF61";
const BUYER = "NQ20 8P9L 3YMD GQYT 1TAA 8D0G MC12 5HBQ 1Q8A";
const OTHER = "NQ56 SGQY 05PD P73K 8YBB 1TX9 1QT9 8YRB 497K";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

interface FakeTx {
  hash: string;
  from: string;
  to: string;
  value: number;
  recipientData: string;
  executionResult?: boolean;
  blockNumber: number;
}

/** A scripted chain: head height + blocks (by number) + a by-hash index. */
class FakeChain {
  head = 100;
  blocks = new Map<number, FakeTx[]>();
  consensus = true;
  calls: string[] = [];
  /** Methods that should throw, to simulate a node that cannot answer. */
  failing = new Set<string>();

  add(n: number, tx: FakeTx) {
    const list = this.blocks.get(n) ?? [];
    list.push(tx);
    this.blocks.set(n, list);
  }

  fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    const { method, params } = body;
    this.calls.push(method);
    if (this.failing.has(method)) throw new Error(`fake node refused ${method}`);
    let data: unknown = null;
    if (method === "getBlockNumber") data = this.head;
    else if (method === "isConsensusEstablished") data = this.consensus;
    else if (method === "getBlockByNumber") {
      const n = params[0] as number;
      data = { number: n, transactions: this.blocks.get(n) ?? [] };
    } else if (method === "getLatestBlock") {
      data = { number: this.head };
    } else if (method === "getMacroBlockAfter") {
      // What a real node answers: the first macro block strictly after h.
      const h = params[0] as number;
      data = { number: Math.floor(h / 60) * 60 + 60 };
    } else if (method === "getTransactionByHash") {
      const h = params[0] as string;
      let found: FakeTx | null = null;
      for (const list of this.blocks.values()) for (const t of list) if (t.hash === h) found = t;
      data = found ? { ...found } : null;
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", result: { data, metadata: null }, id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Build a client wired to a fake chain, with the auto-poll timer disabled so we
 *  can step scanOnce() by hand. */
async function armed(chain: FakeChain) {
  const fired: TxDetails[] = [];
  const client = new RpcNimiqClient({
    url: "http://fake",
    fetchImpl: chain.fetch,
    pollMs: 1e9,
    logger: { warn() {}, error() {} },
  });
  await client.addTransactionListener((tx) => fired.push(tx), [MERCHANT]);
  (client as unknown as { stop(): void }).stop(); // cancel the background poller
  const scan = () => (client as unknown as { scanOnce(): Promise<void> }).scanOnce();
  return { client, fired, scan };
}

describe("RpcNimiqClient", () => {
  test("maps a watched-address tx to TxDetails and fires 'included' (detected)", async () => {
    const chain = new FakeChain();
    chain.add(100, {
      hash: "aa11",
      from: BUYER,
      to: MERCHANT,
      value: 1000,
      recipientData: hex("snap:abc123"),
      blockNumber: 100,
    });
    const { fired, scan } = await armed(chain);
    await scan();

    expect(fired.length).toBe(1);
    const tx = fired[0]!;
    expect(tx.state).toBe("included");
    expect(tx.transactionHash).toBe("aa11");
    expect(tx.sender).toBe(BUYER);
    expect(tx.recipient).toBe(MERCHANT);
    expect(tx.value).toBe(1000);
    expect(tx.data.type).toBe("raw");
    expect(tx.data.raw).toBe(hex("snap:abc123"));
  });

  test("stages 'confirmed' (paid) only at FINALITY, not at a depth", async () => {
    const chain = new FakeChain();
    chain.add(100, {
      hash: "bb22",
      from: BUYER,
      to: MERCHANT,
      value: 5000,
      recipientData: hex("snap:deadbeef"),
      blockNumber: 100,
    });
    const { fired, scan } = await armed(chain);

    // tx in block 100 => its batch is closed by the macro block at 120.
    await scan(); // head=100 -> included only
    expect(fired.map((t) => t.state)).toEqual(["included"]);

    chain.head = 110; // 11 blocks deep. The OLD gate (depth >= 3) paid here.
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included"]);

    chain.head = 119; // 20 deep, one block short of the macro block.
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included"]);

    chain.head = 120; // the macro block after 100 exists -> settled.
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included", "confirmed"]);

    chain.head = 121;
    await scan(); // no duplicate emits
    expect(fired.map((t) => t.state)).toEqual(["included", "confirmed"]);
  });

  test("asks the node for the macro target once, then only re-polls", async () => {
    const chain = new FakeChain();
    chain.add(100, { hash: "cc33", from: BUYER, to: MERCHANT, value: 1, recipientData: hex("x"), blockNumber: 100 });
    const { scan } = await armed(chain);
    await scan();
    chain.head = 110;
    await scan();
    chain.head = 115;
    await scan();
    expect(chain.calls.filter((c) => c === "getMacroBlockAfter").length).toBe(1);
  });

  test("a tx that turns out to have FAILED never settles and stops being watched", async () => {
    const chain = new FakeChain();
    const tx: FakeTx = {
      hash: "dd44",
      from: BUYER,
      to: MERCHANT,
      value: 5000,
      recipientData: hex("snap:fail"),
      blockNumber: 100,
    };
    chain.add(100, tx);
    const { fired, scan } = await armed(chain);
    await scan(); // seen clean, fires "included"
    expect(fired.map((t) => t.state)).toEqual(["included"]);

    // The by-hash re-verify is the only thing that can see this: it landed in a
    // block and did NOT go through. No height comparison detects it.
    tx.executionResult = false;

    chain.head = 120; // final by height
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included"]);

    chain.head = 200;
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included"]);
    // Dropped from pending, so it is not re-checked forever.
    const before = chain.calls.filter((c) => c === "getTransactionByHash").length;
    await scan();
    expect(chain.calls.filter((c) => c === "getTransactionByHash").length).toBe(before);
  });

  test("an unreadable node leaves it pending rather than reporting paid", async () => {
    const chain = new FakeChain();
    chain.add(100, { hash: "ee55", from: BUYER, to: MERCHANT, value: 7, recipientData: hex("y"), blockNumber: 100 });
    const { fired, scan } = await armed(chain);
    await scan();

    chain.failing.add("getTransactionByHash");
    chain.head = 120;
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included"]); // NOT paid

    chain.failing.delete("getTransactionByHash"); // node recovers
    await scan();
    expect(fired.map((t) => t.state)).toEqual(["included", "confirmed"]);
  });

  test("boot backfill re-scans blocks before head (catches a downtime payment), but not older", async () => {
    const chain = new FakeChain();
    chain.head = 100;
    // landed during downtime, within the 10-block backfill window (>= head-10 = 90)
    chain.add(95, { hash: "ee55", from: BUYER, to: MERCHANT, value: 1000, recipientData: hex("snap:boot"), blockNumber: 95 });
    // older than the window — must NOT be re-scanned
    chain.add(80, { hash: "old0", from: BUYER, to: MERCHANT, value: 1000, recipientData: hex("snap:old"), blockNumber: 80 });

    const fired: TxDetails[] = [];
    const client = new RpcNimiqClient({
      url: "http://fake",
      fetchImpl: chain.fetch,
      pollMs: 1e9,
      backfillBlocks: 10,
      logger: { warn() {}, error() {} },
    });
    await client.addTransactionListener((tx) => fired.push(tx), [MERCHANT]);
    (client as unknown as { stop(): void }).stop();
    await (client as unknown as { scanOnce(): Promise<void> }).scanOnce();

    const hashes = fired.map((t) => t.transactionHash);
    expect(hashes).toContain("ee55"); // downtime payment recovered
    expect(hashes).not.toContain("old0"); // older than the backfill window
  });

  test("ignores txs to a non-watched address and failed (executionResult=false) txs", async () => {
    const chain = new FakeChain();
    chain.add(100, { hash: "cc33", from: BUYER, to: OTHER, value: 9, recipientData: hex("x"), blockNumber: 100 });
    chain.add(100, {
      hash: "dd44",
      from: BUYER,
      to: MERCHANT,
      value: 9,
      recipientData: hex("snap:fail"),
      executionResult: false,
      blockNumber: 100,
    });
    const { fired, scan } = await armed(chain);
    chain.head = 110;
    await scan();
    expect(fired.length).toBe(0);
  });

  test("a transient mid-scan block failure resumes from the failed block (no skip, no double-emit)", async () => {
    const chain = new FakeChain();
    chain.head = 100;
    chain.add(98, { hash: "f1", from: BUYER, to: MERCHANT, value: 1000, recipientData: hex("snap:a"), blockNumber: 98 });
    chain.add(100, { hash: "f2", from: BUYER, to: MERCHANT, value: 1000, recipientData: hex("snap:b"), blockNumber: 100 });
    // Make block 99's fetch throw exactly once, then succeed.
    let fail99 = true;
    const flaky = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getBlockByNumber" && body.params[0] === 99 && fail99) {
        fail99 = false;
        throw new Error("transient rpc");
      }
      return chain.fetch(url, init);
    };
    const fired: TxDetails[] = [];
    const client = new RpcNimiqClient({
      url: "http://fake",
      fetchImpl: flaky,
      pollMs: 1e9,
      backfillBlocks: 5,
      logger: { warn() {}, error() {} },
    });
    await client.addTransactionListener((tx) => fired.push(tx), [MERCHANT]);
    (client as unknown as { stop(): void }).stop();
    const scan = () => (client as unknown as { scanOnce(): Promise<void> }).scanOnce();

    await scan().catch(() => {}); // first scan ingests 95-98 then throws on block 99
    await scan(); // resumes from 99, scans 99-100, stages everything

    // both payments caught, each "included" exactly once (no skip of 98, no re-scan double-emit)
    const included = fired.filter((t) => t.state === "included").map((t) => t.transactionHash).sort();
    expect(included).toEqual(["f1", "f2"]);
  });

  test("getTransactionsByAddress returns [] (no history index; poller covers live)", async () => {
    const chain = new FakeChain();
    const { client } = await armed(chain);
    expect(await client.getTransactionsByAddress("anything")).toEqual([]);
  });

  test("waitForConsensusEstablished resolves when the node reports consensus", async () => {
    const chain = new FakeChain();
    chain.consensus = true;
    const client = new RpcNimiqClient({ url: "http://fake", fetchImpl: chain.fetch, pollMs: 1e9 });
    await client.waitForConsensusEstablished(); // resolves without throwing
    expect(chain.calls).toContain("isConsensusEstablished");
  });

  test("rpc() unwraps result.data and throws on an rpc error", async () => {
    const chain = new FakeChain();
    const client = new RpcNimiqClient({ url: "http://fake", fetchImpl: chain.fetch, pollMs: 1e9 });
    const head = await (client as unknown as { rpc(m: string, p: unknown[]): Promise<number> }).rpc(
      "getBlockNumber",
      [],
    );
    expect(head).toBe(100);

    const errFetch = async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: "boom" }, id: 1 }), {
        status: 200,
      });
    const c2 = new RpcNimiqClient({ url: "http://fake", fetchImpl: errFetch, pollMs: 1e9 });
    await expect(
      (c2 as unknown as { rpc(m: string, p: unknown[]): Promise<unknown> }).rpc("getBlockNumber", []),
    ).rejects.toThrow(/boom/);
  });
});
