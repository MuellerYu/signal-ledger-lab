// TEST MODE ONLY. The ten-section email itself lives in lib/postclose-email.ts
// because it is the shipped email; this is only the preview's entry point into
// it, so a section cannot read differently here and in the real send.

import { POST_CLOSE_SECTIONS, renderPostCloseEmail } from "../../lib/postclose-email.ts";

export const SECTIONS = POST_CLOSE_SECTIONS;

export function renderTestModeBrief(brief) {
  return renderPostCloseEmail(brief, { testMode: true });
}
