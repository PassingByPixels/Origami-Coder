// historyKinds.ts — the History popup lists two kinds of past chat, and
// this is every rule that follows from that.
//
// A leaf because ChatsList.svelte is on its cap and none of this is
// drawing: the filter, the mark, the row projection and which message a
// pick sends are all decisions, testable with no DOM.
//
// The mark is `CC`, not a new glyph: that's the label ControlStrip.svelte
// already puts on the Claude Code square, the one place in this UI that
// says "this runs on your own CLI". A history row for one of those
// conversations gets the same two letters.
//
// A pick is routed here since an Origami row is recalled through the
// engine, but a Claude row has no engine session behind it, only a
// `.jsonl`, and can only continue as a passthrough cell spawned with
// `--resume` in the folder the session was made in — so the row carries
// its own `cwd` and the pick posts a different message.

/** Which side a row came from. Absent on an older host build, reads as Origami. */
export type HistoryKind = 'origami' | 'claude';

/** One row as `historyList` delivers it. The token fields are absent on
 *  Origami rows and, for now, unread on Claude ones. `turns` is the
 *  exception: it's what the mark's tooltip says about the chat. */
export interface HistoryItem {
  sessionId: string;
  title: string;
  folder: string;
  updatedAt: string;
  kind?: HistoryKind;
  cwd?: string;
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: string;
  partial?: boolean;
}

/** A row as HistoryDropdown.svelte draws it. */
export interface HistoryDropdownRow {
  id: string;
  title: string;
  meta?: string;
  tooltip?: string;
  mark?: string;
  markTitle?: string;
}

/** The Claude Code square's label in ControlStrip.svelte. One symbol, one
 *  meaning — see the header. */
export const CLAUDE_MARK = 'CC';

export function isClaudeRow(item: HistoryItem | undefined | null): boolean {
  return item?.kind === 'claude';
}

/** Search text and the show/hide toggle. The toggle hides only Claude rows:
 *  a "show the other side too" switch, not a mode. */
export function filterHistory(items: readonly HistoryItem[], query: string, showClaude: boolean): HistoryItem[] {
  const q = (query ?? '').trim().toLowerCase();
  return (items ?? []).filter((h) => {
    if (!showClaude && isClaudeRow(h)) return false;
    if (!q) return true;
    return `${h.title} ${h.folder}`.toLowerCase().includes(q);
  });
}

/** The dim second line of a row. Exported for the Insights card, which shows
 *  the same folder + date pair. */
export function fmtHistoryDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Rows in, drawable rows out. The mark is set on Claude rows only, so an
 *  Origami row has no mark rather than a blank one. */
export function historyDropdownRows(items: readonly HistoryItem[]): HistoryDropdownRow[] {
  return (items ?? []).map((h) => ({
    id: h.sessionId,
    title: h.title,
    meta: [h.folder, fmtHistoryDate(h.updatedAt)].filter(Boolean).join(' · '),
    ...(isClaudeRow(h)
      ? { mark: CLAUDE_MARK, markTitle: `Claude Code chat${h.turns ? ` — ${h.turns} replies` : ''}; opens as a passthrough that resumes it` }
      : {}),
  }));
}

/** What a pick posts to the host. An unknown id falls back to the Origami
 *  recall, which is what every id meant before this existed. */
export function historyPickMessage(items: readonly HistoryItem[], id: string): Record<string, unknown> {
  const hit = (items ?? []).find((h) => h.sessionId === id);
  if (!isClaudeRow(hit) || !hit?.cwd) return { type: 'recallSession', sessionId: id };
  return { type: 'openClaudeHistory', claudeSessionId: id, cwd: hit.cwd, title: hit.title };
}

/** Where the toggle's state lives in `vscode.getState()`. */
const SHOW_CLAUDE_KEY = 'historyShowClaude';

/** Shown unless the user turned it off. `vscode.getState()` rather than
 *  `localStorage`: scoped to this webview in this window, and survives the
 *  webview being hidden and rebuilt. */
export function claudeShownIn(state: unknown): boolean {
  return (state as Record<string, unknown> | null)?.[SHOW_CLAUDE_KEY] !== false;
}

/** The next state object to hand `vscode.setState`, every other key kept. */
export function withClaudeShown(state: unknown, on: boolean): Record<string, unknown> {
  return { ...((state as Record<string, unknown> | null) ?? {}), [SHOW_CLAUDE_KEY]: on };
}
