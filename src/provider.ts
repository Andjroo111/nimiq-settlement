// The ONLY surface an app uses to touch the chain for settlement. The app NEVER
// holds funds — the payer pays the recipient's address directly; a provider only
// WATCHES for that payment. Apps ship a MockProvider for dev/CI and swap in the
// live NimiqProvider (RPC block-scan) behind this same interface, with ZERO
// changes to routes or state machines.
//
// `asset` is an optional free-form rail tag (defaults to "NIM"). The NIM path
// ignores it; a future stablecoin rail can thread its own value through.

export interface PaymentRequest {
  /** App's opaque id for this payment (sale / invoice / tip id). */
  saleId: string;
  /** NQ.. address the payer pays (the recipient's, never the app's). */
  address: string;
  /** Expected amount in luna (1 NIM = 100_000 luna). */
  amountLuna: number;
  /** Short UTF-8 tx extraData that binds tx → request, e.g. "app:ab12cd34". */
  reference: string;
  /** Optional rail tag; absent ⇒ "NIM". */
  asset?: string;
}

export interface Settlement {
  saleId: string;
  txHash: string;
  /** epoch-ms when the payment was seen */
  detectedAt: number;
  /**
   * Settlement-state of THIS fire. Absent ⇒ treat as "paid" (mock/instant
   * confirm). The live provider stages "detected" (seen on-chain) then "paid"
   * (confirmed); callers MUST default a missing status to "paid".
   */
  status?: "detected" | "paid";
  /** Actual on-chain value received, in luna (>= amountLuna; overpay is recorded). */
  valueLuna?: number;
  /**
   * PUBLIC payer NQ.. address (the sender). On-chain public data, never a secret
   * — recorded so a recipient-initiated refund can prefill the payer's address.
   */
  senderAddress?: string;
  /** Rail tag; absent ⇒ "NIM". */
  asset?: string;
}

export interface SettlementProvider {
  readonly kind: "mock" | "nimiq";
  /** true ⇒ no real chain involved; UI must label everything SIMULATED. */
  readonly simulated: boolean;
  /** the recipient's receive address for new payment requests */
  getReceiveAddress(): Promise<string>;
  /**
   * Start watching for `req` to be paid. `onSettled` fires for each settlement-
   * state advance (at most once per status), terminating at "paid": the mock fires
   * once with no status (⇒ paid); the live provider may fire twice — first
   * "detected", then "paid". A missing status MUST be treated as "paid" to
   * preserve instant-confirm. Expiry NEVER fires onSettled.
   *
   * `onExpired` (optional) is invoked once when the per-request pay timeout elapses
   * while the entry is still unsettled. It never fires after a settlement.
   *
   * Returns an idempotent cancel function.
   */
  watch(
    req: PaymentRequest,
    onSettled: (s: Settlement) => void,
    onExpired?: (saleId: string, reference: string) => void,
  ): () => void;
}
