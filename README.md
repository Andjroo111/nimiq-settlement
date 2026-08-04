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
| `createRpcSender` | point queries + broadcast: head height, balance, `sendRawTransaction` |
| `createHtlcAwareBalance` | **display-path** balance that adds back NIM locked in Nimiq Pay swap HTLCs |
| `MockProvider` | hermetic instant-settle for dev/CI |

## Planned

- **Multi-provider chain watching** — one normalized tx shape behind an N-provider list, WebSocket
  push preferred, polling as automatic fallback. Direction set 2026-08-04; design note and the
  60-hour outage that motivates it are in [`docs/MULTI-PROVIDER.md`](docs/MULTI-PROVIDER.md).
  Not built.

## HTLC-aware balance

A Nimiq Pay user's basic account balance **under-reports**, sometimes all the way to zero,
whenever Pay has locked their NIM in a swap HTLC. Any screen built on `getAccountByAddress`
alone will tell a solvent user they are broke. `createHtlcAwareBalance` walks the address's
history, finds the HTLC contracts it funded, and adds back the ones still ours.

```ts
import { createHtlcAwareBalance } from "nimiq-settlement";

const balances = createHtlcAwareBalance({ url: process.env.MYAPP_RPC_URL! });
const { totalLuna, htlcLuna, complete } = await balances.read(address);

// Many addresses, with an explicit count of the ones it could not finish:
const report = await balances.readMany(addresses);
if (report.unreadableCount > 0) { /* the total is a floor, not a fact */ }
```

Four things to know before you wire it up:

- **Display only.** Never gate a spend or a credit on it. Proving a movement by re-reading
  both balances afterwards is strictly stronger than any balance snapshot, HTLC-aware or
  not. `nimiq.kids#276` deleted an affordability pre-check rather than make it cleverer.
- **Cache it yourself.** Measured on our mainnet node: `getAccountByAddress` ~0.35s,
  `getTransactionsByAddress` **~13.3s**. That is unshippable inline on a request handler, so
  put it behind the cache your screen already has and refresh in the background. The module
  does no caching of its own, because the right TTL is a property of the screen.
- **It needs a history node.** A validator or other non-history node cannot answer
  `getTransactionsByAddress` at all, and silently returning the basic balance there is the
  exact under-report this exists to fix. So it **throws** by default. Pass
  `onDegraded: "report"` to get the partial read with `complete: false` and a reason instead.
- **Ownership gate:** an HTLC counts only when its `sender` is you and its `timeout` has not
  passed. `timeout` is a **millisecond timestamp**, not a block height (measured on mainnet;
  the `@nimiq/core` type does not say). Expired HTLCs you funded that still hold a balance
  are reported separately as `reclaimableLuna`, outside `totalLuna`.

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
