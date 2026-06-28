# nimiq-settlement

<!-- nimiq-north-star -->
> 🧭 **North Star** · Every Nimiq project aligns to one shared set of values and a single mission. See the canonical [Nimiq Values & North Star](https://github.com/Andjroo111/nimiq.life/blob/main/NORTH-STAR.md).

The shared on-chain settlement core for the Nimiq app fleet. Extracted from
`nimiq-pos` (SnapPOS), which proved this code live on mainnet. One seam, one
proven RPC block-scan client, one matcher — so every app reads the chain the same
way instead of re-deriving it.

## Why this exists

The `@nimiq/core` light-client does **not** run on our hosts (WASM
`addEventListener` bug under Node; dropped `config` in the Bun worker
`postMessage`). The working path is to **forward-scan Albatross JSON-RPC blocks**
against a self-hosted node. That client lived in `nimiq-pos`; this package makes it
shared so `@nimiq/core` is only ever used for **offline crypto** (address / tx
construction / signing), never for chain reads.

## What's in it

| Export | Role |
|--------|------|
| `SettlementProvider`, `PaymentRequest`, `Settlement` | the only surface an app uses to watch for a payment (non-custodial) |
| `NimiqProvider` | binds matched txs → requests, stages `detected → paid`, handles expiry/backfill |
| `NimiqClientLike`, `TxDetails` | the client seam the provider consumes (real or fake) |
| `RpcNimiqClient` / `createRpcClient` | production client: forward block-scan over Albatross JSON-RPC |
| `matchTransaction`, `hexToUtf8` | the pure matcher (recipient + amount guard + hex→utf8 reference) |
| `MockProvider` | hermetic instant-settle for dev/CI |

## Consume it

These are no-bundler Bun apps, so import the TypeScript directly via a git
dependency (no publish step):

```jsonc
// package.json
{ "dependencies": { "nimiq-settlement": "github:Andjroo111/nimiq-settlement#v0.1.0" } }
```

Then wire your own env-driven factory (`noop | mock | rpc`) per app — the package
provides the building blocks; the app owns the env var names and its
`reference` convention (`app:<id>`):

```ts
import { MockProvider, NimiqProvider, createRpcClient } from "nimiq-settlement";

export function providerFromEnv(receiveAddress: string) {
  const mode = (process.env.MYAPP_NIMIQ_MODE ?? "mock").toLowerCase();
  if (mode !== "rpc") return new MockProvider(receiveAddress);
  return new NimiqProvider({
    merchantAddress: receiveAddress,
    clientFactory: async () =>
      createRpcClient({ url: process.env.MYAPP_RPC_URL ?? "http://127.0.0.1:8648" }),
  });
}
```

## RPC contract (verified against a live MainAlbatross node)

JSON-RPC 2.0 over HTTP POST; results wrapped in `result.data`. Reads
`getBlockNumber`, `getBlockByNumber(n, true)`, `isConsensusEstablished`,
`getTransactionByHash`. Tx fields: `hash, from, to, value (luna),
recipientData (hex memo), confirmations, executionResult, blockNumber`. State is
synthesized from confirmation depth: first sighting → `included` (fires
`detected`); `>= confirmations`, re-verified → `confirmed` (fires `paid`).

## Develop

```bash
bun install
bun run check   # tsc --noEmit
bun test        # the proven matcher + provider + rpc-client suites
```
