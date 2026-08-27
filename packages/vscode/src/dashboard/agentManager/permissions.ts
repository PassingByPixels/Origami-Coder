// Agent Manager - permissions.ts (S5.2): the auto-approve decision for
// BACKGROUND agent sessions. A kind:'agent' session runs with no mounted
// webview, so an engine permission ask (e.g. external_directory for the parent
// repo path) has no surface that can answer it - the run hangs in "working…"
// forever. When the board toggle is ON we answer such asks host-side with their
// allow option and echo a transcript note. Pure + vscode-free so the decision
// and option-picking unit-test as functions; the DashboardPanel handler is the
// thin wiring around these.

/** An ACP permission option as forwarded to the host permission handler. */
export interface PermOption { optionId: string; name: string; kind: string; }

/**
 * Decide how a permission request should be handled for a session of `kind`.
 * ONLY a background agent session (kind === 'agent') with the board toggle ON is
 * auto-allowed; every chat session, and any agent session with the toggle OFF,
 * is forwarded to the webview unchanged (today's behaviour - which may hang for
 * a background agent, but that is then the user's explicit choice).
 */
export function decidePermission(
  kind: 'chat' | 'agent' | undefined,
  autoApprove: boolean,
): 'auto-allow' | 'forward' {
  return kind === 'agent' && autoApprove ? 'auto-allow' : 'forward';
}

/**
 * Pick the option id to answer an auto-allowed request with: the allow-once
 * option (least-privilege positive consent - exactly what the webview's approve
 * path would select), else allow-always, else any non-reject option; null when
 * the request carries no permissive option at all (the caller then FORWARDS
 * rather than inventing consent or silently denying). Mirrors the engine's
 * option set (packages/engine/src/acp/permission.ts: allow_once / allow_always
 * / reject_once).
 */
export function pickAllowOption(options: ReadonlyArray<PermOption>): string | null {
  const byKind = (k: string) => options.find((o) => o.kind === k);
  const allow = byKind('allow_once')
    ?? byKind('allow_always')
    ?? options.find((o) => !o.kind.startsWith('reject'));
  return allow ? allow.optionId : null;
}

/**
 * The one-line transcript note echoed into an agent chat when a permission was
 * auto-approved, so Chat shows what was consented to. `detail` = the tool title
 * and/or its resolved target (path / dir / url / command).
 */
export function autoApproveNote(detail: string): string {
  const d = detail.trim();
  return d ? `⚙ auto-approved permission: ${d}` : '⚙ auto-approved permission';
}
