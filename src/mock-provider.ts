// Instant-settle provider for local dev + CI: no chain, no network. On watch() it
// fires onSettled once as "paid" with a SIMULATED sender, so the whole app flow
// (arm → settle → UI flips green) runs hermetically. Every app's mock default
// uses this so the simulated path is identical fleet-wide.

import type { PaymentRequest, Settlement, SettlementProvider } from "./provider";

/** Fixed SIMULATED receive address (never a real wallet). */
export const MOCK_ADDRESS = "NQ07 0000 0000 0000 0000 0000 0000 0000 0000";
/** Fixed SIMULATED payer address forwarded as senderAddress. */
export const SIMULATED_SENDER_ADDRESS = "NQ07 9999 9999 9999 9999 9999 9999 9999 9999";

export class MockProvider implements SettlementProvider {
  readonly kind = "mock" as const;
  readonly simulated = true;

  constructor(private readonly address: string = MOCK_ADDRESS) {}

  async getReceiveAddress(): Promise<string> {
    return this.address;
  }

  watch(req: PaymentRequest, onSettled: (s: Settlement) => void): () => void {
    // Settle on the next tick so callers can wire up before it fires (mirrors the
    // async nature of the live provider; keeps cancel() meaningful).
    const t = setTimeout(() => {
      onSettled({
        saleId: req.saleId,
        txHash: `mock-${req.reference}`,
        detectedAt: Date.now(),
        status: "paid",
        valueLuna: req.amountLuna,
        senderAddress: SIMULATED_SENDER_ADDRESS,
        asset: req.asset ?? "NIM",
      });
    }, 0);
    return () => clearTimeout(t);
  }
}
