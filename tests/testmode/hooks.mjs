// TEST MODE ONLY.
// Two resolutions Node cannot do on its own for these sources:
//   1. `cloudflare:workers` has no meaning outside a Worker -> point it at a stub.
//   2. The lib sources import each other without a file extension -> append .ts.
import { fileURLToPath } from "node:url";

const stub = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;
const hasExtension = /\.[a-z0-9]+$/i;

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: stub, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !hasExtension.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolution and let its error surface.
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  return next(url, context);
}

export { fileURLToPath };
