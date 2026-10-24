import { cleanBaseUrl, getBindings } from "./runtime";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs = 8_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export type MonitorDashboardResult =
  | { configured: false }
  | { configured: true; ok: true; data: JsonRecord }
  | { configured: true; ok: false; error: string };

export async function fetchMonitorDashboard(): Promise<MonitorDashboardResult> {
  const bindings = getBindings();
  const baseUrl = cleanBaseUrl(bindings.MONITOR_API_URL);
  if (!baseUrl) return { configured: false };

  const headers = new Headers({ Accept: "application/json" });
  if (bindings.MONITOR_READ_TOKEN) {
    headers.set("Authorization", `Bearer ${bindings.MONITOR_READ_TOKEN}`);
  }

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/dashboard`, {
      headers,
      cache: "no-store",
    });
    if (!response.ok) {
      const failure = asRecord(await response.json().catch(() => null));
      const isQuota = /daily.*(?:read|limit)|exceeded.*D1|row read limit/i.test(
        String(failure?.detail ?? failure?.error ?? ""),
      );
      return {
        configured: true,
        ok: false,
        error: isQuota ? "The daily database read limit has been reached." : `Monitor API returned ${response.status}.`,
      };
    }

    const payload = asRecord(await response.json());
    const nested =
      asRecord(payload?.data) ?? asRecord(payload?.dashboard) ?? payload;
    if (!nested) {
      return {
        configured: true,
        ok: false,
        error: "Monitor API returned an invalid dashboard payload.",
      };
    }

    const upstreamSystem = asRecord(nested.system) ?? {};
    return {
      configured: true,
      ok: true,
      data: {
        ...nested,
        system: {
          ...upstreamSystem,
          monitoring: "external_cron",
          monitorApi: "online",
        },
      },
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error: error instanceof Error ? error.message : "Monitor API fetch failed.",
    };
  }
}

export type MonitorRefreshResult =
  | { configured: false }
  | { configured: true; ok: true; data: unknown }
  | { configured: true; ok: false; error: string };

export async function forwardMonitorRefresh(): Promise<MonitorRefreshResult> {
  const bindings = getBindings();
  const baseUrl = cleanBaseUrl(bindings.MONITOR_API_URL);
  if (!baseUrl || !bindings.CRON_SECRET) return { configured: false };

  try {
    const response = await fetchWithTimeout(`${baseUrl}/internal/run`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bindings.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger: "sites_manual" }),
    });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      return {
        configured: true,
        ok: false,
        error: `Monitor refresh returned ${response.status}.`,
      };
    }
    return { configured: true, ok: true, data };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error:
        error instanceof Error ? error.message : "Monitor refresh request failed.",
    };
  }
}

export type MonitorTestEmailResult =
  | { configured: false }
  | { configured: true; ok: true; status: number; data: unknown }
  | {
      configured: true;
      ok: false;
      status: number;
      error: string;
      data?: unknown;
    };

export async function forwardMonitorTestEmail(
  force = false,
): Promise<MonitorTestEmailResult> {
  const bindings = getBindings();
  const baseUrl = cleanBaseUrl(bindings.MONITOR_API_URL);
  if (!baseUrl || !bindings.CRON_SECRET) return { configured: false };

  const url = new URL(`${baseUrl}/internal/test-email`);
  if (force) url.searchParams.set("force", "1");

  try {
    const response = await fetchWithTimeout(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bindings.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger: "sites_manual" }),
    });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const record = asRecord(data);
      return {
        configured: true,
        ok: false,
        status: response.status,
        error:
          (typeof record?.error === "string" && record.error) ||
          `Monitor test email returned ${response.status}.`,
        data,
      };
    }
    return {
      configured: true,
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: 502,
      error:
        error instanceof Error
          ? error.message
          : "Monitor test email request failed.",
    };
  }
}

export type AccessRequestEmailInput = {
  requestId: string;
  requesterEmail: string;
  requesterName: string;
  approvalUrl: string;
  ownerEmail: string;
};

export type AccessRequestEmailResult =
  | { configured: false; ok: false; error: string }
  | { configured: true; ok: true; status: number; data: unknown }
  | {
      configured: true;
      ok: false;
      status: number;
      error: string;
      data?: unknown;
    };

export async function forwardAccessRequestEmail(
  input: AccessRequestEmailInput,
): Promise<AccessRequestEmailResult> {
  const bindings = getBindings();
  const baseUrl = cleanBaseUrl(bindings.MONITOR_API_URL);
  if (!baseUrl || !bindings.CRON_SECRET) {
    return {
      configured: false,
      ok: false,
      error: "The protected Gmail delivery service is unavailable.",
    };
  }

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/internal/access-request-email`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bindings.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
      20_000,
    );
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const record = asRecord(data);
      return {
        configured: true,
        ok: false,
        status: response.status,
        error:
          (typeof record?.error === "string" && record.error) ||
          `Access request email returned ${response.status}.`,
        data,
      };
    }
    return {
      configured: true,
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: 502,
      error:
        error instanceof Error
          ? error.message
          : "Access request email delivery failed.",
    };
  }
}

export type MonitorForecastResult =
  | { configured: false }
  | { configured: true; ok: true; status: number; data: unknown }
  | {
      configured: true;
      ok: false;
      status: number;
      error: string;
      data?: unknown;
    };

export async function forwardMonitorForecast(
  payload: unknown,
): Promise<MonitorForecastResult> {
  const bindings = getBindings();
  const baseUrl = cleanBaseUrl(bindings.MONITOR_API_URL);
  if (!baseUrl) return { configured: false };
  if (!bindings.MONITOR_READ_TOKEN) {
    return {
      configured: true,
      ok: false,
      status: 503,
      error: "MONITOR_READ_TOKEN is required to freeze forecasts upstream.",
    };
  }

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/forecasts`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bindings.MONITOR_READ_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { message: text };
      }
    }
    if (!response.ok) {
      const record = asRecord(data);
      return {
        configured: true,
        ok: false,
        status: response.status,
        error:
          (typeof record?.error === "string" && record.error) ||
          `Monitor forecast returned ${response.status}.`,
        data,
      };
    }
    return {
      configured: true,
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: 502,
      error:
        error instanceof Error
          ? error.message
          : "Monitor forecast request failed.",
    };
  }
}
