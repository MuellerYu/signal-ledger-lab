import { isAuthorizedMutation, unauthorizedResponse } from "@/lib/auth";
import { resolveMember } from "@/lib/member-session";
import { isSiteOwnerEmail, siteOwnerEmail } from "@/lib/site-access";
import { isLaunchTicker } from "@/lib/launch-universe";
import { isLocalOwnerPreviewRequest } from "@/lib/local-owner-preview";
import { loadSecEvidence } from "@/lib/valuation-data";
import { computeOwnerForecastTree, matchesReportedBusinessAnchor, seedOwnerForecastTree, type OwnerForecastTree } from "@/lib/owner-forecast-tree";
import { ensureOwnerForecastTables, loadCompanyBusinessEvidence, loadOwnerDraft, loadPublishedOwnerForecast, ownerForecastDb, publishOwnerDraft, saveOwnerDraft, saveCompanyBusinessEvidence } from "@/lib/owner-forecast-store";

export const dynamic = "force-dynamic";

async function owner(request: Request) {
  if (isLocalOwnerPreviewRequest(request)) return siteOwnerEmail();
  const member = await resolveMember();
  if (member.authenticated && member.email && isSiteOwnerEmail(member.email)) return member.email;
  return isAuthorizedMutation(request) ? siteOwnerEmail() : null;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin && origin === new URL(request.url).origin;
}

