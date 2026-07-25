import { saveOrder } from "../orders/repository";

export async function reviewRisk(input: unknown) {
  return saveOrder(input);
}
