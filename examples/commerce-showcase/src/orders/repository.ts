import { PrismaClient } from "@prisma/client";
import { publishOrderCreated } from "./events";

const prisma = new PrismaClient();

export async function saveOrder(input: unknown) {
  await prisma.order.create({ data: { payload: input } });
  return publishOrderCreated(input);
}
