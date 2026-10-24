import { getStats } from "../../../lib/stats.mjs";
export const dynamic = "force-dynamic";
export async function GET() {
  const result = await getStats();
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
