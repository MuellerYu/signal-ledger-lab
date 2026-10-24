"use client";

import { useState } from "react";
import Link from "next/link";
import type { MemberState } from "@/lib/member-session";
import SignInModal from "./sign-in-modal";

/**
 * The account entry point rendered in every page header.
 *
 * Logged out it shows SIGN IN (which opens the sign-in modal); logged in it
 * links to /account and shows the resolved tier. The tier comes from the server
 * (see lib/member-session) and is never derived from anything the browser
 * controls, so this label cannot be spoofed into "PRO" by a client.
 */
export default function AccountControl({ member }: { member: MemberState }) {
  const [open, setOpen] = useState(false);

  if (member.authenticated) {
    return (
      <div className="header-account">
        <Link href="/account" className="account-link">
          ACCOUNT
          <span className="account-link-sep">·</span>
          <span className={`account-tier${member.tier === "PRO" ? " account-tier-pro" : ""}`}>
            {member.tier}
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div className="header-account">
      <Link className="account-plan-link" href="/pricing">FREE &amp; PRO</Link>
      <button
        type="button"
        className="account-signin"
        onClick={() => setOpen(true)}
      >
        SIGN IN
      </button>
      {open ? <SignInModal onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
