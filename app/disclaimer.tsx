"use client";

import { RESEARCH_DISCLAIMER } from "@/lib/site-config";

/**
 * The shared research disclaimer, rendered on pricing, research surfaces, the
 * Daily Brief and any premium surface. The text lives in one place
 * (lib/site-config) so the inline disclaimer and the global footer can never
 * drift apart, and it is kept visually subtle so it never reads as a sales
 * claim or a warning that the product is unusable.
 */
export default function Disclaimer({ className }: { className?: string }) {
  return (
    <p className={`research-disclaimer${className ? ` ${className}` : ""}`}>
      {RESEARCH_DISCLAIMER}
    </p>
  );
}
