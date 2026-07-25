import { checkout } from "../../../checkout/checkout";

export async function POST(request: Request) {
  return Response.json(await checkout(await request.json()));
}
