import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { resolveMember } from "@/lib/member-session";
import { isSiteOwnerEmail } from "@/lib/site-access";
import { isLocalOwnerPreviewHost } from "@/lib/local-owner-preview";
import OwnerValuationEditor from "./editor";
import "./editor.css";

export const dynamic = "force-dynamic";

export default async function OwnerValuationPage({ searchParams }: { searchParams: Promise<{ ticker?: string }> }) {
  const member = await resolveMember();
  const localPreview = isLocalOwnerPreviewHost((await headers()).get("host"));
  if (!localPreview && (!member.authenticated || !member.email || !isSiteOwnerEmail(member.email))) notFound();
  const { ticker } = await searchParams;
  return <OwnerValuationEditor initialTicker={(ticker ?? "NVDA").toUpperCase()} />;
}
