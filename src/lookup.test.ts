import { describe, expect, test } from "bun:test";
import {
  createLookup,
  normalizeTx,
  resolveHandle,
  unwrapRpcResult,
  type LookupRpc,
  type TxHashDeriver,
} from "./lookup";

const H = "a".repeat(64);
const OTHER = "b".repeat(64);
const MERCHANT = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";

/** Stands in for E3's nimiq-edge/tx. Real shape, fake answer. */
const deriver: TxHashDeriver = {
  transactionHash: (input) => (input.replace(/^0x/, "").length > 64 ? H : null),
  looksLikeSerializedTransaction: (input) => input.replace(/^0x/, "").length > 64,
};

describe("resolveHandle", () => {
  test("a bare 64-hex hash resolves, case-insensitively", () => {
    expect(resolveHandle(H)).toEqual({ kind: "hash", hash: H });
    expect(resolveHandle(H.toUpperCase())).toEqual({ kind: "hash", hash: H });
    expect(resolveHandle(`  ${H}  `)).toEqual({ kind: "hash", hash: H });
  });

  test("a serialized tx is derived, not guessed", () => {
    const serialized = "00" + "ab".repeat(40);
    expect(resolveHandle(serialized, deriver)).toEqual({ kind: "serialized", hash: H });
  });

  test("a serialized tx with no deriver refuses rather than guessing", () => {
    const serialized = "00" + "ab".repeat(40);
    expect(resolveHandle(serialized)).toEqual({ kind: "unresolvable", reason: "no-deriver" });
  });

  test("a deriver returning null makes it underivable, never a hash", () => {
    const blind: TxHashDeriver = { transactionHash: () => null };
    const r = resolveHandle("00" + "ab".repeat(40), blind);
    expect(r.kind).toBe("unresolvable");
    expect(r).toEqual({ kind: "unresolvable", reason: "underivable" });
  });

  test("a deriver returning a non-hash is rejected, not trusted", () => {
    const liar: TxHashDeriver = { transactionHash: () => "not-a-hash" };
    expect(resolveHandle("00" + "ab".repeat(40), liar)).toEqual({
      kind: "unresolvable",
      reason: "underivable",
    });
  });

  test("the deriver's null outranks its own shape filter saying true", () => {
    const inconsistent: TxHashDeriver = {
      transactionHash: () => null,
      looksLikeSerializedTransaction: () => true,
    };
    expect(resolveHandle("00" + "ab".repeat(40), inconsistent).kind).toBe("unresolvable");
  });

  test("opaque input is refused without consulting the deriver", () => {
    let asked = 0;
    const counting: TxHashDeriver = {
      transactionHash: () => {
        asked++;
        return H;
      },
    };
    for (const bad of ["", "   ", "pending", "zz".repeat(40), 42, null, undefined, {}, ["x"]]) {
      expect(resolveHandle(bad, counting).kind).toBe("unresolvable");
    }
    // Odd-length hex is not a transaction either.
    expect(resolveHandle("0" + "ab".repeat(40), counting).kind).toBe("unresolvable");
    expect(asked).toBe(0);
  });

  test("a 0x prefix is accepted on a serialized tx", () => {
    expect(resolveHandle("0x00" + "ab".repeat(40), deriver)).toEqual({
      kind: "serialized",
      hash: H,
    });
  });
});

describe("unwrapRpcResult", () => {
  test("unwraps {data}, passes a flat body, one level only", () => {
    expect(unwrapRpcResult<{ hash: string }>({ data: { hash: H } })).toEqual({ hash: H });
    expect(unwrapRpcResult<{ hash: string }>({ hash: H })).toEqual({ hash: H });
    expect(unwrapRpcResult(null)).toBe(null);
    // Not two levels: the inner {data} is returned as-is, not unwrapped again.
    expect(unwrapRpcResult<{ data: { hash: string } }>({ data: { data: { hash: H } } })).toEqual({ data: { hash: H } });
  });
});

