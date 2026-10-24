import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

const pagesWorker = `import app from "../server/index.js";

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
`;

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }

      const clientOutput = resolve(root, "dist", "client");
      await mkdir(clientOutput, { recursive: true });
      await writeFile(resolve(clientOutput, "_worker.js"), pagesWorker);
    },
  };
}
