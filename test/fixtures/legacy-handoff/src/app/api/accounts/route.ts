import { createAccount, listAccounts } from "../../../legacy/manager";

export async function GET() {
  return Response.json(await listAccounts());
}

export async function POST(request: Request) {
  return Response.json(await createAccount(await request.json()));
}
