# Market Signal Monitor Worker

独立于 Sites 看板运行的 Cloudflare Worker。它每分钟自动检查 SEC 与可选
Alpaca News，将标准化事件、预测、实际结果、运行状态和邮件 outbox 写入
D1，并优先通过受保护的 Gmail Apps Script 向 `owner@example.com`
发送 P0/P1 告警。

## 已实现

- 财报日历：后台每分钟轮换检查一家公司，每家公司间隔 30 分钟。
  从公司公告/官方分发稿正文验证财季、发布日期、盘前盘后及电话会时间；
  存入独立 `earnings_calendar` 表，日历新值优先于历史固定配置。
  新财季没有预测时也会显示日历卡片，不伪造预测；不修改已冻结的预测。
  `calendar:ir:*` 来源记录上次真实检查、成功与错误。官网拒绝访问或无法
  解析时保留原日期、记录失败并重试；部分官网受访问限制，不能保证立即获取。

- `GET /health`：数据库、最近任务、必需数据源和未结算预测健康状态。
- `GET /api/dashboard`：与看板约定一致的
  `snapshotAt / status / system / metrics / events / forecasts /
  calibration / watchlist / runs / sources`，另含 `alerts / outbox`。
- `POST /api/forecasts`：由 Sites 服务端转发，使用
  `DASHBOARD_READ_KEY` 冻结人工事前收益预测；冻结输入由 D1 trigger
  保护，到期后用真实 Alpaca 日线结算。
- `POST /internal/run`：需要 `Authorization: Bearer <CRON_SECRET>`。
- `POST /internal/test-email`：同样受 `CRON_SECRET` 保护；全局 dry-run
  下只有显式 `force=1` 才执行一次真实测试。
- Cloudflare Cron：`* * * * *`，UTC 每分钟执行。
- SEC：
  - 每日刷新 `company_tickers.json`。
  - Tier-1 watchlist 每分钟增量检查 submissions。
  - 强制使用带项目名和联系邮箱的 `SEC_USER_AGENT`。
  - 控制并发并在批次间停顿，避免超过 SEC 合理访问速率。
- Alpaca News：有 key 时启用；无 key 时保持可选 `needs_setup`，不阻断 SEC。
- 确定性 P0/P1/P2、方向和置信度分类，不调用黑盒模型。
- D1 事件唯一键、运行锁和邮件 outbox，避免重复事件和重复邮件。
- SEC Company Facts 季节性基线：冻结未来财报收入/EPS 估计、证据和
  推断披露窗口；实际披露后只追加实际值与误差。
- 纽约工作日 `07:45` 盘前与 `16:20` 盘后简报，各窗口每日只生成一次。
- Gmail / Resend：
  - 只发送新发现的 P0/P1。
  - 首次 bootstrap 事件只入库，不追发历史邮件。
  - Gmail webhook 未完成或 Resend 发件域名未验证时保留
    `needs_setup`。
  - 网络错误与限流指数退避，最多五次后进入 `dead_letter`。

## 预测边界

系统刻意分开两类预测，不能混为一谈：

1. `event_reaction`
   - 事件已经发生后，对下一完整交易区间相对 SPY 的影响做规则化预测。
   - 它是 **post-event impact forecast，不是事前预测**。
   - 到期后仅在 Alpaca 行情 key 可用且取得真实日线时结算。
   - 计算目标是“信息截止日前一交易日收盘至下一交易日收盘”的个股收益减
     SPY 收益；相对收益高于 `+0.5%` 为 up，低于 `-0.5%` 为 down，其余
     为 base。
   - 缺价格时继续保持 open，并写
     `qualityFlag=data_unavailable`；绝不填造价格或实际结果。

2. `pre_event_incidence_baseline_v1`
   - 每周一按纽约时间自动冻结 Tier-1 的五日事前基线。
   - 目标是未来五个美国工作日内是否出现 SEC Tier-1 P0/P1 事件。
   - 第一个版本明确使用 pooled `5% / 90% / 5%` 先验；两端合计为 10%
     事件概率，中间为无重大事件概率。它不使用冻结时间之后的信息。
   - 到期后只根据数据库中时间戳落在预测窗口内的 SEC 事件自动结算。
   - 第一版只按工作日近似交易日，标记
   `qualityFlag=baseline_v1_weekday_calendar`；后续应接入正式交易日历。

3. `pre_event_return_manual_v1`
   - 在私有看板中人工提交，Worker 设置服务端信息截止时间和到期时间。
   - 支持 `1d / 5d / 30d / 90d`，按 ticker 相对所选基准的实际收益结算。
   - 冻结概率、区间、理由和时间不可修改；只允许追加实际结果与评分。

两类预测的校准结果在 `calibration.byForecastType` 中分别输出。

## 安全部署顺序

