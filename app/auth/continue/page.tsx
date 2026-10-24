import Link from "next/link";

/**
 * The interstitial screen.
 *
 * It carries no token and holds no state beyond the signed pending-auth cookie
 * the GET set, so reloading it is safe and following it from a mail scanner
 * accomplishes nothing. It exists only to give the reader an explicit, human
 * confirmation step before the link is consumed.
 */
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid: "This sign-in link is invalid or has expired. Please request a new one.",
  already_consumed: "This sign-in link has already been used. Please request a new one.",
  link_invalid: "This sign-in link is invalid or has expired. Please request a new one.",
  pending_cookie_invalid: "Your sign-in session expired. Please click the link in your email again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
};

export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const problem = status
    ? (MESSAGES[status] ?? "We couldn't continue your sign-in. Please request a new link.")
    : null;

  if (problem) {
    return (
      <main className="continue-shell">
        <section className="continue-card">
          <header className="continue-brand">
            <span className="brand-mark" aria-hidden="true">SL</span>
            <span className="brand-name">Signal Ledger</span>
          </header>
          <h1>Sign-in expired</h1>
          <p>{problem}</p>
          <p className="continue-back">
            <Link href="/">Back to Signal Ledger</Link>
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="continue-shell">
      <section className="continue-card">
        <header className="continue-brand">
          <span className="brand-mark" aria-hidden="true">SL</span>
          <span className="brand-name">Signal Ledger</span>
        </header>
        <h1>Email verified</h1>
        <p>
          You&apos;re almost in. Press the button below to finish signing in to
          Signal Ledger — this final step needs you, so a mail scanner
          can&apos;t use your link on your behalf.
        </p>
        <div className="continue-actions">
          <form method="POST" action="/api/auth/consume">
            <button type="submit" className="button button-dark">
              Continue to Signal Ledger
            </button>
          </form>
        </div>
        <p className="continue-note">
          Passwordless sign-in — no password, no shared link, no tracking.
        </p>
      </section>
    </main>
  );
}
