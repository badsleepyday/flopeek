import { saveOrder } from "../orders/repository";
import { authorizeProvider } from "../payments/provider";

export async function authorizePayment(input: unknown) {
  await authorizeProvider(input);
  return saveOrder(input);
}