新环境首次部署必须保持 `DRY_RUN=true`，完成最终送达验证后才能启用。

1. 登录 Cloudflare，并创建 D1：

   ```bash
   npx wrangler login
   npx wrangler d1 create market-signal-monitor
   ```

2. 把返回的真实 `database_id` 原样替换
   `wrangler.jsonc` 中的占位符（`…0001` 为生产库，`env.sandbox` 里的 `…0002` 为沙盒库）。

3. 应用生产 migration：

   ```bash
   npx wrangler d1 migrations apply market-signal-monitor --remote
   ```

4. 配置必需 secret：

   ```bash
   npx wrangler secret put CRON_SECRET
   npx wrangler secret put DASHBOARD_READ_KEY
   ```

5. 配置 Alpaca，用于可选新闻和真实价格结算：

   ```bash
   npx wrangler secret put ALPACA_API_KEY_ID
   npx wrangler secret put ALPACA_API_SECRET_KEY
   ```

6. 配置 Gmail webhook（首选）：

   ```bash
   npx wrangler secret put GMAIL_WEBHOOK_SECRET_URL
   npx wrangler secret put GMAIL_WEBHOOK_SECRET
   ```

   第一个密钥保存已部署的 Apps Script `/exec` 地址，第二个密钥保存请求
   校验值；两者均不得写入 `wrangler.jsonc`。如需备用 Resend，再设置
   `RESEND_API_KEY` 和已验证域名的 `ALERT_FROM_EMAIL`。

7. 首次部署保持 `DRY_RUN=true`：

   ```bash
   npx wrangler deploy
   ```

8. 查看 `/health`、手动 dry-run 和 `/api/dashboard`，再调用一次受保护的
   `/internal/test-email?force=1`。确认 Gmail 最终收到后，才将
   `DRY_RUN` 改为 `false` 并重新部署。

生产环境建议把 `DASHBOARD_ALLOWED_ORIGIN` 从 `*` 改为实际 Sites 域名。
Sites 服务端读取 API 时，将 `DASHBOARD_READ_KEY` 放在 Sites runtime secret
中，不要暴露给浏览器。

## 本地验证

从本目录运行：

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply market-signal-monitor --local
npx wrangler dev --test-scheduled
```

另一个终端执行：

```bash
curl http://localhost:8787/health
curl -H "Authorization: Bearer $DASHBOARD_READ_KEY" \
  http://localhost:8787/api/dashboard
curl -X POST \
  -H "Authorization: Bearer $DASHBOARD_READ_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ticker":"ORCL","targetDefinition":"未来5个交易日相对QQQ收益为正","horizon":"5d","probabilityUp":0.45,"probabilityBase":0.30,"probabilityDown":0.25,"returnLow":-0.10,"returnHigh":0.15,"benchmark":"QQQ","rationale":"提交时已知证据"}' \
  http://localhost:8787/api/forecasts
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:8787/internal/run?dry_run=1"
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

本地 dry-run 仍会把真实抓取结果写入本地 D1，但不会调用邮件服务。首次 SEC
和 Alpaca bootstrap 只建立基线游标并保存近期记录，不发送历史告警。

## 线上密钥与普通变量

普通变量保存在 `wrangler.jsonc`；敏感值使用 `wrangler secret put`。本地
使用 `.dev.vars`，该文件已被本目录 `.gitignore` 排除。

| 名称 | 作用 |
| --- | --- |
| `SEC_USER_AGENT` | 必需；应用名与联系邮箱 |
| `CRON_SECRET` | 必需；保护手动执行接口 |
| `DASHBOARD_READ_KEY` | 推荐；保护看板读取接口 |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | 可选新闻；真实价格结算需要 |
| `ALPACA_DATA_FEED` | 默认 `iex`；须与 Alpaca 订阅权限一致 |
| `GMAIL_WEBHOOK_SECRET_URL` / `GMAIL_WEBHOOK_SECRET` | 首选实际邮件通道；均以 Cloudflare secret 保存 |
| `RESEND_API_KEY` / `ALERT_FROM_EMAIL` | 可选备用通道；sender 必须完成域名验证 |
| `ALERT_TO_EMAIL` | 默认 `owner@example.com` |
| `DRY_RUN` | 默认 `true`；正式确认后才能改为 `false` |

## 运维判断

- `/health` 连续五分钟无成功任务会显示 `stale`。
- 必需数据源异常、邮件未配置或到期预测缺真实价格时显示 `degraded`。
- `runs` 与 `sources` 保存每次抓取成功、失败、耗时与错误。
- `queued / failed / needs_setup / dead_letter` 可在 dashboard outbox 中检查。
- Cloudflare Cron 和 SEC/Alpaca 本身存在传播与上游延迟，“每分钟”不等于
  绝对秒级；真正秒级新闻应另接供应商 webhook 或常驻 WebSocket 转发器。
