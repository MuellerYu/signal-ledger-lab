import { ensureDatabase, getD1 } from "@/db";
import {
  getSiteAccessRequestByToken,
  isSiteOwnerEmail,
} from "@/lib/site-access";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import AccessDecisionClient from "./decision-client";
import Link from "next/link";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AccessApprovalPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const tokenValue = params.token;
  const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue ?? "";
  return <AccessApprovalContent token={token} />;
}

async function AccessApprovalContent({ token }: { token: string }) {
  const returnTo = token
    ? `/access/approve?token=${encodeURIComponent(token)}`
    : "/access/approve";
  const user = await requireChatGPTUser(returnTo);
  if (!isSiteOwnerEmail(user.email)) {
    return (
      <main className="access-shell">
        <section className="access-card">
          <p className="eyebrow">OWNER APPROVAL</p>
          <h1>Only the site owner can approve access</h1>
          <p className="access-intro">
            The current account is not the owner account. Sign out, then reopen the email link while signed in as the owner.
          </p>
          <a
            className="button button-dark access-link-button"
            href={`/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`}
          >
            Switch account
          </a>
        </section>
      </main>
    );
  }

  const d1 = getD1();
  if (!d1 || !token) {
    return <ApprovalUnavailable message="This approval link is invalid or the approval service is temporarily unavailable." />;
  }
  await ensureDatabase(d1);
  const request = await getSiteAccessRequestByToken(d1, token);
  if (!request) {
    return <ApprovalUnavailable message="This access request was not found. The link may have expired." />;
  }

  return (
    <main className="access-shell">
      <section className="access-card access-approval-card">
        <div className="access-brand">
          <span className="brand-mark" aria-hidden="true">
            SL
          </span>
          <div>
            <strong>Signal Ledger</strong>
            <small>Access approval</small>
          </div>
        </div>
        <p className="eyebrow">OWNER APPROVAL</p>
        <h1>Allow this account to view Signal Ledger?</h1>
        <dl className="access-identity">
          <div>
            <dt>Applicant</dt>
            <dd>{request.full_name || "Name not provided"}</dd>
          </div>
          <div>
            <dt>Sign-in email</dt>
            <dd>{request.email}</dd>
          </div>
          <div>
            <dt>Request status</dt>
            <dd>
              {request.status === "pending"
                ? "Awaiting your decision"
                : request.status === "approved"
                  ? "Approved"
                  : request.status === "denied"
                    ? "Declined"
                    : "Access revoked"}
            </dd>
          </div>
        </dl>
        <AccessDecisionClient token={token} initialStatus={request.status} />
        <p className="access-privacy">
          Approved visitors receive read-only dashboard access. Refresh, test-email, and forecast-freezing controls remain owner-only.
        </p>
      </section>
    </main>
  );
}

function ApprovalUnavailable({ message }: { message: string }) {
  return (
    <main className="access-shell">
      <section className="access-card">
        <p className="eyebrow">OWNER APPROVAL</p>
        <h1>This request cannot be processed</h1>
        <p className="access-intro">{message}</p>
        <Link className="button button-dark access-link-button" href="/">
          Return to site
        </Link>
      </section>
    </main>
  );
}
