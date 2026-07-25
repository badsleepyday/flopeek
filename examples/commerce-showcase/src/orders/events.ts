import { enqueueOrderCreated } from "../infrastructure/order-queue";

export async function publishOrderCreated(input: unknown) {
  return enqueueOrderCreated(input);
}