export async function GET(request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  if (!await owner(request)) return unauthorizedResponse();
  const ticker = (await params).ticker.toUpperCase();
  if (!isLaunchTicker(ticker)) return Response.json({ error: "Ticker is outside the launch coverage queue." }, { status: 404 });
  const db = ownerForecastDb();
  if (!db) return Response.json({ error: "Owner research storage is unavailable." }, { status: 503 });
  await ensureOwnerForecastTables(db);
  const draft = await loadOwnerDraft(db, ticker);
  const published = await loadPublishedOwnerForecast(ticker);
  const cachedEvidence = await loadCompanyBusinessEvidence(ticker);
  if (draft) return Response.json({ ticker, revision: draft.revision, tree: draft.tree,
    preview: computeOwnerForecastTree(draft.tree),
    newFiling: Boolean(cachedEvidence?.evidence.accessionNumber && cachedEvidence.evidence.accessionNumber !== draft.tree.source.accessionNumber),
    published: published && { id: published.id, revision: published.revision, publishedAt: published.publishedAt } },
    { headers: { "Cache-Control": "private, no-store" } });
  try {
    const recent = cachedEvidence && Date.now() - cachedEvidence.fetchedAt < 12 * 60 * 60 * 1_000 ? cachedEvidence : null;
    const evidence = recent ? null : await loadSecEvidence(ticker);
    if (evidence) await saveCompanyBusinessEvidence(db, ticker, evidence.cik, evidence.entityName ?? ticker, evidence.reportedBusinesses);
    const basis = recent ?? { cik: evidence!.cik, issuerName: evidence!.entityName ?? ticker, evidence: evidence!.reportedBusinesses };
    const tree = seedOwnerForecastTree(ticker, basis.issuerName, basis.cik, basis.evidence, null);
    return Response.json({ ticker, revision: 0, tree, evidenceStatus: basis.evidence.status,
      evidenceReason: basis.evidence.reason,
      preview: tree && computeOwnerForecastTree(tree), published: published && { id: published.id, revision: published.revision, publishedAt: published.publishedAt } },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ ticker, revision: 0, tree: null, evidenceStatus: "unavailable",
      evidenceReason: error instanceof Error ? error.message : "SEC evidence is unavailable.", published: null },
      { headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const actor = await owner(request);
  if (!actor) return unauthorizedResponse();
  if (!sameOrigin(request) && !isAuthorizedMutation(request)) return unauthorizedResponse();
  const ticker = (await params).ticker.toUpperCase();
  if (!isLaunchTicker(ticker)) return Response.json({ error: "Ticker is outside the launch coverage queue." }, { status: 404 });
  const db = ownerForecastDb();
  if (!db) return Response.json({ error: "Owner research storage is unavailable." }, { status: 503 });
  const raw = await request.text();
  if (raw.length > 100_000) return Response.json({ error: "Forecast tree is too large." }, { status: 413 });
  let body: { action?: string; revision?: number; tree?: OwnerForecastTree };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  await ensureOwnerForecastTables(db);
  if (body.action === "rebase") {
    const draft = await loadOwnerDraft(db, ticker);
    if ((draft?.revision ?? 0) !== body.revision) return Response.json({ error: "Draft changed in another session; reload before refreshing." }, { status: 409 });
    const evidence = await loadSecEvidence(ticker).catch(() => null);
    if (!evidence) return Response.json({ error: "Latest SEC filing could not be loaded." }, { status: 503 });
    await saveCompanyBusinessEvidence(db, ticker, evidence.cik, evidence.entityName ?? ticker, evidence.reportedBusinesses);
    const tree = seedOwnerForecastTree(ticker, evidence.entityName ?? ticker, evidence.cik, evidence.reportedBusinesses,
      draft?.tree.dilutedSharesB ?? null);
    if (!tree) return Response.json({ error: "Latest SEC business split is not verified.", reason: evidence.reportedBusinesses.reason }, { status: 422 });
    if (draft) {
      tree.horizonYears = draft.tree.horizonYears;
      tree.discountRate = draft.tree.discountRate;
      tree.netCashB = draft.tree.netCashB;
      if (tree.source.periodForm === draft.tree.source.periodForm) tree.annualizationFactor = draft.tree.annualizationFactor;
      tree.businesses = tree.businesses.map((node) => {
        const prior = draft.tree.businesses.find((old) => old.parentId === null && old.name === node.name);
        return prior ? { ...node, driver: prior.driver, annualGrowth: prior.annualGrowth,
          quantityYearOne: prior.quantityYearOne, unitPriceUsdYearOne: prior.unitPriceUsdYearOne,
          quantityGrowth: prior.quantityGrowth, unitPriceGrowth: prior.unitPriceGrowth,
          netMargin: prior.netMargin, pe: prior.pe, note: prior.note } : node;
      });
    }
    const revision = await saveOwnerDraft(db, tree, draft?.revision ?? 0, actor);
    return revision === null ? Response.json({ error: "Draft changed in another session; reload before refreshing." }, { status: 409 })
      : Response.json({ revision, tree, preview: computeOwnerForecastTree(tree) }, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (body.action === "save") {
    if (!body.tree || body.tree.ticker !== ticker || body.tree.schemaVersion !== 1 || !Array.isArray(body.tree.businesses) ||
      body.tree.businesses.length > 40 || !body.tree.source?.url?.startsWith("https://www.sec.gov/"))
      return Response.json({ error: "Invalid forecast tree." }, { status: 422 });
    const revision = await saveOwnerDraft(db, body.tree, body.revision ?? -1, actor);
    return revision === null
      ? Response.json({ error: "Draft changed in another session; reload before saving." }, { status: 409 })
      : Response.json({ revision, preview: computeOwnerForecastTree(body.tree) }, { headers: { "Cache-Control": "private, no-store" } });
  }
  if (body.action === "publish") {
    const draft = await loadOwnerDraft(db, ticker);
    if (!draft || draft.revision !== body.revision) return Response.json({ error: "Save the current draft before publishing." }, { status: 409 });
    const preview = computeOwnerForecastTree(draft.tree);
    if (!preview.ready) return Response.json({ error: "The forecast has missing or inconsistent inputs.", issues: preview.issues }, { status: 422 });
    const evidence = await loadSecEvidence(ticker).catch(() => null);
    if (!evidence || !matchesReportedBusinessAnchor(draft.tree, evidence.cik, evidence.reportedBusinesses))
      return Response.json({ error: "The current SEC filing or reported business rows differ from this draft. Refresh its evidence before publishing." }, { status: 409 });
    await saveCompanyBusinessEvidence(db, ticker, evidence.cik, evidence.entityName ?? ticker, evidence.reportedBusinesses);
    const published = await publishOwnerDraft(db, ticker, draft.revision, actor);
    return published ? Response.json({ published, preview }, { headers: { "Cache-Control": "private, no-store" } })
      : Response.json({ error: "Publication could not be saved." }, { status: 409 });
  }
  return Response.json({ error: "Unknown action." }, { status: 400 });
}
