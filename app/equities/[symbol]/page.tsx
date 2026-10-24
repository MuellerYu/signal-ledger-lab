import type { Metadata } from "next";
import EquityResearchDetail from "../../equity-research-detail";
import SiteNav from "../../site-nav";
import { resolveMember } from "@/lib/member-session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Oracle Research",
  description:
    "Oracle equity research, valuation publication gates, earnings analysis and forecast record from Signal Ledger.",
};

export default async function EquityPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const member = await resolveMember();
  return (
    <>
      <SiteNav current="/equities" member={member} />
      <EquityResearchDetail symbol={symbol.toUpperCase()} tier={member.tier} />
    </>
  );
}
