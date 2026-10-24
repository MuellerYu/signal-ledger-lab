import { summaryFor } from "../../shared";

export const dynamic = "force-dynamic";

/** Small payload: no history, no per-holding rows. */
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const { response } = await summaryFor(slug.toLowerCase());
  return response;
}
