"use client";

import { FormEvent, useState } from "react";

/**
 * The one email entry point for passwordless sign-in.
 *
 * It POSTs to /api/auth/request-link, which always answers the same way whether
 * the address is known, unknown or rate-limited — so the client learns only
 * "check your inbox", never whether an account exists.
 */

const looksLikeEmail = (value: string) =>
  /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= 254;

type Status = "idle" | "submitting" | "sent";

export default function SignInForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError("Enter a valid email address.");
      return;
    }

    setStatus("submitting");
    setError("");
    try {
      const response = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });

      if (response.ok) {
        setStatus("sent");
      } else if (response.status === 503) {
        setError("Sign-in is temporarily unavailable. Please try again shortly.");
        setStatus("idle");
      } else {
        setError("Something went wrong. Please try again.");
        setStatus("idle");
      }
    } catch {
      setError("Couldn't reach Signal Ledger. Check your connection and try again.");
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="signin-sent">
        <p className="signin-sent-mark" aria-hidden="true">
          ✓
        </p>
        <h3>Check your inbox</h3>
        <p>
          We sent a secure sign-in link to <strong>{email.trim()}</strong>. It
          expires in 15 minutes.
        </p>
        <p className="signin-sent-note">
          No password needed — the link signs you in directly.
        </p>
      </div>
    );
  }

  return (
    <form className="signin-form" onSubmit={submit}>
      <div className="field">
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoFocus
        />
      </div>

      {error ? (
        <p className="signin-error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="button button-dark"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "Sending…" : "Email me a sign-in link"}
      </button>

      <p className="signin-terms">
        One-time sign-in email. No password, no spam, no tracking.
      </p>
    </form>
  );
}
