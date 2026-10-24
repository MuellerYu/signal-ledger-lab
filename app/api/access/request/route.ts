export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json({
    ok: true,
    status: "public",
    message: "Signal Ledger is publicly accessible. No approval is required.",
  });
}
