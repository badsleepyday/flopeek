import { formatResponse } from "../../../../../../packages/shared/src/utils";

export async function GET() {
  return formatResponse({ ok: true });
}
