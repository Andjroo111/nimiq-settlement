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
// Settlement is gated on ALBATROSS FINALITY (the macro block after the tx),
// never on a confirmation count. `RpcClientOptions.confirmations` was removed in
// v1.0: it could report money as paid before its batch was committed.
//
// The RPC transport owns the endpoint chain, so nothing downstream hardcodes
// rpc.nimiqwatch.com. It proves which chain a node serves before trusting it,
// reserves against the per-IP rate budget before sending, and classifies a
// failure as retry / cancelled / terminal. The PENDING: wire prefix is OFF by
// default: no app in the fleet ships a reader for it yet.
//
// Finding a tx is three places, not one: mined, then mempool, then the expected
// address's own history. A wallet return value is resolved to a hash or REFUSED,
// never guessed, because guessing is what caused double-sends in the field.
//
// createHtlcAwareBalance is the DISPLAY-path read: a basic balance under-reports whenever
// Nimiq Pay has NIM locked in a swap HTLC, so a screen built on getAccountByAddress alone
// tells solvent users they are broke. It is never a spend gate.

export {
  BLOCKS_PER_BATCH,
  BATCHES_PER_EPOCH,
  TX_VALIDITY_WINDOW_BLOCKS,
  NETWORKS,
  lastMacroBlock,
  macroBlockAfter,
  isMacroBlock,
  isElectionBlock,
  batchOf,
  blocksUntilFinal,
  finalityState,
  createFinalityGate,
  type NetworkName,
  type FinalityState,
  type FinalityRpc,
  type FinalityGate,
  type FinalityGateOptions,
} from "./finality";

export {
  resolveHandle,
  createLookup,
  normalizeTx,
  unwrapRpcResult,
  type LookupState,
  type LookupResult,
  type ChainTx,
  type Handle,
  type Expectation,
  type TxHashDeriver,
  type LookupRpc,
  type LookupOptions,
  type Lookup,
} from "./lookup";

export {
  RPC_ENDPOINTS,
  GENESIS_BLOCK,
  PENDING_PREFIX,
  RpcRefusedError,
  toRpcAddress,
  normaliseParams,
  classifyRpcError,
  pendingMessage,
  createRateBudget,
  createRpcTransport,
  type ErrorClass,
  type NetworkProof,
  type RateBudget,
  type RateBudgetOptions,
  type RpcTransport,
  type RpcTransportOptions,
} from "./transport";

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
