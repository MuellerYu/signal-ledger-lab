"use client";

import { useEffect } from "react";
import SignInForm from "./sign-in-form";

/**
 * The sign-in dialog. It holds no auth state of its own — the form inside is
 * the single source of the request — so closing and reopening it is harmless.
 */
export default function SignInModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Signal Ledger"
      onClick={onClose}
    >
      <div
        className="forecast-modal signin-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>Sign in</h2>
            <p>Signal Ledger · passwordless access</p>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="signin-modal-body">
          <SignInForm />
        </div>
      </div>
    </div>
  );
}
