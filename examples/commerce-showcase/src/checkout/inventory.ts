import { authorizePayment } from "./payment";

export async function reserveInventory(input: unknown) {
  return authorizePayment(input);
}
