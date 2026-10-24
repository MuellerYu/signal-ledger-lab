import { getBindings } from "./runtime";

/** A local preview must opt in explicitly; a public deployment cannot grant
 * owner access merely because a visitor supplies a forged Host header. */
export function isLocalOwnerPreviewHost(host: string | null | undefined) {
  return getBindings().LOCAL_OWNER_PREVIEW === "1" &&
    /^(?:127\.0\.0\.1|localhost):4173$/.test(host ?? "");
}

export function isLocalOwnerPreviewRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === "http:" && isLocalOwnerPreviewHost(url.host);
}
