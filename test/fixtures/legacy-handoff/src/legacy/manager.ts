import { loadAccounts, saveAccount } from "./helper";
import { notifyAccountOwner } from "../notifications/service";

export async function listAccounts() {
  return loadAccounts();
}

export async function createAccount(input: unknown) {
  const account = await saveAccount(input);
  await notifyAccountOwner(account);
  return account;
}
