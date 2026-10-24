import DashboardClient from "./dashboard-client";
import { getChatGPTUser } from "./chatgpt-auth";
import { isSiteOwnerEmail } from "@/lib/site-access";
import { resolveMember } from "@/lib/member-session";

// The research dashboard is live, so the route stays dynamic, but it must not
// do work before first byte. Resolving the coverage shelf here meant awaiting
// twelve canonical snapshots — seconds of SEC retrieval on a cold isolate — and
// that delay was paid on every navigation back to Research. The client loads the
// same snapshots immediately after paint, so the shelf still fills in.
export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await getChatGPTUser();
  const member = await resolveMember();
  const canManage = user ? isSiteOwnerEmail(user.email) : false;
  const { view } = await searchParams;

  // The nav "Bitcoin" and "Live Market Feed" entries deep-link into the
  // dashboard's research tabs. Only the two non-default views are honoured;
  // anything else falls back to U.S. Equities. The value is passed as a prop
  // (not read from next/navigation) so the client never needs a Suspense
  // boundary and the two transpile-based tests keep resolving cleanly.
  const initialView = view === "btc" || view === "world" ? view : "equities";

  // Owner-only controls remain hidden for anonymous visitors and require the
  // authenticated Sites header server-side. The account entry point is resolved
  // from the membership session cookie, independently of the legacy Sites auth.
  return <DashboardClient canManage={canManage} member={member} initialView={initialView} />;
}
