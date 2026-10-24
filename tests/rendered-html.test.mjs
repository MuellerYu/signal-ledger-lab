import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { publicDashboard } from "../lib/public-dashboard.ts";

test("public dashboard removes operational and brokerage data", () => {
  const sanitized = publicDashboard({
    snapshotAt: "2026-09-10T12:00:00.000Z",
    status: "healthy",
    alerts: [{ recipient: "private@example.com" }],
    outbox: [{ providerMessageId: "provider-secret" }],
    runs: [{ lastError: "internal failure" }],
    system: {
      monitoring: "active",
      email: "active",
      scheduler: "cron */5 * * * *",
      databaseError: "private database detail",
    },
    sources: [{
      id: "sec",
      name: "SEC",
      status: "healthy",
      cursor: "private-cursor",
      lastError: "private-source-error",
    }],
    briefings: [{
      title: "Public research",
      recipient: "private@example.com",
      sourceUrl: "https://example.com/report?api_key=private-key&item=public",
    }],
    btcResearch: {
      thesis: "Public thesis",
      accountId: "U1234567",
      token: "private-token",
      positions: [{ symbol: "BTC" }],
    },
  });
  const serialized = JSON.stringify(sanitized);

  assert.deepEqual(Object.keys(sanitized).sort(), [
    "briefings",
    "btcResearch",
    "calibration",
    "earningsForecasts",
    "earningsPriceForecasts",
    "events",
    "forecasts",
    "latestQuotes",
    "metrics",
    "priceForecastScorecard",
    "snapshotAt",
    "sources",
    "status",
    "system",
    "watchlist",
    "worldNews",
  ]);
  assert.doesNotMatch(serialized, /private@example\.com|provider-secret|private-cursor|private-source-error|private-token|U1234567|positions/);
  assert.doesNotMatch(serialized, /api_key|private-key/);
  assert.match(serialized, /item=public/);
  assert.equal(sanitized.system.scheduler, "scheduled");
});

test("public dashboard gates BTC deep analytical fields for FREE, keeps them for PRO", () => {
  const btc = {
    latest: { price: 64000, change24hPct: 1.2 },
    forecasts: [{
      id: "f1",
      targetPrice: 70000,
      predictedReturnPct: 9.4,
      researchLow: 58000,
      researchHigh: 72000,
      stance: "bullish",
      thesis: "Public thesis",
      drivers: ["momentum positive"],
      features: { momentum7Pct: 4.2, rsi14: 61.3 },
    }],
    backtests: [{ forecastDate: "2026-09-01", errorPct: 1.1 }],
    scorecard: { forecastsFrozen: 1 },
  };

  const free = publicDashboard({ btcResearch: btc }, "FREE");
  assert.equal(free.btcResearch.forecasts[0].features, undefined);
  assert.equal(free.btcResearch.forecasts[0].drivers, undefined);
  assert.deepEqual(free.btcResearch.backtests, []);
  // The headline call survives for FREE.
  assert.equal(free.btcResearch.forecasts[0].targetPrice, 70000);
  assert.equal(free.btcResearch.forecasts[0].thesis, "Public thesis");
  assert.equal(free.btcResearch.latest.price, 64000);
  assert.deepEqual(free.btcResearch.scorecard, { forecastsFrozen: 1 });
  // The FREE payload never carries a PRO value anywhere in its serialized JSON.
  assert.doesNotMatch(JSON.stringify(free.btcResearch), /momentum7Pct|rsi14|momentum positive|errorPct/);
  assert.match(JSON.stringify(free.btcResearch), /Public thesis/);
  assert.match(JSON.stringify(free.btcResearch), /64000/);

  const pro = publicDashboard({ btcResearch: btc }, "PRO");
  assert.deepEqual(pro.btcResearch.forecasts[0].features, { momentum7Pct: 4.2, rsi14: 61.3 });
  assert.deepEqual(pro.btcResearch.forecasts[0].drivers, ["momentum positive"]);
  assert.equal(pro.btcResearch.backtests.length, 1);
  assert.match(JSON.stringify(pro.btcResearch), /momentum7Pct/);
  assert.match(JSON.stringify(pro.btcResearch), /momentum positive/);
});

