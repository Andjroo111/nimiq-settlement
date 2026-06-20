import { expect, test } from "bun:test";
import { createRpcSender } from "./rpc-sender";

/** A fake Albatross JSON-RPC node: returns handlers[method] wrapped in result.data. */
function fakeNode(handlers: Record<string, unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push({ method, params });
    return new Response(JSON.stringify({ jsonrpc: "2.0", result: { data: handlers[method], metadata: null }, id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

test("getHeadHeight unwraps getBlockNumber from result.data", async () => {
  const { fetchImpl, calls } = fakeNode({ getBlockNumber: 4242 });
  const s = createRpcSender({ url: "http://fake", fetchImpl });
  expect(await s.getHeadHeight()).toBe(4242);
  expect(calls[0]!.method).toBe("getBlockNumber");
});

test("sendRawTransaction posts the hex and returns the hash", async () => {
  const { fetchImpl, calls } = fakeNode({ sendRawTransaction: "abc123hash" });
  const s = createRpcSender({ url: "http://fake", fetchImpl });
  expect(await s.sendRawTransaction("deadbeef")).toBe("abc123hash");
  expect(calls[0]!.method).toBe("sendRawTransaction");
  expect(calls[0]!.params).toEqual(["deadbeef"]);
});

test("getBalance reads account.balance and defaults to 0 for a missing account", async () => {
  const { fetchImpl } = fakeNode({ getAccountByAddress: { balance: 700_000 } });
  expect(await createRpcSender({ url: "http://fake", fetchImpl }).getBalance("NQ..")).toBe(700_000);

  const { fetchImpl: f2 } = fakeNode({ getAccountByAddress: null });
  expect(await createRpcSender({ url: "http://fake", fetchImpl: f2 }).getBalance("NQ..")).toBe(0);
});

test("an rpc error rejects", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message: "boom" }, id: 1 }), { status: 200 });
  const s = createRpcSender({ url: "http://fake", fetchImpl });
  await expect(s.getHeadHeight()).rejects.toThrow(/boom/);
});
