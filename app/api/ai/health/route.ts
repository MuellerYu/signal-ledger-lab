import { probeAiHealth } from "@/lib/valuation-ai";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await probeAiHealth();
  return Response.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
