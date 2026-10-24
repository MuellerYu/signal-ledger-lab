import {
  DEFAULT_ALERT_RECIPIENT,
  getBindings,
} from "./runtime";

const TRUSTED_SITES_SUFFIX = ".chatgpt.site";

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function sameSecret(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isTrustedSitesRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === "https:" && url.hostname.endsWith(TRUSTED_SITES_SUFFIX);
}

function isSameOriginWrite(request: Request) {
  if (["GET", "HEAD"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function isAuthorizedMutation(request: Request) {
  const bindings = getBindings();
  const allowedEmail = (
    bindings.ALLOWED_EMAIL ??
    bindings.ALERT_RECIPIENT ??
    DEFAULT_ALERT_RECIPIENT
  ).toLowerCase();
  const authenticatedEmail = (
    request.headers.get("oai-authenticated-user-email") ?? ""
  ).toLowerCase();
  // Sites dispatch owns these identity headers. A public Cloudflare hostname
  // must never trust the same names because any visitor can send them.
  if (
    isTrustedSitesRequest(request) &&
    isSameOriginWrite(request) &&
    authenticatedEmail &&
    authenticatedEmail === allowedEmail
  ) {
    return true;
  }

  const configuredToken = bindings.ADMIN_TOKEN?.trim() ?? "";
  const suppliedToken = bearerToken(request);
  return (
    configuredToken.length >= 32 &&
    suppliedToken.length >= 32 &&
    sameSecret(suppliedToken, configuredToken)
  );
}

export function unauthorizedResponse() {
  return Response.json(
    {
      error:
        "This owner action requires verified authorization.",
      status: "unauthorized",
    },
    {
      status: 401,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "WWW-Authenticate": "Bearer",
      },
    },
  );
}
