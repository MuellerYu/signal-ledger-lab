/**
 * The server-to-server "flush now" nudge for the service email queue.
 *
 * Auth email is queued by Pages into `email_outbox` and drained by the Worker,
 * which is the only place that can rebuild the magic-link token. In production
 * the minute cron drains the queue; in the sandbox cron is deliberately off, so
 * the nudge below is the only delivery trigger. It is therefore **awaited** (not
 * fire-and-forget) with a short timeout, and every failure is swallowed: the
 * outbox row stays `queued` for a later retry and the caller's response is
 * unchanged, so the nudge can never be used to enumerate addresses or change
 * the sign-in UX. A non-2xx response is logged (never the token), so a 401/404/500
 * is visible in the logs instead of silently reading as success.
 */

import { cleanBaseUrl, getBindings } from "./runtime";

export type ServiceEmailFlushConfig = {
  workerUrl: string | null;
  flushToken: string | null;
};

/**
 * Where and how to nudge the Worker that drains the service email queue.
 *
 * A dedicated `SERVICE_EMAIL_WORKER_URL` takes precedence; `MONITOR_API_URL`
 * is the existing provider-neutral "always-on monitor Worker" convention and
 * points at the same Worker, so it is a valid fallback.
 */
export function serviceEmailFlushConfig(): ServiceEmailFlushConfig {
  const bindings = getBindings();
  return {
    workerUrl:
      cleanBaseUrl(bindings.SERVICE_EMAIL_WORKER_URL) ??
      cleanBaseUrl(bindings.MONITOR_API_URL),
    flushToken: bindings.SERVICE_EMAIL_FLUSH_TOKEN?.trim() || null,
  };
}

const DEFAULT_FLUSH_TIMEOUT_MS = 3_000;

/**
 * Asks the Worker to drain the service email queue now.
 *
 * Fails closed: when the Worker URL or the shared flush token is missing it
 * does nothing — it never sends an unauthenticated request — and when the call
 * fails or times out it returns without throwing. Callers await this and then
 * continue to their uniform response regardless of the outcome.
 *
 * A non-2xx response (401 token mismatch, 404 missing route, 500 worker error)
 * means the queue was NOT drained, so it is logged to make that failure visible
 * instead of looking like a successful no-op. The bearer token is never logged.
 */
export async function nudgeServiceEmailFlush(
  opts: {
    config?: ServiceEmailFlushConfig;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const config = opts.config ?? serviceEmailFlushConfig();
  if (!config.workerUrl || !config.flushToken) return;
  try {
    const fetchFn = opts.fetchImpl ?? fetch;
    const response = await fetchFn(`${config.workerUrl}/internal/service-email/flush`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.flushToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error(
        `[service-email] flush nudge failed with ${response.status} ${response.statusText} ` +
          `(${config.workerUrl}/internal/service-email/flush)`,
      );
    }
  } catch {
    // Best-effort. The outbox row is left `queued` for a retry (cron or a later
    // nudge); the request-link response above is identical either way.
  }
}
