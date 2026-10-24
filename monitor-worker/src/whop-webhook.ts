import { WHOP_EVENTS, WHOP_VERSION, cents, iso, planKind, planTerms, record, string, verifyWhopSignature, whopApi, whopConfig, type Order, type WhopBindings } from "../../lib/whop-billing";

type Env = WhopBindings & { DB: D1Database };
const reply = (status: number, result: string) => Response.json({ result }, { status, headers: { "Cache-Control": "no-store" } });

/** A single D1 transaction commits the event, payment and derived entitlement. */
export async function handleWhopWebhook(request: Request, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const config = whopConfig(env);
  if (!config.valid || !env.WHOP_WEBHOOK_SECRET) return reply(503, "unavailable");
  if (Number(request.headers.get("content-length")) > 262144) return reply(413, "too_large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 262144) return reply(413, "too_large");
  if (!await verifyWhopSignature(raw, request.headers, env.WHOP_WEBHOOK_SECRET)) return reply(401, "invalid_signature");
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(raw)); } catch { return reply(400, "invalid_event"); }
  const eventId = string(event.id), type = string(event.type), eventAt = iso(event.timestamp);
  if (!eventId || eventId !== request.headers.get("webhook-id") || !eventAt || event.api_version !== "v1" || event.api_version_date !== WHOP_VERSION || event.account_id !== config.account) return reply(400, "invalid_event");
  const db = env.DB, id = `whop:${eventId}`;
  const seen = () => db.prepare("SELECT id FROM billing_events WHERE id = ? AND provider = 'whop' AND status IN ('processed','ignored')").bind(id).first();
  if (await seen()) return reply(200, "duplicate");
  const statements: D1PreparedStatement[] = [];
  const log = (status: string, note: string | null = null) => db.prepare("INSERT INTO billing_events (id, provider, event_type, received_at, processed_at, status, note) VALUES (?, 'whop', ?, ?, ?, ?, ?)")
    .bind(id, type, new Date().toISOString(), new Date().toISOString(), status, note);
  const ignore = async (note: string) => {
    try { await log("ignored", note).run(); } catch { if (!await seen()) return reply(503, "retry"); }
    return reply(200, "ignored");
  };
  if (!WHOP_EVENTS.includes(type)) return ignore("unsupported_event");
  try {
    const signal = AbortSignal.timeout(4000);
    const data = record(event.data);
    let payment: Record<string, unknown> | null = null;
    let membershipId = "";
    const isRefund = type.startsWith("refund.");
    if (type.startsWith("payment.") || isRefund) {
      let paymentId = string(data.id);
      if (isRefund) {
        if (!/^rf_[\w]+$/.test(paymentId)) return reply(400, "invalid_resource");
        const refund = await whopApi(config, `/refunds/${paymentId}`, { fetchImpl, signal });
        if (refund.account_id !== config.account) return reply(400, "invalid_resource");
        if (refund.status !== "succeeded") return ignore("refund_not_settled");
        paymentId = string(refund.payment_id);
      }
      if (!/^pay_[\w]+$/.test(paymentId)) return reply(400, "invalid_resource");
      // Retrieve current payment state: a late success must not undo a refund.
      payment = await whopApi(config, `/payments/${paymentId}`, { fetchImpl, signal });
      if (payment.id !== paymentId || payment.account_id !== config.account || payment.product_id !== config.product || !planKind(config, payment.plan_id)) return ignore("unrelated_payment");
      membershipId = string(payment.membership_id);
    } else membershipId = string(data.id);
    if (!/^mem_[\w]+$/.test(membershipId)) return reply(422, "missing_membership");
    const membership = await whopApi(config, `/memberships/${membershipId}`, { fetchImpl, signal });
    if (membership.id !== membershipId || record(membership.account).id !== config.account || membership.product_id !== config.product) return ignore("unrelated_membership");
    const kind = planKind(config, membership.plan_id);
    if (!kind || (payment && payment.plan_id !== membership.plan_id)) return ignore("unrelated_plan");
    const meta = record(payment?.metadata), membershipMeta = record(membership.metadata);
    const mapped = await db.prepare("SELECT * FROM whop_orders WHERE membership_id = ? LIMIT 1").bind(membershipId).first<Order>();
    const metadata = meta.order_id ? meta : membershipMeta;
    const order = mapped ?? await db.prepare("SELECT * FROM whop_orders WHERE id = ? LIMIT 1").bind(string(metadata.order_id)).first<Order>();
    // Missing mapping can be an event arriving before checkout persistence; retry.
    if (!order) return reply(422, "order_not_found");
    if (order.plan_id !== membership.plan_id || (order.membership_id && order.membership_id !== membershipId)
      || (!mapped && (metadata.user_id !== order.user_id || metadata.order_id !== order.id))
      || (metadata.user_id && metadata.user_id !== order.user_id) || (metadata.order_id && metadata.order_id !== order.id)) return reply(409, "identity_mismatch");
    if (payment && !mapped && (!order.checkout_id || payment.checkout_configuration_id !== order.checkout_id)) return reply(422, "checkout_not_matched");
    const user = await db.prepare("SELECT email FROM users WHERE id = ? AND email_verified = 1 LIMIT 1").bind(order.user_id).first<{ email: string }>();
    if (!user) return reply(422, "user_not_found");
    const terms = planTerms(kind), now = new Date().toISOString();
    statements.push(log("processed"));
    // Conditional binding cannot reassign an order's first membership.
    statements.push(db.prepare("UPDATE whop_orders SET membership_id = ? WHERE id = ? AND (membership_id IS NULL OR membership_id = ?)").bind(membershipId, order.id, membershipId));
    // Enforce binding even against concurrent different memberships: inserts
    // below join the order, so a lost ownership race cannot mint access.
    if (payment?.status === "paid") {
      const paidAt = iso(payment.paid_at), periodEnd = iso(membership.current_period_end);
      const total = record(payment.total), subtotal = record(payment.subtotal);
      const refunded = ["refunded", "auto_refunded"].includes(string(payment.substatus));
      if (!paidAt || !periodEnd || total.currency !== "usd" || subtotal.currency !== "usd" || cents(subtotal.amount) !== terms.cents || (cents(total.amount) ?? 0) <= 0) return reply(422, "payment_terms_mismatch");
      // The current API exposes the membership's current end, not a historical
      // period on each payment. Never attach an old receipt to a later period:
      // cap it at one billed interval from actual collection. Fail conservative.
      const paidEnd = new Date(Math.min(Date.parse(periodEnd), Date.parse(paidAt) + terms.days * 86400000)).toISOString();
      if (paidEnd <= paidAt) return reply(422, "payment_period_invalid");
      const paymentUpdated = iso(payment.updated_at);
      if (!paymentUpdated) return reply(422, "invalid_payment_version");
      statements.push(db.prepare(`INSERT INTO whop_payments (id, membership_id, order_id, paid_at, access_until, refunded, updated_at)
        SELECT ?, ?, id, ?, ?, ?, ? FROM whop_orders WHERE id = ? AND membership_id = ?
        ON CONFLICT(id) DO UPDATE SET refunded = MAX(whop_payments.refunded, excluded.refunded), updated_at = MAX(whop_payments.updated_at, excluded.updated_at)`)
        .bind(payment.id, membershipId, paidAt, paidEnd, refunded ? 1 : 0, paymentUpdated, order.id, membershipId));
      statements.push(db.prepare("UPDATE whop_orders SET status = 'paid' WHERE id = ? AND membership_id = ?").bind(order.id, membershipId));
    } else if (isRefund) return reply(503, "payment_not_reconciled");
    // Membership events alone NEVER grant time. Only the payment ledger does.
    const canceled = membership.cancel_at_period_end === true || membership.status === "canceled";
    const status = canceled ? "canceled" : membership.status === "past_due" ? "past_due" : "active";
    const subId = `whop_${membershipId}`;
    statements.push(db.prepare(`INSERT INTO subscriptions
      (id, user_id, email, plan, status, provider, provider_subscription_id, billing_interval, currency, access_until, cancel_at_period_end, created_at, updated_at, whop_state_at)
      SELECT ?, user_id, ?, 'PRO', ?, 'whop', ?, ?, 'usd', NULL, ?, ?, ?, ? FROM whop_orders WHERE id = ? AND membership_id = ?
      ON CONFLICT(id) DO UPDATE SET
        status = CASE WHEN excluded.whop_state_at >= subscriptions.whop_state_at THEN excluded.status ELSE subscriptions.status END,
        cancel_at_period_end = CASE WHEN excluded.whop_state_at >= subscriptions.whop_state_at THEN excluded.cancel_at_period_end ELSE subscriptions.cancel_at_period_end END,
        whop_state_at = MAX(subscriptions.whop_state_at, excluded.whop_state_at), updated_at = excluded.updated_at`)
      .bind(subId, user.email, status, membershipId, terms.interval, canceled ? 1 : 0, now, now, eventAt, order.id, membershipId));
    statements.push(db.prepare(`UPDATE subscriptions SET access_until = (SELECT MAX(access_until) FROM whop_payments WHERE membership_id = ? AND refunded = 0),
      current_period_end = (SELECT MAX(access_until) FROM whop_payments WHERE membership_id = ? AND refunded = 0), updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(membershipId, membershipId, now, subId, order.user_id));
    await db.batch(statements);
    return reply(200, "processed");
  } catch {
    // A unique event conflict means the concurrent transaction already won.
    if (await seen()) return reply(200, "duplicate");
    return reply(503, "retry");
  }
}
