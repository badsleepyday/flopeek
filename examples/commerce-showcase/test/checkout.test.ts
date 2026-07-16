import { checkout } from "../src/checkout/checkout";

export async function verifiesCheckoutFlow() {
  return checkout({ cartId: "demo-cart" });
}
