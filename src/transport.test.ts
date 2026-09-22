import { describe, expect, test } from "bun:test";
import {
  GENESIS_BLOCK,
  PENDING_PREFIX,
  RPC_ENDPOINTS,
  RpcRefusedError,
  classifyRpcError,
  createRateBudget,
  createRpcTransport,
  normaliseParams,
  pendingMessage,
  toRpcAddress,
} from "./transport";

const COMPACT = "NQ07000000000000000000000000000000000";
const SPACED = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
const GENESIS = "f".repeat(64);

describe("endpoints and constants", () => {
  test("the chain has a fallback, and nimiqwatch is not alone", () => {
    expect(RPC_ENDPOINTS.main[0]).toBe("https://rpc.nimiqwatch.com");
    expect(RPC_ENDPOINTS.main.length).toBeGreaterThan(1);
  });
  test("genesis is the PoS takeover height, not 0", () => {
    expect(GENESIS_BLOCK.main).toBe(3_456_000);
    expect(GENESIS_BLOCK.test).toBe(3_032_010);
  });
});

describe("address normalisation", () => {
  test("compact becomes spaced, spaced stays spaced", () => {
    expect(toRpcAddress(COMPACT.slice(0, 36))).toBe(SPACED);
    expect(toRpcAddress(SPACED)).toBe(SPACED);
    expect(toRpcAddress(SPACED.toLowerCase())).toBe(SPACED);
  });
  test("a non-address is left alone", () => {
    expect(toRpcAddress("deadbeef")).toBe("deadbeef");
    expect(toRpcAddress("")).toBe("");
  });
  test("rewrites addresses anywhere in params", () => {
    expect(normaliseParams([COMPACT.slice(0, 36), 25])).toEqual([SPACED, 25]);
    expect(normaliseParams({ address: COMPACT.slice(0, 36), n: 1 })).toEqual({ address: SPACED, n: 1 });
    expect(normaliseParams([{ deep: [COMPACT.slice(0, 36)] }])).toEqual([{ deep: [SPACED] }]);
  });
});

describe("classifyRpcError", () => {
  test("a user refusal is cancelled, never retry", () => {
    for (const m of ["User rejected the request", "Request denied", "cancelled by user", "User closed the window"]) {
      expect(classifyRpcError(new Error(m))).toBe("cancelled");
    }
  });
  test("cancellation wins over a transient word in the same message", () => {
    // Retrying this re-prompts a user who already said no.
    expect(classifyRpcError(new Error("request cancelled while syncing"))).toBe("cancelled");
  });
  test("sync, rate limit and network trouble are retry", () => {
    for (const m of ["still syncing your account", "consensus not established", "429 Too Many Requests", "fetch failed", "ETIMEDOUT"]) {
      expect(classifyRpcError(new Error(m))).toBe("retry");
    }
  });
  test("anything else is terminal, not optimistically retried", () => {
    expect(classifyRpcError(new Error("Insufficient funds"))).toBe("terminal");
    expect(classifyRpcError("Invalid address")).toBe("terminal");
    expect(classifyRpcError(null)).toBe("terminal");
    expect(classifyRpcError({ message: "Bad signature" })).toBe("terminal");
  });
});

describe("the PENDING: protocol stays off until a reader exists", () => {
  test("off by default, so no client sees an unrecognised prefix", () => {
    expect(pendingMessage("Transaction not found on-chain yet", false)).toBe("Transaction not found on-chain yet");
  });
  test("on, it emits the exact case-sensitive literal", () => {
    expect(pendingMessage("Transaction not found on-chain yet", true)).toBe(
      "PENDING: Transaction not found on-chain yet",
    );
    expect(PENDING_PREFIX).toBe("PENDING:");
    // The reading half matches case-sensitively. Lower case would classify as a
    // hard failure and stop the client polling.
    expect(PENDING_PREFIX).not.toBe("pending:");
  });
});

