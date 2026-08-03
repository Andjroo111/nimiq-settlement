// nimiq-settlement — the shared Nimiq settlement core for the app fleet.
//
// One seam (NimiqClientLike) with two implementations:
//   - RpcNimiqClient: production, forward-scans Albatross JSON-RPC blocks (works on
//     our hosts; the @nimiq/core light-client does not).
//   - a fake/injected client in tests.
// The NimiqProvider binds matched txs to PaymentRequests and stages detected → paid.
// MockProvider gives a hermetic instant-settle path for dev/CI.
//
// `@nimiq/core` is for OFFLINE crypto only (address/tx construction/signing) in the
// apps; chain READS go through this package. Never import @nimiq/core/web here.
//
// createHtlcAwareBalance is the DISPLAY-path read: a basic balance under-reports whenever
// Nimiq Pay has NIM locked in a swap HTLC, so a screen built on getAccountByAddress alone
// tells solvent users they are broke. It is never a spend gate.

export type { PaymentRequest, Settlement, SettlementProvider } from "./provider";

export {
  NimiqProvider,
  hexToUtf8,
  matchTransaction,
  type NimiqClientLike,
  type TxDetails,
  type MatchResult,
  type NimiqProviderOptions,
} from "./nimiq-provider";

export {
  RpcNimiqClient,
  createRpcClient,
  type RpcClientOptions,
  type FetchLike,
} from "./nimiq-rpc-client";

export {
  createRpcSender,
  type RpcSender,
  type RpcSenderOptions,
} from "./rpc-sender";

export {
  createHtlcAwareBalance,
  compactAddress,
  spaceAddress,
  ACCOUNT_TYPE_HTLC,
  type HtlcAwareBalance,
  type HtlcBalanceOptions,
  type HtlcBalanceReport,
  type AddressBalance,
  type HtlcAccount,
  type HistoryTx,
  type IncompleteReason,
} from "./htlc-balance";

export { MockProvider, MOCK_ADDRESS, SIMULATED_SENDER_ADDRESS } from "./mock-provider";
