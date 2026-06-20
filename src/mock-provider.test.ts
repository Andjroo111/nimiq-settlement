import { expect, test } from "bun:test";
import { MockProvider, MOCK_ADDRESS, SIMULATED_SENDER_ADDRESS } from "./mock-provider";
import type { Settlement } from "./provider";

test("MockProvider is simulated and settles instantly as paid", async () => {
  const p = new MockProvider();
  expect(p.kind).toBe("mock");
  expect(p.simulated).toBe(true);
  expect(await p.getReceiveAddress()).toBe(MOCK_ADDRESS);

  const seen: Settlement[] = [];
  p.watch(
    { saleId: "s1", address: MOCK_ADDRESS, amountLuna: 100_000, reference: "app:abc" },
    (s) => seen.push(s),
  );
  await new Promise((r) => setTimeout(r, 5));

  expect(seen.length).toBe(1);
  expect(seen[0]!.status).toBe("paid");
  expect(seen[0]!.valueLuna).toBe(100_000);
  expect(seen[0]!.senderAddress).toBe(SIMULATED_SENDER_ADDRESS);
});

test("cancel before the tick prevents settlement", async () => {
  const p = new MockProvider();
  let fired = 0;
  const cancel = p.watch(
    { saleId: "s2", address: "x", amountLuna: 1, reference: "app:x" },
    () => fired++,
  );
  cancel();
  await new Promise((r) => setTimeout(r, 5));
  expect(fired).toBe(0);
});
