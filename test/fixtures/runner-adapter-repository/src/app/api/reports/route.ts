export async function GET() {
  return Response.json({ report: "available" }, { status: 200 });
}
