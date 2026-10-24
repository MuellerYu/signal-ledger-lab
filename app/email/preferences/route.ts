import { getMembershipD1 } from "@/lib/membership-db";
import { verifyPreferenceRequest } from "@/lib/email-preferences";
import { getBindings } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/**
 * Displays current preferences. **This route never writes.**
 *
 * Email security scanners and link previewers fetch links automatically, so a
 * GET that unsubscribed someone would let a robot change a person's settings.
 * The read path is therefore side-effect free — it does not even create the
 * preferences row — and the change is made by POSTing to /api/email/preferences.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("uid") ?? "";
  const signature = url.searchParams.get("sig") ?? "";

  const d1 = getMembershipD1();
  const secret = getBindings().EMAIL_PREFERENCE_SECRET?.trim() ?? "";
  const authorized = d1 ? await verifyPreferenceRequest(d1, secret, userId, signature) : { ok: false as const };

  if (!authorized.ok) {
    return page("<p>这个偏好链接无效或已过期。</p>", 403);
  }

  const { preferences } = authorized;
  const state = preferences.dailyBriefEnabled ? "已开启" : "已关闭";
  const marketing = preferences.marketingEnabled ? "已开启" : "已关闭";
  const action = preferences.dailyBriefEnabled ? "退订每日简报" : "重新订阅每日简报";

  // The action is a form POST, so no scanner can trigger it by following a link.
  return page(`
    <p>当前状态：每日收盘简报（Daily Brief）<strong>${state}</strong>，营销邮件 <strong>${marketing}</strong>。</p>
    <p>关闭每日简报不会影响你的 PRO 网站访问权限。</p>
    <form method="POST" action="/api/email/preferences">
      <input type="hidden" name="uid" value="${escapeAttribute(userId)}">
      <input type="hidden" name="sig" value="${escapeAttribute(signature)}">
      <input type="hidden" name="daily_brief" value="${preferences.dailyBriefEnabled ? "off" : "on"}">
      <input type="hidden" name="marketing" value="${preferences.marketingEnabled ? "on" : "off"}">
      <button type="submit" style="background:#0f5c4a;color:#fff;border:none;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer">${action}</button>
    </form>
    <form method="POST" action="/api/email/preferences" style="margin-top:12px">
      <input type="hidden" name="uid" value="${escapeAttribute(userId)}">
      <input type="hidden" name="sig" value="${escapeAttribute(signature)}">
      <input type="hidden" name="daily_brief" value="${preferences.dailyBriefEnabled ? "on" : "off"}">
      <input type="hidden" name="marketing" value="${preferences.marketingEnabled ? "off" : "on"}">
      <button type="submit" style="background:none;border:1px solid #d8dee6;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer">切换营销邮件</button>
    </form>`);
}

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function page(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Signal Ledger 邮件偏好</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:10vh auto;padding:0 24px;color:#14243a;line-height:1.6">
<h1 style="font-size:21px">邮件偏好</h1>${body}
<p style="color:#516074;font-size:13px;margin-top:32px;border-top:1px solid #e3e9ef;padding-top:12px">Signal Ledger 提供一般性金融研究与信息，不构成个性化投资建议。</p>
</body></html>`,
    { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Type": "text/html; charset=utf-8" } },
  );
}
