import { listAccounts } from "../src/legacy/manager";

export async function verifiesAccountListing() {
  return listAccounts();
}
