import { Queue } from "bullmq";

const orders = new Queue("orders");

export async function enqueueOrderCreated(input: unknown) {
  return orders.add("order.created", input);
}
