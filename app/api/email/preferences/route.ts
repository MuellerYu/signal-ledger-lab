import { getMembershipD1 } from "@/lib/membership-db";
import { applyPreferenceChange, verifyPreferenceRequest } from "@/lib/email-preferences";
import { getBindings } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/**
 * The only route that changes an email preference.
 *
 * A POST, so a link-following scanner cannot unsubscribe anyone. It validates
 * the same signed context the GET displays and then writes exactly two columns:
 * it never touches entitlement, never touches billing, and never deletes the
 * account. Losing PRO is impossible from here, because nothing here knows what
 * PRO is.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const userId = String(form?.get("uid") ?? "");
  const signature = String(form?.get("sig") ?? "");

  const d1 = getMembershipD1();
  const secret = getBindings().EMAIL_PREFERENCE_SECRET?.trim() ?? "";
  const authorized = d1 ? await verifyPreferenceRequest(d1, secret, userId, signature) : { ok: false as const };

  if (!authorized.ok || !d1) {
    return page("<p>这个偏好链接无效或已过期，未做任何更改。</p>", 403);
  }

  const dailyBriefEnabled = form?.get("daily_brief") === "on";
  const marketingEnabled = form?.get("marketing") === "on";
  const updated = await applyPreferenceChange(d1, userId, { dailyBriefEnabled, marketingEnabled }, new Date().toISOString());

  return page(`
    <p>已保存。每日收盘简报现在为 <strong>${updated.dailyBriefEnabled ? "已开启" : "已关闭"}</strong>。</p>
    <p>你的网站访问权限不受影响。</p>`);
}

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