describe("normalizeTx", () => {
  test("reads the field names nodes actually use", () => {
    expect(normalizeTx({ hash: H, from: "A", to: "B", value: 5, blockNumber: 10 })).toEqual({
      hash: H,
      blockNumber: 10,
      sender: "A",
      recipient: "B",
      value: 5,
      recipientData: null,
      executionResult: null,
    });
    expect(normalizeTx({ data: { hash: H, block_height: 7, sender: "A", recipient: "B" } })?.blockNumber).toBe(7);
    expect(normalizeTx({ hash: H, blockHeight: 9 })?.blockNumber).toBe(9);
    expect(normalizeTx({ hash: H, value: "1500" })?.value).toBe(1500);
  });

  test("no hash means no transaction", () => {
    expect(normalizeTx({ from: "A" })).toBe(null);
    expect(normalizeTx(null)).toBe(null);
    expect(normalizeTx("nope")).toBe(null);
  });
});

function rpcOf(over: Partial<LookupRpc> = {}) {
  const calls: string[] = [];
  const rpc: LookupRpc = {
    getTransactionByHash: async (h) => {
      calls.push("hash");
      return over.getTransactionByHash ? over.getTransactionByHash(h) : null;
    },
    getTransactionFromMempool: async (h) => {
      calls.push("mempool");
      return over.getTransactionFromMempool ? over.getTransactionFromMempool(h) : null;
    },
    getTransactionsByAddress: async (a, m) => {
      calls.push("history");
      return over.getTransactionsByAddress ? over.getTransactionsByAddress(a, m) : [];
    },
  };
  return { rpc, calls };
}

