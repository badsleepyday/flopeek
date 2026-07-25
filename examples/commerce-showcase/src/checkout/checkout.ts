import { validateCart } from "./cart";
import { loadDiscountRule } from "./discount";
import { reserveInventory } from "./inventory";

export async function checkout(input: unknown) {
  await loadDiscountRule("standard");
  validateCart(input);
  return reserveInventory(input);
}
