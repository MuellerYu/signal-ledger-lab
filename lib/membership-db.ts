/**
 * The membership/auth database accessor.
 *
 * Membership data (users, auth, subscriptions, email preferences and the
 * service email queue) physically lives in the same D1 as the market data, but
 * it is reached through its own binding. That separation is the whole point:
 * `getD1()` is paired with `ensureDatabase()`, which creates and seeds tables,
 * and pointing that at the live market database would be destructive. Nothing
 * in this module can reach the market database, by construction.
 *
 * Deliberately absent: any fallback to `DB` or `PORTFOLIO_DB`, any call to
 * `ensureDatabase()`, any table creation, any seeding, and any in-memory
 * fallback. When the binding is missing the caller must fail closed — an auth
 * system that silently degrades to memory would hand out sessions that vanish.
 */

import { getBindings } from "./runtime";

/** The membership D1, or null when the binding is not attached. */
export function getMembershipD1(): D1Database | null {
  try {
    return getBindings().MEMBERSHIP_DB ?? null;
  } catch {
    return null;
  }
}

/** The binding name, so error messages and tests cannot drift from the code. */
export const MEMBERSHIP_DB_BINDING = "MEMBERSHIP_DB";