describe("createRateBudget", () => {
  test("an unknown budget sends rather than deadlocking", () => {
    const b = createRateBudget();
    expect(b.reserve()).toBe(true);
  });

  test("spends down to zero and then refuses", () => {
    let t = 0;
    const b = createRateBudget({ defaultLimit: 3, windowMs: 10_000, now: () => t });
    expect(b.reserve()).toBe(true); // 2 left
    expect(b.reserve()).toBe(true); // 1
    expect(b.reserve()).toBe(true); // 0
    expect(b.reserve()).toBe(false);
    expect(b.state().remaining).toBe(0);
  });

  test("the window rolls, it does not refill inside itself", () => {
    let t = 0;
    const b = createRateBudget({ defaultLimit: 2, windowMs: 10_000, now: () => t });
    b.reserve();
    b.reserve();
    expect(b.reserve()).toBe(false);
    t = 9_999; // still the same fixed window
    expect(b.reserve()).toBe(false);
    t = 10_000; // next window opens
    expect(b.reserve()).toBe(true);
  });

  test("the LOWER remaining wins, because another caller shares the IP", () => {
    let t = 0;
    const b = createRateBudget({ defaultLimit: 20, now: () => t });
    b.reserve(); // remaining 19
    b.observe(new Headers({ "X-RateLimit-Remaining": "4" }));
    expect(b.state().remaining).toBe(4);
    // A higher number does not raise it back inside the window.
    b.observe(new Headers({ "X-RateLimit-Remaining": "18" }));
    expect(b.state().remaining).toBe(4);
  });

  test("Reset is the unix SECOND the next window opens", () => {
    let t = 0;
    const b = createRateBudget({ now: () => t });
    b.observe(new Headers({ "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "50" }));
    expect(b.state().resetAtMs).toBe(50_000);
    expect(b.reserve()).toBe(false);
    t = 50_000;
    expect(b.reserve()).toBe(true);
  });

  test("garbage headers are ignored rather than trusted", () => {
    const b = createRateBudget();
    b.observe(new Headers({ "X-RateLimit-Remaining": "nope" }));
    expect(b.state().remaining).toBe(null);
  });
});

/** A node whose replies and headers the test controls. */
function node(
  handler: (method: string, params: unknown[], url: string) => unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const seen: { url: string; method: string; params: unknown }[] = [];
  const fetchImpl = async (url: string, req?: RequestInit) => {
    const body = JSON.parse(String(req?.body));
    seen.push({ url, method: body.method, params: body.params });
    const out = handler(body.method, body.params, url);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  };
  return { fetchImpl, seen };
}

const ok = (data: unknown) => ({ jsonrpc: "2.0", id: 1, result: { data, metadata: null } });

describe("createRpcTransport", () => {
  test("unwraps result.data and normalises addresses on the way out", async () => {
    const { fetchImpl, seen } = node(() => ok({ balance: 5 }));
    const t = createRpcTransport({ network: "main", fetchImpl });
    expect(await t.call<{ balance: number }>("getAccountByAddress", [COMPACT.slice(0, 36)])).toEqual({ balance: 5 });
    expect(seen[0]!.params).toEqual([SPACED]);
  });

  test("falls over to the next endpoint, and remembers which answered", async () => {
    const { fetchImpl, seen } = node((_m, _p, url) =>
      url.includes("nimiqwatch") ? new Error("fetch failed") : ok(7),
    );
    const t = createRpcTransport({ network: "main", fetchImpl, logger: { warn: () => {} } });
    expect(await t.call<number>("getBlockNumber")).toBe(7);
    expect(seen.map((s) => s.url)).toEqual([...RPC_ENDPOINTS.main]);
    expect(t.lastUrl()).toBe(RPC_ENDPOINTS.main[1]!);
  });

  test("a user cancellation is NOT retried against the next endpoint", async () => {
    const { fetchImpl, seen } = node(() => new Error("User rejected the request"));
    const t = createRpcTransport({ network: "main", fetchImpl, logger: { warn: () => {} } });
    await expect(t.call("getBlockNumber")).rejects.toThrow(/rejected/i);
    expect(seen.length).toBe(1);
  });

  test("surfaces error.data instead of a useless Internal error", async () => {
    const { fetchImpl } = node(() => ({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal error", data: "Transaction not found" },
    }));
    const t = createRpcTransport({ network: "main", urls: ["https://one"], fetchImpl, logger: { warn: () => {} } });
    await expect(t.call("getTransactionByHash", ["x"])).rejects.toThrow(/Transaction not found/);
  });

  test("a method off the allowlist never reaches the network", async () => {
    const { fetchImpl, seen } = node(() => ok(1));
    const t = createRpcTransport({
      network: "main",
      fetchImpl,
      allowlist: ["getAccountByAddress"],
    });
    await expect(t.call("sendRawTransaction", ["ff"])).rejects.toBeInstanceOf(RpcRefusedError);
    expect(seen.length).toBe(0);
  });

  test("an exhausted budget refuses without trying every endpoint", async () => {
    const { fetchImpl, seen } = node(() => ok(1));
    const budget = createRateBudget({ defaultLimit: 1 });
    budget.exhaust();
    const t = createRpcTransport({ network: "main", fetchImpl, budget });
    await expect(t.call("getBlockNumber")).rejects.toBeInstanceOf(RpcRefusedError);
    expect(seen.length).toBe(0);
  });

  test("a 429 marks the window spent", async () => {
    const { fetchImpl } = node(() => ok(1), { status: 429 });
    const budget = createRateBudget();
    const t = createRpcTransport({ network: "main", urls: ["https://one"], fetchImpl, budget, logger: { warn: () => {} } });
    await expect(t.call("getBlockNumber")).rejects.toThrow(/429/);
    expect(budget.state().remaining).toBe(0);
  });

  test("reads the budget off response headers", async () => {
    const { fetchImpl } = node(() => ok(1), { headers: { "X-RateLimit-Remaining": "2" } });
    const budget = createRateBudget();
    const t = createRpcTransport({ network: "main", fetchImpl, budget });
    await t.call("getBlockNumber");
    expect(budget.state().remaining).toBe(2);
  });
});

describe("network proof", () => {
  test("a matching genesis hash proves the network", async () => {
    const { fetchImpl, seen } = node((m, p) =>
      m === "getBlockByNumber" && (p as number[])[0] === GENESIS_BLOCK.main ? ok({ hash: GENESIS }) : ok(null),
    );
    const t = createRpcTransport({ network: "main", fetchImpl, expectedGenesisHash: GENESIS });
    expect((await t.proveNetwork()).state).toBe("proven");
    // Asked for the PoS genesis height, not block 0.
    expect((seen[0]!.params as number[])[0]).toBe(3_456_000);
  });

  test("a WRONG chain latches rejected and blocks every later call", async () => {
    const { fetchImpl } = node(() => ok({ hash: "a".repeat(64) }));
    const t = createRpcTransport({
      network: "main",
      fetchImpl,
      expectedGenesisHash: GENESIS,
      logger: { warn: () => {} },
    });
    const p = await t.proveNetwork();
    expect(p.state).toBe("rejected");
    await expect(t.call("getBlockNumber")).rejects.toBeInstanceOf(RpcRefusedError);
    // Latched: a second look does not re-open it.
    expect((await t.proveNetwork()).state).toBe("rejected");
  });

  test("an UNREADABLE node is unproven, not rejected", async () => {
    const { fetchImpl } = node(() => new Error("fetch failed"));
    const t = createRpcTransport({
      network: "main",
      fetchImpl,
      expectedGenesisHash: GENESIS,
      logger: { warn: () => {} },
    });
    expect((await t.proveNetwork()).state).toBe("unproven");
    // Not latched, so a blip does not take the fleet down permanently.
    expect(t.proof().state).toBe("unproven");
  });

  test("requireProof blocks calls until the chain is proven", async () => {
    const { fetchImpl } = node(() => new Error("fetch failed"));
    const t = createRpcTransport({
      network: "main",
      fetchImpl,
      expectedGenesisHash: GENESIS,
      requireProof: true,
      logger: { warn: () => {} },
    });
    await expect(t.call("getBlockNumber")).rejects.toBeInstanceOf(RpcRefusedError);
  });

  test("without an expected hash the network is never proven, and that is explicit", async () => {
    const { fetchImpl } = node(() => ok({ hash: GENESIS }));
    const t = createRpcTransport({ network: "main", fetchImpl });
    expect((await t.proveNetwork()).state).toBe("unproven");
  });

  test("the proof is fetched once, not per call", async () => {
    const { fetchImpl, seen } = node(() => ok({ hash: GENESIS }));
    const t = createRpcTransport({ network: "main", fetchImpl, expectedGenesisHash: GENESIS });
    await t.proveNetwork();
    await t.proveNetwork();
    await t.proveNetwork();
    expect(seen.filter((s) => s.method === "getBlockByNumber").length).toBe(1);
  });
});

describe("the dependency-free invariant", () => {
  /**
   * The app shell's `balance.ts` carries a standing rule: settlement asking to
   * be a dependency gets "no". E1 is making ONE exception so the shell can
   * import RPC_ENDPOINTS instead of hardcoding the literal, and that exception
   * rests entirely on this file importing nothing and tree-shaking to a
   * constant.
   *
   * So this is a test, not a comment. The day transport.ts grows an import,
   * this fails here rather than as a surprise in the shell's bundle size.
   */
  test("transport.ts imports nothing at all", async () => {
    const src = await Bun.file(new URL("./transport.ts", import.meta.url)).text();
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(
        ({ line }) =>
          /^import\s/.test(line) ||
          /^export\s+(\*|\{[^}]*\})\s+from\s/.test(line) ||
          /\brequire\s*\(/.test(line) ||
          /\bawait\s+import\s*\(/.test(line),
      );
    expect(offenders).toEqual([]);
  });

  test("the guard can actually fail", () => {
    // Proves the matcher above is load-bearing rather than a regex that never fires.
    const fake = ['import { x } from "./y";', 'const a = require("z");', 'await import("./q");'];
    for (const line of fake) {
      const hit =
        /^import\s/.test(line) || /\brequire\s*\(/.test(line) || /\bawait\s+import\s*\(/.test(line);
      expect(hit).toBe(true);
    }
  });
});
