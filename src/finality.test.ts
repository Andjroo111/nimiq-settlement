import { describe, expect, test } from "bun:test";
import {
  BLOCKS_PER_BATCH,
  NETWORKS,
  batchOf,
  blocksUntilFinal,
  createFinalityGate,
  finalityState,
  isElectionBlock,
  isMacroBlock,
  lastMacroBlock,
  macroBlockAfter,
  type FinalityRpc,
} from "./finality";

describe("policy constants", () => {
  test("genesis is the PoS takeover height, not 0", () => {
    expect(NETWORKS.main.genesisBlock).toBe(3_456_000);
    expect(NETWORKS.test.genesisBlock).toBe(3_032_010);
    expect(NETWORKS.main.id).toBe(24);
    expect(NETWORKS.test.id).toBe(5);
  });
});

describe("macro block math", () => {
  test("lastMacroBlock floors to the batch boundary", () => {
    expect(lastMacroBlock(0)).toBe(0);
    expect(lastMacroBlock(1)).toBe(0);
    expect(lastMacroBlock(59)).toBe(0);
    expect(lastMacroBlock(60)).toBe(60);
    expect(lastMacroBlock(61)).toBe(60);
    expect(lastMacroBlock(119)).toBe(60);
    expect(lastMacroBlock(120)).toBe(120);
  });

  test("macroBlockAfter is strictly after, including on a macro block", () => {
    expect(macroBlockAfter(1)).toBe(60);
    expect(macroBlockAfter(59)).toBe(60);
    // The deliberate conservatism: a tx IN a macro block waits a full batch.
    expect(macroBlockAfter(60)).toBe(120);
    expect(macroBlockAfter(61)).toBe(120);
  });

  test("isMacroBlock and isElectionBlock", () => {
    expect(isMacroBlock(60)).toBe(true);
    expect(isMacroBlock(61)).toBe(false);
    // 32 batches per epoch => 1920 blocks.
    expect(isElectionBlock(1920)).toBe(true);
    expect(isElectionBlock(1860)).toBe(false);
  });

  test("batchOf", () => {
    expect(batchOf(1)).toBe(1);
    expect(batchOf(60)).toBe(1);
    expect(batchOf(61)).toBe(2);
  });

  test("bad heights throw rather than silently floor", () => {
    expect(() => lastMacroBlock(-1)).toThrow();
    expect(() => lastMacroBlock(1.5)).toThrow();
    expect(() => lastMacroBlock(NaN)).toThrow();
  });
});

describe("finalityState", () => {
  test("no chain context is observed, never final", () => {
    expect(finalityState(null, 100)).toBe("observed");
    expect(finalityState(100, null)).toBe("observed");
    expect(finalityState(undefined, undefined)).toBe("observed");
  });

  test("pending until the macro block after the tx exists", () => {
    // tx in block 61 => batch closes at 120.
    expect(finalityState(61, 61)).toBe("pending");
    expect(finalityState(61, 119)).toBe("pending");
    expect(finalityState(61, 120)).toBe("final");
    expect(finalityState(61, 121)).toBe("final");
  });

  test("THE BUG: depth is not finality", () => {
    // A tx one block into a batch, 59 blocks deep. A `depth >= 30` or even a
    // `depth >= 59` confirmation gate calls this paid. It is not: the batch
    // holding it has not been closed by a macro block.
    const txBlock = 61;
    const head = 119;
    const depth = head - txBlock + 1;
    expect(depth).toBe(59);
    expect(finalityState(txBlock, head)).toBe("pending");

    // And the reverse: a tx at the end of a batch is final only ONE block deep.
    // A `depth >= 30` gate would still be waiting on money that has settled.
    expect(finalityState(119, 120)).toBe("final");
    expect(120 - 119 + 1).toBe(2);
  });

  test("a head behind the tx cannot be final", () => {
    // Holds by the macroBlockAfter(h) > h invariant, not by a separate guard.
    expect(finalityState(500, 499)).toBe("pending");
    expect(finalityState(500, 0)).toBe("pending");
  });

  test("blocksUntilFinal counts down to 0 and stops", () => {
    expect(blocksUntilFinal(61, 61)).toBe(59);
    expect(blocksUntilFinal(61, 119)).toBe(1);
    expect(blocksUntilFinal(61, 120)).toBe(0);
    expect(blocksUntilFinal(61, 9999)).toBe(0);
    expect(blocksUntilFinal(null, 120)).toBe(null);
  });
});

/** A node whose answers and call counts the test controls. */
function fakeRpc(over: Partial<FinalityRpc> & { head?: number } = {}) {
  const calls = { macro: 0, head: 0 };
  const wrapped: FinalityRpc = {
    getMacroBlockAfter: async (h) => {
      calls.macro++;
      return over.getMacroBlockAfter ? over.getMacroBlockAfter(h) : { number: macroBlockAfter(h) };
    },
    getHeadNumber: async () => {
      calls.head++;
      return over.getHeadNumber ? over.getHeadNumber() : (over.head ?? 0);
    },
  };
  return { rpc: wrapped, calls };
}

