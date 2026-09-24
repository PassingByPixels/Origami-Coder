// skillsScopeState.ts — persisted Local/Global filter for SkillsPane (t-7vslix).
// Same `vscode.getState()`/`setState()` seam ChatsList.svelte's Claude-Code
// toggle uses (historyKinds.ts's `claudeShownIn`/`withClaudeShown`): scoped to
// this webview in this window, survives the webview being hidden and rebuilt,
// and a tab switch or window reload reads the same key back.

export type SkillsScope = 'local' | 'global';

/** Where the filter lives in `vscode.getState()`. */
const SCOPE_KEY = 'skillsScope';

/** GLOBAL by default — most of a user's skills are user-level (available from
 *  any workspace), so that is the more useful first view; a project with its
 *  own `.origami/skills` is the exception, not the common case. */
export const DEFAULT_SCOPE: SkillsScope = 'global';

/** The saved filter, or the default for a first-ever load or a malformed value. */
export function scopeIn(state: unknown): SkillsScope {
  const saved = (state as Record<string, unknown> | null)?.[SCOPE_KEY];
  return saved === 'local' || saved === 'global' ? saved : DEFAULT_SCOPE;
}

/** The next state object to hand `vscode.setState`, every other key kept. */
export function withScope(state: unknown, scope: SkillsScope): Record<string, unknown> {
  return { ...((state as Record<string, unknown> | null) ?? {}), [SCOPE_KEY]: scope };
}