test("dashboard response is cache-safe and member resolution fails closed", async () => {
  const [route, publicDashboardSource] = await Promise.all([
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/public-dashboard.ts", import.meta.url), "utf8"),
  ]);

  // Never statically cached, and the HTTP response is explicitly non-shared.
  assert.match(route, /force-dynamic/);
  assert.match(route, /Cache-Control": "private, no-store"/);

  // Entitlement is resolved per-request and defaults to FREE, never PRO.
  assert.match(route, /resolveMember/);
  assert.match(route, /tier = "FREE"/);
  assert.doesNotMatch(route, /tier = "PRO"/);

  // The shared snapshot cache key is a fixed path, independent of any account,
  // cookie or tier — so gating (applied after the cache) cannot poison it.
  assert.match(route, /__snapshot\/dashboard-v1/);
  assert.doesNotMatch(route, /getSnapshot\([^)]*(?:tier|member|cookie)/);

  // Only btcResearch is tier-dependent; every other collection is untouched.
  assert.match(publicDashboardSource, /key === "btcResearch"/);
});

test("build emits the production Worker and application assets", async () => {
  await Promise.all([
    access(new URL("../dist/server/index.js", import.meta.url)),
    access(new URL("../dist/client/", import.meta.url)),
  ]);

  const page = await readFile(
    new URL("../app/dashboard-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /Signal Ledger/i);
  assert.match(page, /not investment advice/i);
  assert.doesNotMatch(page, /Your site is taking shape|Building your site/i);
});

test("keeps the production metadata and removes starter dependencies", async () => {
  const [layout, packageJson, page] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /lang="en-US"/);
  assert.match(layout, /signal-ledger-og\.png/);
  assert.match(page, /\/api\/dashboard/);
  assert.match(page, /\/api\/forecasts/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page, /codex-preview|SkeletonPreview/);
});

test("exposes English tables, contextual quotes, and auditable earnings forecasts", async () => {
  const [
    page,
    worker,
    reactionMigration,
    researchMigration,
    priceMigration,
    actualMigration,
  ] = await Promise.all([
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../monitor-worker/src/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../monitor-worker/migrations/0004_earnings_reaction_forecasts.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0005_event_research_notes.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0006_earnings_price_forecasts.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0008_earnings_actuals.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(page, /InlineCompanyQuote/);
  assert.match(page, /inline-company-quote/);
  assert.doesNotMatch(page, /<RealTimeQuoteTable/);
  assert.match(page, /Research Watchlist vs\. SPY Today/);
  assert.match(page, /Excess return equals the stock's session move minus SPY's move/);
  assert.match(page, /relative-performance-chart/);
  assert.match(page, /relative-bar-track/);
  assert.match(page, /How to use this chart/);
  assert.match(page, /latestQuotes=\{dashboard\.latestQuotes\}/);
  assert.match(page, /The call\. The result\. The difference\./);
  assert.match(page, /research-cards/);
  assert.match(page, /research-card/);
  assert.match(page, /research-estimates/);
  assert.match(page, /research-details/);
  assert.match(page, /Consensus/);
  assert.match(page, /Reported/);
  assert.match(page, /Target-session close/);
  assert.match(page, /Target error/);
  assert.match(page, /RESULTS MISSING/);
  assert.match(page, /FORECAST REVIEW/);
  assert.match(page, /Sources &amp; forecast record/);
  assert.match(page, /settledPriceOutcome/);
  assert.doesNotMatch(page, /Company-reported operating highlight under review/);
  assert.doesNotMatch(page, /This evidence is included in the model, but its English source note/);
  assert.match(page, /unionEarningsForecastInputs/);
  assert.match(page, /Forecast Performance Summary/);
  assert.match(page, /Error is target price minus actual price/);
  assert.match(page, /<span>What happened<\/span>/);
  assert.match(page, /CapEx-related payables/);
  assert.match(page, /The company filed its audited annual report/);
  assert.match(page, /Primary source/);
  assert.match(page, /Earnings/);
  assert.match(page, /window\.setTimeout\(\(\) => void poll\(\)/);
  assert.doesNotMatch(page, /<CalibrationPanel/);
  assert.doesNotMatch(page, /<ForecastLedger/);
  assert.doesNotMatch(page, /<RunLog/);
  assert.doesNotMatch(page, /今日研究原则/);
  assert.doesNotMatch(page, /sorted\.slice\(0,\s*6\)/);
  assert.match(worker, /earnings_reaction_sec_signals_v2/);
  assert.match(worker, /earnings_reaction_multisignal_v5/);
  assert.match(worker, /processNasdaqLatestQuotes/);
  assert.match(worker, /new Set\(\[\.\.\.watchlist\.map\(\(security\) => security\.symbol\), "SPY"\]\)/);
  assert.match(worker, /assetClass = etfSymbols\.has\(symbol\.toUpperCase\(\)\) \? "etf" : "stocks"/);
  assert.match(worker, /processEarningsPointPriceForecasts/);
  assert.match(worker, /earnings_point_price_v2_historical_amplitude/);
  assert.match(worker, /fetchHistoricalEarningsAmplitude/);
  assert.match(worker, /medianAbsMovePct/);
  assert.match(worker, /p75AbsMovePct/);
  assert.match(worker, /observations\.length < 3/);
  assert.match(worker, /Math\.abs\(directionalBalance\) < 0\.05/);
  assert.match(worker, /settleEarningsPointPriceForecasts/);
  assert.match(worker, /latestQuotes/);
  assert.match(worker, /earningsPriceForecasts/);
  assert.match(worker, /priceForecastScorecard/);
  assert.match(worker, /processSecFilingResearch/);
  assert.match(worker, /processSecEarningsActualBackfill/);
  assert.match(worker, /extractEarningsActuals/);
  assert.match(worker, /total\(\?:\\s\+quarterly\)\? revenues\?/);
  assert.match(worker, /Services revenues were/);
  assert.match(worker, /ABS\(ef\.actual_revenue\) < ABS\(ef\.revenue_estimate\) \* 0\.25/);
  assert.match(worker, /upsertEarningsActualsForTicker/);
  assert.match(worker, /upsertEarningsActualFromSecResearch/);
  assert.match(worker, /公开时点采用 EDGAR 接受时间/);
  assert.match(worker, /actual:sec-earnings-release-v1/);
  assert.match(worker, /Amazon-com-Announces-Second-Quarter-Results/);
  assert.match(worker, /processMultisignalEarningsForecasts/);
  assert.match(worker, /X\/Twitter 官方数据权限未配置/);
  assert.match(worker, /processNasdaqEarningsConsensus/);
  assert.match(worker, /EARNINGS_EVENT_PROFILES/);
  assert.match(worker, /function cleanSourceSummary/);
  assert.match(worker, /analysisVersion:\s*"rules-zh-v1"/);
  assert.match(worker, /发生了什么/);
  assert.match(worker, /为什么重要 \/ 有什么影响/);
  assert.match(worker, /下一步看什么/);
  assert.match(worker, /formatEtDateTime/);
  assert.match(worker, /isInstitutionSpecificFederalReserveAction/);
  assert.match(worker, /isRoutineFederalReserveRelease/);
  assert.match(worker, /suppressed_irrelevant/);
  assert.match(worker, /assessMaterialEarningsDisclosure/);
  assert.match(worker, /buildMaterialEarningsAlertContent/);
  assert.match(worker, /enqueueMaterialEarningsAlert/);
  assert.match(worker, /earnings-impact:/);
  assert.match(worker, /assessment\.fiscalPeriod/);
  assert.match(worker, /EMAIL_DELIVERY_PROVIDER/);
  assert.match(worker, /emailDeliveryProvider/);
  assert.match(worker, /MSTR forecast\(s\) were withheld/);
  assert.match(worker, /request\(\?:s\)\? \(\?:public \)\?comment/);
  assert.match(worker, /数十亿美元级营业或数字资产亏损/);
  assert.match(worker, /单纯提交 SEC 表单不会触发邮件/);
  assert.match(worker, /Routine SEC form alert suppressed/);
  assert.match(worker, /MATERIAL_EARNINGS_ALERT_SCORE/);
  assert.match(worker, /OFFICIAL_FEED_INGEST_MAX_AGE_MS = 36/);
  assert.match(worker, /IMMEDIATE_ALERT_MAX_AGE_MS = 2/);
  assert.match(worker, /suppressQueuedStaleImmediateAlerts/);
  assert.match(worker, /minutes of the board'\?s discount rate meetings/);
  assert.match(worker, /if \(!presentation\) return false/);
  assert.match(worker, /market:\$\{presentation\.semanticType\}/);
  assert.match(worker, /美国\$\{month\} CPI 环比/);
  assert.match(worker, /美国\$\{month\}非农/);
  assert.match(worker, /event\.ticker === "MARKET" && immediateMarketAlert/);
  assert.match(worker, /前两个月合计下修/);
  assert.match(worker, /劳动参与率\$\{participationDirection\}/);
  assert.match(worker, /Signal Ledger <\$\{resendFromAddress\}>/);
  assert.doesNotMatch(worker, /美国官方发布新的市场信息/);
  assert.doesNotMatch(worker, /美国官方来源发布了一项新的市场相关信息/);
  assert.doesNotMatch(worker, /方向初判：/);
  assert.doesNotMatch(worker, /文本置信度：/);
  assert.match(reactionMigration, /CREATE TABLE IF NOT EXISTS earnings_reaction_forecasts/);
  assert.match(reactionMigration, /frozen earnings reaction input is immutable/);
  assert.match(reactionMigration, /earnings reaction forecast is append-only/);
  assert.match(researchMigration, /CREATE TABLE IF NOT EXISTS event_research_notes/);
  assert.match(researchMigration, /event research note is append-only/);
  assert.match(priceMigration, /CREATE TABLE IF NOT EXISTS latest_quotes/);
  assert.match(
    priceMigration,
    /CREATE TABLE IF NOT EXISTS earnings_price_forecasts/,
  );
  assert.match(
    priceMigration,
    /CREATE TABLE IF NOT EXISTS earnings_price_forecast_settlements/,
  );
  assert.match(priceMigration, /earnings price forecast is append-only/);
  assert.match(priceMigration, /earnings price settlement is immutable/);
  assert.doesNotMatch(
    priceMigration,
    /financial_forecast_id\s+TEXT\s+NOT NULL\s+UNIQUE/,
  );
  assert.match(actualMigration, /CREATE TABLE IF NOT EXISTS earnings_actuals/);
  assert.match(actualMigration, /UNIQUE \(ticker, fiscal_period, accession\)/);
});

test("keeps research public while preserving owner-only management", async () => {
  const [
    page,
    accessRequest,
    approvalPage,
    dashboardRoute,
    healthRoute,
    accessSchema,
    ownerAuth,
    ibkrRoute,
    dashboardClient,
    edgeWorker,
    chatGptAuth,
    pagesWorker,
  ] = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../app/api/access/request/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/access/approve/page.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/dashboard/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/api/health/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../lib/db-schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/options/ibkr/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/chatgpt-auth.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/cloudflare-pages-worker.mjs", import.meta.url), "utf8"),
    ]);

  assert.match(page, /getChatGPTUser/);
  assert.match(page, /DashboardClient canManage=\{canManage\}/);
  assert.doesNotMatch(page, /requireChatGPTUser/);
  assert.doesNotMatch(page, /AccessRequestClient/);
  assert.match(accessRequest, /publicly accessible/);
  assert.doesNotMatch(accessRequest, /forwardAccessRequestEmail/);
  assert.match(approvalPage, /Only the site owner can approve access/);
  assert.doesNotMatch(dashboardRoute, /isApprovedSiteViewer/);
  assert.match(dashboardRoute, /publicDashboard/);
  assert.match(dashboardRoute, /public-dashboard/);
  assert.doesNotMatch(dashboardRoute, /result\["alerts"\]|result\.alerts/);
  assert.doesNotMatch(healthRoute, /isApprovedSiteViewer/);
  assert.match(healthRoute, /canInspect/);
  assert.match(healthRoute, /publicHealth/);
  assert.match(accessSchema, /CREATE TABLE IF NOT EXISTS site_access_requests/);
  assert.match(ownerAuth, /TRUSTED_SITES_SUFFIX = "\.chatgpt\.site"/);
  assert.match(ownerAuth, /isTrustedSitesRequest\(request\)/);
  assert.match(ownerAuth, /isSameOriginWrite\(request\)/);
  assert.match(ownerAuth, /configuredToken\.length >= 32/);
  assert.doesNotMatch(ownerAuth, /\["localhost", "127\.0\.0\.1", "::1"\]/);
  assert.match(ibkrRoute, /isAuthorizedMutation\(request\)/);
  assert.doesNotMatch(ibkrRoute, /getChatGPTUser|isSiteOwnerEmail/);
  assert.doesNotMatch(dashboardClient, /owner@example\.com/);
  assert.match(edgeWorker, /Content-Security-Policy/);
  assert.match(edgeWorker, /legacy-app\.your-handle\.chatgpt\.site/);
  assert.match(edgeWorker, /https:\/\/your-project\.pages\.dev/);
  assert.match(edgeWorker, /Response\.redirect\(destination, 308\)/);
  assert.doesNotMatch(edgeWorker, /destination\.search/);
  assert.match(edgeWorker, /Strict-Transport-Security/);
  assert.match(edgeWorker, /X-Content-Type-Options/);
  assert.match(chatGptAuth, /isTrustedSitesHost\(requestHeaders\.get\("host"\)\)/);
  assert.match(pagesWorker, /protectStatic/);
  assert.match(pagesWorker, /X-Content-Type-Options/);
});

test("adds immutable BTC forecasting and a regional current-affairs desk", async () => {
  const [
    page,
    projectProfile,
    worker,
    researchWorker,
    migration,
    briefingMigration,
    storyQualityMigration,
    workerConfig,
  ] = await Promise.all([
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/project-profile.tsx", import.meta.url), "utf8"),
    readFile(new URL("../monitor-worker/src/index.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../monitor-worker/src/btc-news.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0007_btc_and_world_news.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0009_world_news_briefs.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../monitor-worker/migrations/0010_world_news_story_quality.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../monitor-worker/wrangler.jsonc", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(page, /BTC 30-Day Outlook/);
  assert.match(page, /Live Market Feed/);
  assert.match(page, /Visible-page refresh: 1 minute/);
  assert.match(page, /Last feed check/);
  assert.match(page, /No matching story is available in the current snapshot/);
  assert.match(page, /ageMs <= 24 \* 60 \* 60 \* 1_000/);
  assert.match(page, /Actual Price vs\. the Single Frozen Path/);
  assert.match(page, /One forecast is frozen per 30-day cycle/);
  assert.match(page, /Current path deviation/);
  assert.match(page, /Use the buttons, trackpad, or bottom scrollbar/);
  assert.match(page, /The 30-day path never changes during the cycle/);
  assert.doesNotMatch(page, /Select historical BTC forecast/);
  assert.match(page, /Path Tracking & 30-Day Evaluation/);
  assert.match(page, /correlated observations, not independent forecasts/);
  assert.match(page, /Not a statistically valid hit rate yet/);
  assert.match(page, /Completed-cycle direction/);
  assert.match(projectProfile, /Independent equity research, valuation and forecast accountability/);
  assert.match(projectProfile, /Download the research note/);
  assert.match(page, /Open the model: inputs → call → target/);
  assert.match(page, /WHAT HAPPENED/);
  assert.match(page, /WHY IT MATTERS/);
  assert.match(page, /WHO IS AFFECTED/);
  assert.match(page, /WHAT TO WATCH NEXT/);
  assert.match(page, /worldNewsEnglishTitle/);
  assert.match(page, /United States/);
  assert.match(page, /Japan/);
  assert.match(page, /South Korea/);
  assert.match(page, /China/);
  assert.match(worker, /processBtcResearch/);
  assert.match(worker, /btcForecastCycleRows/);
  assert.match(worker, /btcCurrentPathBatch/);
  assert.match(worker, /btcActualByForecastDay/);
  assert.match(worker, /settledDirectionHits/);
  assert.match(worker, /noChangeMeanAbsoluteErrorPct/);
  assert.match(worker, /LIMIT 120/);
  assert.doesNotMatch(
    worker,
    /FROM btc_forecast_path\s+WHERE forecast_id = \(\s+SELECT id FROM btc_30d_forecasts/,
  );
  assert.match(worker, /processWorldNews/);
  assert.match(worker, /WORLD_NEWS_DASHBOARD_MAX_AGE_MS/);
  assert.match(worker, /officialDeskEventIsInvestable/);
  assert.match(worker, /regionHeadlineRelevant/);
  assert.match(worker, /ROW_NUMBER\(\) OVER/);
  assert.match(worker, /duplicate_rank = 1/);
  assert.match(worker, /'-24 hours'/);
  assert.match(researchWorker, /WORLD_NEWS_REFRESH_MS = 2 \* 60 \* 1_000/);
  assert.match(researchWorker, /createForecastCycle/);
  assert.match(researchWorker, /forecastDate <= currentCycle\.target_date/);
  assert.match(researchWorker, /完整30日周期内保持不变/);
  assert.match(researchWorker, /sourcelang:english/);
  assert.match(researchWorker, /regionHeadlineRelevant/);
  assert.match(researchWorker, /normalizedHeadlineKey/);
  assert.match(researchWorker, /generateWorldNewsBriefs/);
  assert.match(researchWorker, /articleContextFromHtml/);
  assert.match(researchWorker, /ai-story-v6/);
  assert.match(researchWorker, /llama-3\.1-8b-instruct-fast/);
  assert.match(researchWorker, /WORLD_NEWS_AI_TIMEOUT_MS = 18_000/);
  assert.match(researchWorker, /ruleBasedWorldNewsBrief/);
  assert.match(researchWorker, /美国二季度GDP仅增1\.5%，低于2\.1%预期/);
  assert.match(researchWorker, /韩国芯片出口连续两个月突破400亿美元/);
  assert.match(researchWorker, /美国财政部据报买入日元/);
  assert.match(researchWorker, /只允许使用输入标题和来源摘要中的事实/);
  assert.match(researchWorker, /publishable/);
  assert.match(researchWorker, /eligibleWorldNewsArticles/);
  assert.match(researchWorker, /Google News RSS fallback/);
  assert.match(worker, /dashboardNewsBriefIsConcrete/);
  assert.match(worker, /WORLD_NEWS_BRIEF_VERSION/);
  assert.match(researchWorker, /媒体报道/);
  assert.match(researchWorker, /美国财政部据报在日本入市后介入外汇市场支撑日元/);
  assert.match(researchWorker, /韩国最新出口强于市场预期/);
  assert.match(researchWorker, /NON_INVESTMENT_NEWS/);
  assert.match(researchWorker, /Coinbase Exchange/);
  assert.match(researchWorker, /btc-momentum-volume-v1/);
  assert.match(researchWorker, /7\/30\/90日动量/);
  assert.match(researchWorker, /GDELT/);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS btc_30d_forecasts/,
  );
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS btc_forecast_actuals/,
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS world_news/);
  assert.match(migration, /frozen BTC forecast is immutable/);
  assert.match(migration, /BTC forecast actual is append-only/);
  assert.match(briefingMigration, /ADD COLUMN title_zh/);
  assert.match(briefingMigration, /ADD COLUMN evidence_status/);
  assert.match(storyQualityMigration, /ADD COLUMN brief_version/);
  assert.match(workerConfig, /"binding": "AI"/);
});

test("publishes the equity research, valuation and track-record framework", async () => {
  const [home, detail, route, layout, desk, page] = await Promise.all([
    readFile(new URL("../app/equity-research-home.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/equity-research-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/equities/[symbol]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/valuation-desk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(home, /RESEARCH RECORD/);
  assert.match(home, /RESEARCH TRACK RECORD/);
  assert.doesNotMatch(home, /Oracle Corporation <small>ORCL/);
  assert.match(desk, /Independent equity and digital-asset research\./);
  assert.match(desk, /View free summary/);
  assert.match(desk, /TRY SIGNAL LEDGER FREE/);
  assert.match(desk, /See Free vs Pro/);
  assert.match(desk, /U\.S\. Equities/);
  assert.match(desk, /30-Day Outlook/);
  assert.match(desk, /POPULAR/);
  assert.match(desk, /PRICE VS VALUE/);
  assert.match(desk, /eyebrow="RECENT"/);
  assert.match(desk, /EARNINGS AHEAD/);
  assert.match(desk, /\/fair-value\?ticker=/);
  assert.match(page, /\/api\/valuation\/snapshot\?scope=home/);
  assert.match(page, /<ValuationDesk/);
  assert.match(detail, /INVESTMENT CONCLUSION/);
  assert.match(detail, /Valuation framework and publication gate/);
  assert.match(detail, /Signal Ledger fair value/);
  assert.match(detail, /12-month target/);
  assert.match(detail, /RESEARCH ARCHIVE/);
  assert.match(detail, /TRACK RECORD/);
  assert.match(detail, /No false precision/);
  assert.doesNotMatch(detail, /Sihan.?s View/i);
  assert.match(route, /EquityResearchDetail/);
  assert.match(layout, /Independent equity research, valuation and forecast accountability/);
});
