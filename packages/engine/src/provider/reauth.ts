/**
 * Which stored OAuth credentials the provider has refused to refresh. A dead
 * refresh_token leaves `auth.json` well-formed, so `Auth.all()` still reports a
 * healthy `oauth` credential while every turn fails in the plugin loader's
 * `fetch` (`plugin/xai.ts`, `plugin/openai/codex.ts`); this table is what tells
 * the user the one thing that fixes it — sign in again.
 *
 * The credential itself is never deleted: another process may still be
 * refreshing it, and removing it would drop the provider from the model list.
 * The flag is process-local by design — it records THIS engine's own refresh
 * attempts, so a fresh engine starts empty and re-learns rather than holding a
 * re-authorized credential marked dead.
 */

/** Statuses that mean the GRANT was refused, rather than the request failing. */
const REFUSED = new Set([400, 401, 403])

/** Keep the provider's own wording, but it goes on one line in a UI. */
const REASON_MAX = 300

const refused = new Map<string, string>()

/** Record a refusal — no-op for any status that is not a refusal of the grant. */
export function markIfRefused(providerID: string, status: number, reason: string): void {
  if (!REFUSED.has(status)) return
  refused.set(providerID, reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}…` : reason)
}

/** A refresh (or a fresh sign-in) worked: the credential is good again. */
export function clear(providerID: string): void {
  refused.delete(providerID)
}

/** The provider's own words, or undefined when this credential is not refused. */
export function reason(providerID: string): string | undefined {
  return refused.get(providerID)
}

/** Visible for tests: no refusal leaks across cases. */
export function reset(): void {
  refused.clear()
}

export * as ProviderReauth from "./reauth"
