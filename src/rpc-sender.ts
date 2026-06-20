// RPC sender — the WRITE/QUERY half of the settlement seam. Where RpcNimiqClient
// WATCHES for incoming payments (read-only forward block-scan), this BROADCASTS a
// signed transaction and answers point queries (head height, balance) over the
// SAME Albatross JSON-RPC node. Apps build + sign txs with OFFLINE @nimiq/core,
// then hand the serialized hex here — the @nimiq/core light-client is never used.
//
// RPC (verified against a live Albatross node): JSON-RPC 2.0 over HTTP POST,
// results wrapped in result.data.
//   getBlockNumber()           -> head height (number)
//   sendRawTransaction(hex)    -> tx hash (hex string)
//   getAccountByAddress(addr)  -> { balance: number (luna), ... }

import type { FetchLike } from "./nimiq-rpc-client";

export interface RpcSenderOptions {
  /** Node JSON-RPC base, e.g. http://127.0.0.1:8648 */
  url: string;
  /** Per-RPC timeout in ms. Default 15000. */
  rpcTimeoutMs?: number;
  /** Injectable fetch (tests). Default global fetch. */
  fetchImpl?: FetchLike;
}

export interface RpcSender {
  /** Current head block height (for a tx's validityStartHeight). */
  getHeadHeight(): Promise<number>;
  /** Broadcast a serialized signed tx (hex). Returns the tx hash (hex). */
  sendRawTransaction(rawTxHex: string): Promise<string>;
  /** Account balance in luna (0 if the account does not exist yet). */
  getBalance(address: string): Promise<number>;
}

export function createRpcSender(opts: RpcSenderOptions): RpcSender {
  const url = opts.url;
  const timeoutMs = Math.max(1000, opts.rpcTimeoutMs ?? 15000);
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: { data?: T }; error?: unknown };
      if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      return json.result?.data as T;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    getHeadHeight: () => rpc<number>("getBlockNumber", []),
    sendRawTransaction: (rawTxHex) => rpc<string>("sendRawTransaction", [rawTxHex]),
    getBalance: async (address) => {
      const acct = await rpc<{ balance?: number } | null>("getAccountByAddress", [address]);
      return acct?.balance ?? 0;
    },
  };
}