describe("createFinalityGate", () => {
  test("asks the node for the target once, then only re-polls the head", async () => {
    const { rpc, calls } = fakeRpc({ head: 119 });
    const gate = createFinalityGate({ rpc });

    expect(await gate.stateOf(61)).toBe("pending");
    expect(await gate.stateOf(61)).toBe("pending");
    expect(await gate.stateOf(61)).toBe("pending");

    expect(calls.macro).toBe(1);
    expect(calls.head).toBe(3);
  });

  test("goes final when the head reaches the node's target", async () => {
    let head = 100;
    const { rpc } = fakeRpc({ getHeadNumber: async () => head });
    const gate = createFinalityGate({ rpc });

    expect(await gate.isFinal(61)).toBe(false);
    head = 120;
    expect(await gate.isFinal(61)).toBe(true);
  });

  test("a node answering at or below the tx block is distrusted", async () => {
    const warned: unknown[][] = [];
    const { rpc } = fakeRpc({
      getMacroBlockAfter: async () => ({ number: 61 }), // not "after" 61
      getHeadNumber: async () => 119,
    });
    const gate = createFinalityGate({
      rpc,
      logger: { warn: (...a) => warned.push(a) },
    });

    // Falls back to local math (120), so 119 is still pending rather than final.
    expect(await gate.targetFor(61)).toBe(120);
    expect(await gate.stateOf(61)).toBe("pending");
    expect(warned.length).toBeGreaterThan(0);
  });

  test("a bare number answer is accepted", async () => {
    const { rpc } = fakeRpc({
      getMacroBlockAfter: async () => 120,
      getHeadNumber: async () => 120,
    });
    const gate = createFinalityGate({ rpc });
    expect(await gate.targetFor(61)).toBe(120);
    expect(await gate.isFinal(61)).toBe(true);
  });

  test("a throwing node falls back to local math by default", async () => {
    const { rpc } = fakeRpc({
      getMacroBlockAfter: async () => {
        throw new Error("Method not allowed");
      },
      getHeadNumber: async () => 120,
    });
    const gate = createFinalityGate({ rpc, logger: { warn: () => {} } });
    expect(await gate.isFinal(61)).toBe(true);
  });

  test("localFallback false makes an unanswerable node observed, not final", async () => {
    const { rpc } = fakeRpc({
      getMacroBlockAfter: async () => null,
      getHeadNumber: async () => 999_999,
    });
    const gate = createFinalityGate({ rpc, localFallback: false });
    expect(await gate.stateOf(61)).toBe("observed");
    expect(await gate.isFinal(61)).toBe(false);
  });

  test("an unreadable head is observed, never final", async () => {
    const { rpc } = fakeRpc({
      getHeadNumber: async () => {
        throw new Error("timeout");
      },
    });
    const gate = createFinalityGate({ rpc, logger: { warn: () => {} } });
    expect(await gate.stateOf(61)).toBe("observed");
  });

  test("a null head is observed, never final", async () => {
    const { rpc } = fakeRpc({ getHeadNumber: async () => null });
    const gate = createFinalityGate({ rpc });
    expect(await gate.stateOf(61)).toBe("observed");
  });

  test("prune drops targets below a height and keeps the rest", async () => {
    const { rpc, calls } = fakeRpc({ head: 0 });
    const gate = createFinalityGate({ rpc });

    await gate.targetFor(61);
    await gate.targetFor(500);
    expect(calls.macro).toBe(2);

    gate.prune(100);

    await gate.targetFor(500); // still cached
    expect(calls.macro).toBe(2);
    await gate.targetFor(61); // evicted, asked again
    expect(calls.macro).toBe(3);
  });

  test("a non-height tx block is observed without touching the node", async () => {
    const { rpc, calls } = fakeRpc({ head: 999 });
    const gate = createFinalityGate({ rpc });
    expect(await gate.stateOf(null)).toBe("observed");
    expect(await gate.stateOf(undefined)).toBe("observed");
    expect(calls.macro).toBe(0);
    expect(calls.head).toBe(0);
  });
});

describe("the gate and the math agree", () => {
  test("across a full epoch, node-backed and local verdicts match", async () => {
    const { rpc } = fakeRpc();
    for (let txBlock = 1; txBlock <= BLOCKS_PER_BATCH * 4; txBlock += 7) {
      for (const head of [txBlock, txBlock + 30, macroBlockAfter(txBlock) - 1, macroBlockAfter(txBlock)]) {
        const gate = createFinalityGate({ rpc: { ...rpc, getHeadNumber: async () => head } });
        expect(await gate.stateOf(txBlock)).toBe(finalityState(txBlock, head));
      }
    }
  });
});