describe("find", () => {
  test("a mined tx is ok, and the mempool is not consulted", async () => {
    const { rpc, calls } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, blockNumber: 100, to: MERCHANT, value: 5 }),
    });
    const r = await createLookup({ rpc }).find(H);
    expect(r.state).toBe("ok");
    expect(r.via).toBe("hash");
    expect(r.tx?.blockNumber).toBe(100);
    expect(calls).toEqual(["hash"]);
  });

  test("INCLUDED BUT FAILED is its own outcome, not success", async () => {
    const { rpc } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, blockNumber: 100, executionResult: false }),
    });
    const r = await createLookup({ rpc }).find(H);
    expect(r.state).toBe("failed");
  });

  test("not mined falls through to the mempool instead of reporting not-found", async () => {
    const { rpc, calls } = rpcOf({
      getTransactionFromMempool: async () => ({ hash: H, to: MERCHANT, value: 5 }),
    });
    const r = await createLookup({ rpc }).find(H);
    expect(r.state).toBe("mempool");
    expect(r.via).toBe("mempool");
    expect(calls).toEqual(["hash", "mempool"]);
  });

  test("a tx with no block number is in flight, not settled", async () => {
    const { rpc } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, to: MERCHANT, value: 5 }),
    });
    expect((await createLookup({ rpc }).find(H)).state).toBe("mempool");
  });

  test("a public RPC answering null is recovered from address history", async () => {
    const { rpc, calls } = rpcOf({
      getTransactionsByAddress: async () => [
        { hash: OTHER, to: MERCHANT, value: 5000, blockNumber: 90 },
        { hash: H, to: MERCHANT, value: 5000, blockNumber: 100 },
      ],
    });
    const r = await createLookup({ rpc }).find(H, { recipient: MERCHANT, valueLuna: 5000 });
    expect(r.state).toBe("ok");
    expect(r.via).toBe("addressHistory");
    expect(calls).toEqual(["hash", "mempool", "history"]);
  });

  test("recovery demands an EXACT hash match, never a near one", async () => {
    const { rpc } = rpcOf({
      getTransactionsByAddress: async () => [{ hash: OTHER, to: MERCHANT, value: 5000, blockNumber: 100 }],
    });
    const r = await createLookup({ rpc }).find(H, { recipient: MERCHANT, valueLuna: 5000 });
    expect(r.state).toBe("notSeen");
  });

  test("recovery rejects a wrong value or a wrong memo", async () => {
    const mk = (tx: Record<string, unknown>) =>
      rpcOf({ getTransactionsByAddress: async () => [tx] }).rpc;

    const wrongValue = mk({ hash: H, to: MERCHANT, value: 4999, blockNumber: 100 });
    expect((await createLookup({ rpc: wrongValue }).find(H, { recipient: MERCHANT, valueLuna: 5000 })).state).toBe("notSeen");

    const wrongMemo = mk({ hash: H, to: MERCHANT, value: 5000, recipientData: "dead", blockNumber: 100 });
    expect(
      (await createLookup({ rpc: wrongMemo }).find(H, { recipient: MERCHANT, valueLuna: 5000, recipientDataHex: "beef" })).state,
    ).toBe("notSeen");
  });

  test("recovery does NOT check the sender, because Pay pays from an HTLC", async () => {
    const { rpc } = rpcOf({
      getTransactionsByAddress: async () => [
        { hash: H, from: "NQ99 SOME HTLC", to: MERCHANT, value: 5000, blockNumber: 100 },
      ],
    });
    const r = await createLookup({ rpc }).find(H, { recipient: MERCHANT, valueLuna: 5000 });
    expect(r.state).toBe("ok");
  });

  test("recipient matching ignores address spacing and case", async () => {
    const { rpc } = rpcOf({
      getTransactionsByAddress: async () => [
        { hash: H, to: MERCHANT.replace(/\s/g, "").toLowerCase(), value: 5000, blockNumber: 100 },
      ],
    });
    expect((await createLookup({ rpc }).find(H, { recipient: MERCHANT, valueLuna: 5000 })).state).toBe("ok");
  });

  test("no expectation means no history scan", async () => {
    const { rpc, calls } = rpcOf();
    const r = await createLookup({ rpc }).find(H);
    expect(r.state).toBe("notSeen");
    expect(calls).toEqual(["hash", "mempool"]);
  });

  test("a throwing node is notSeen, never ok", async () => {
    const { rpc } = rpcOf({
      getTransactionByHash: async () => {
        throw new Error("rate limited");
      },
      getTransactionFromMempool: async () => {
        throw new Error("rate limited");
      },
      getTransactionsByAddress: async () => {
        throw new Error("rate limited");
      },
    });
    const r = await createLookup({ rpc, logger: { warn: () => {} } }).find(H, { recipient: MERCHANT });
    expect(r.state).toBe("notSeen");
  });

  test("a node without mempool or history support degrades, it does not throw", async () => {
    const bare = { getTransactionByHash: async () => null };
    const r = await createLookup({ rpc: bare }).find(H, { recipient: MERCHANT });
    expect(r.state).toBe("notSeen");
  });

  test("a malformed hash never reaches the node", async () => {
    const { rpc, calls } = rpcOf();
    expect((await createLookup({ rpc }).find("nope")).state).toBe("unresolvable");
    expect(calls).toEqual([]);
  });
});

describe("findByHandle", () => {
  test("an unresolvable handle never touches the node", async () => {
    const { rpc, calls } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, blockNumber: 1 }),
    });
    const r = await createLookup({ rpc, deriver }).findByHandle("some-opaque-provider-id");
    expect(r.state).toBe("unresolvable");
    expect(r.hash).toBe(null);
    expect(calls).toEqual([]);
  });

  test("a serialized handle is derived then looked up", async () => {
    const { rpc } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, blockNumber: 100 }),
    });
    const r = await createLookup({ rpc, deriver }).findByHandle("00" + "ab".repeat(40));
    expect(r.state).toBe("ok");
    expect(r.hash).toBe(H);
  });

  test("a serialized handle with no deriver is unresolvable, not looked up", async () => {
    const { rpc, calls } = rpcOf({
      getTransactionByHash: async () => ({ hash: H, blockNumber: 100 }),
    });
    const r = await createLookup({ rpc }).findByHandle("00" + "ab".repeat(40));
    expect(r.state).toBe("unresolvable");
    expect(calls).toEqual([]);
  });
});
