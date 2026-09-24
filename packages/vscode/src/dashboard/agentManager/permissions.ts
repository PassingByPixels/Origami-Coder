// The auto-approve decision for BACKGROUND agent sessions: a kind:'agent' session has no
// mounted webview, so an engine permission ask hangs "working…" forever. When the board
// toggle is ON, such asks are answered host-side with their allow option and a transcript
// note.

/** An ACP permission option as forwarded to the host permission handler. */
export interface PermOption { optionId: string; name: string; kind: string; }

/** Decide how a permission request should be handled: only a background agent session
 *  (kind==='agent') with the toggle ON is auto-allowed; every chat session, and any agent
 *  session with the toggle OFF, forwards to the webview unchanged. */
export function decidePermission(
  kind: 'chat' | 'agent' | undefined,
  autoApprove: boolean,
): 'auto-allow' | 'forward' {
  return kind === 'agent' && autoApprove ? 'auto-allow' : 'forward';
}

/** Pick the option id to auto-allow with: allow-once (least-privilege), else allow-always,
 *  else any non-reject option; null when the request offers no permissive option at all —
 *  the caller then forwards rather than inventing consent or silently denying. */
export function pickAllowOption(options: ReadonlyArray<PermOption>): string | null {
  const byKind = (k: string) => options.find((o) => o.kind === k);
  const allow = byKind('allow_once')
    ?? byKind('allow_always')
    ?? options.find((o) => !o.kind.startsWith('reject'));
  return allow ? allow.optionId : null;
}

/** The transcript note echoed when a permission is auto-approved, so Chat shows what was
 *  consented to. */
export function autoApproveNote(detail: string): string {
  const d = detail.trim();
  return d ? `⚙ auto-approved permission: ${d}` : '⚙ auto-approved permission';
}
