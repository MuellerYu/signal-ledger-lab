import OptionsWorkstation from "./workstation";
import { resolveMember } from "@/lib/member-session";
import "./options.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Options Workstation | Signal Ledger" };
export default async function OptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string }>;
}) {
  const { ticker } = await searchParams;
  const requested = (ticker ?? "").trim().toUpperCase();
  // A ticker passed in from research, the valuation page or a link always opens
  // on the neutral Option Chain tab; it never selects a strategy for the user.
  const initialTicker = /^[A-Z][A-Z0-9.\-]{0,7}$/.test(requested) ? requested : null;
  const member = await resolveMember();
  return <OptionsWorkstation initialTicker={initialTicker} member={member} />;
}
