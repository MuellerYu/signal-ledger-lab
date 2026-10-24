import app from "../dist/server/index.js";

const staticPrefixes = ["/assets/", "/reports/"];
const staticFiles = new Set(["/favicon.svg", "/signal-ledger-og.png"]);

function protectStatic(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, context) {
    const pathname = new URL(request.url).pathname;

    if (
      env.ASSETS &&
      (staticFiles.has(pathname) || staticPrefixes.some((prefix) => pathname.startsWith(prefix)))
    ) {
      return protectStatic(await env.ASSETS.fetch(request));
    }

    return app.fetch(request, env, context);
  },
};
