import { REPORT_PDFS } from "@/lib/report-pdfs";
import { requirePro, upgradeRequired } from "@/lib/access";

export const dynamic = "force-dynamic";

/**
 * The only way to read a Signal Ledger report. The PDF bytes live in
 * lib/report-pdfs.ts (not public/), so there is no unauthenticated URL; this
 * route gates every download to PRO on the server.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  if (!(await requirePro())) return upgradeRequired();

  const { file } = await params;
  const pdf = REPORT_PDFS[file];
  if (!pdf) {
    return Response.json(
      { schema: "signal-ledger.reports.v1", error: "not_found", message: "No report matches that file." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new Response(pdf.data as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": pdf.mime,
      "Content-Length": String(pdf.bytes),
      "Content-Disposition": `inline; filename="${file}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
