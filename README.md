# Signal Ledger

**English summary** (中文说明在下方)

Signal Ledger is an auditable market-intelligence, forecasting and alerting system for US equities, live at [signalledgerlab.com](https://signalledgerlab.com). It keeps four steps on one traceable chain:

1. Discover and de-duplicate events from primary sources: SEC filings, Alpaca news and official RSS feeds.
2. Freeze a probability forecast, with an information cut-off, before each event happens.
3. Record the actual outcome afterwards and score it on Brier score, direction hit and relative return.
4. Send idempotent P0/P1 e-mail alerts.

The system never trades, and judgments written after the fact never count toward the official forecast record.

**Stack.** TypeScript throughout: a Next.js app (via vinext) on Cloudflare Pages with D1 (SQLite) through Drizzle ORM; a separate Cloudflare Worker on a one-minute cron for 24/7 collection, de-duplication and e-mail delivery (Resend, or a Gmail Apps Script webhook); Alpaca for market data. Tests run on `node:test`: 730 tests across 55 files.

**Quality rules.** Official forecasts are append-only once frozen. Evidence must have been fetched by the system before the information cut-off. No "calibrated" claim is made with fewer than 30 settled forecasts. Free quotes are labelled with their IEX/SIP scope rather than presented as full real-time market data.

**About this repository.** This is a sanitized public mirror of the private production repository, published as a single snapshot in October 2026. Database ids, owner e-mail addresses and preview domains are placeholders; secrets were never committed and live in `.dev.vars` and the Cloudflare secret store. Specs, acceptance criteria and code review are by the author; implementation was assisted by Claude Code and OpenAI Codex.

---

面向美股的可审计情报、预测和突发告警系统。

它把四件事放在同一条可追溯链路里：

1. 从 SEC 等一手来源发现事件并去重；
2. 在事件发生前冻结概率预测和信息截止时间；
3. 事后写入实际结果，计算 Brier Score、方向命中和相对收益；
4. 对 P0/P1 事件生成幂等邮件告警。

系统不自动交易，也不会把事后补写的判断计入正式预测成绩。

## 结构

- `app/`：私有 Signal Ledger 仪表盘和 Sites API
- `db/`、`drizzle/`：Sites D1 数据模型和迁移
- `monitor-worker/`：独立 Cloudflare Worker，负责每分钟 24/7 采集、去重和邮件
- `lib/`：采集、评分、权限和邮件适配器

```text
SEC / Alpaca / 官方 RSS
          ↓
Cloudflare Worker Cron → D1 → Resend
          ↓
Private Sites dashboard
```

Cloudflare Cron 的最短周期为一分钟。秒级新闻需要 WebSocket 或供应商
webhook，属于下一阶段升级。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
pnpm install
pnpm run dev
pnpm run build
```

复制 `.env.example` 为 `.env.local` 后填写本地值。不要提交密钥。

## 环境变量

Sites：

- `ALLOWED_EMAIL`：允许执行写操作的登录邮箱
- `ALERT_RECIPIENT`：告警收件人
- `SEC_USER_AGENT`：符合 SEC 要求的联系信息
- `RESEND_API_KEY`、`RESEND_FROM`：可选；未配置时邮件保留在待发送队列
- `ALPACA_API_KEY_ID`、`ALPACA_API_SECRET_KEY`：可选新闻/行情增强

独立 Worker 的完整变量和部署说明见
[`monitor-worker/README.md`](./monitor-worker/README.md)。

## 质量边界

- 官方预测按固定时点冻结，只能追加，不能覆盖；
- 证据必须在信息截止时间前已被系统实际获取；
- ORCL 历史材料默认只作 `shadow_backfill`，MSTR/BTC 相关性只作特征研究；
- 少于 30 个已结算预测时不宣称“已校准”；
- 免费行情必须标注 IEX/SIP 范围，不能混称全市场实时行情。
