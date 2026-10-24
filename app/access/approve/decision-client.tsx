"use client";

import { useState } from "react";

export default function AccessDecisionClient({
  token,
  initialStatus,
}: {
  token: string;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [submitting, setSubmitting] = useState<
    "approved" | "denied" | null
  >(null);
  const [message, setMessage] = useState("");

  const decide = async (decision: "approved" | "denied") => {
    setSubmitting(decision);
    setMessage("");
    try {
      const response = await fetch("/api/access/decision", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, decision }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The approval action could not be completed.");
      }
      setStatus(payload.status || decision);
      setMessage(
        payload.message ||
          (decision === "approved"
            ? "Approved. This account can now view the site."
            : "Declined. This request will not receive access."),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Approval action failed.");
    } finally {
      setSubmitting(null);
    }
  };

  if (status !== "pending") {
    return (
      <div className={`access-status ${status}`}>
        <strong>
          {status === "approved"
            ? "Access approved"
            : status === "denied"
              ? "Access request declined"
              : "Request already processed"}
        </strong>
        <span>{message || "No further action is required."}</span>
      </div>
    );
  }

  return (
    <>
      <div className="access-decision-actions">
        <button
          className="button button-dark"
          type="button"
          onClick={() => void decide("approved")}
          disabled={submitting !== null}
        >
          {submitting === "approved" ? "Approving…" : "Approve access"}
        </button>
        <button
          className="button button-quiet"
          type="button"
          onClick={() => void decide("denied")}
          disabled={submitting !== null}
        >
          {submitting === "denied" ? "Declining…" : "Decline"}
        </button>
      </div>
      {message ? (
        <p className="access-message" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
}
