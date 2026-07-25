import { enqueue } from "./transport";

export async function notifyAccountOwner(account: unknown) {
  return enqueue("account-created", account);
}
