// The `requestHistory` → `historyList` projection: engine session rows in, the
// rows the chat-history dropdown and the Labyrinth run index draw out. Lifted
// out of DashboardPanel.ts (which sits on its architecture cap) so the drop
// rules are testable without an extension host — same reason runStats.ts and
// boardData.ts are their own leaves. No `vscode` import.
//
// WHAT IS DROPPED, and what is deliberately NOT. A session the engine lists is
// history; the ONLY rows this removes are turnless placeholders — the
// "New session - <ISO>" row the engine persists for every new chat, which a
// real turn renames. An unrenamed one never had input, so it is accidental-New-
// chat noise rather than a chat anyone could want back.
//
// The session the caller currently has OPEN is NOT dropped. It used to be, and
// that was the whole defect: `listSessions` returned it, the engine's own
// `session list` returned it, and the run index still had no row for it — a
// live chat looked deleted. It is marked `current` instead, so a surface that
// wants to style it (or skip offering a recall that would be a no-op) can
// decide for itself, and a surface that just lists runs shows all of them.
import * as path from 'path';
import type { CollabMark } from './collabSteps';

/** One row as `AcpClient.listSessions` hands it over. */
export interface HistorySession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

/** One row as the webview receives it on `historyList`. */
export interface HistoryRow extends Partial<CollabMark> {
  sessionId: string;
  title: string;
  /** Basename of `cwd` — the short label a row shows. */
  folder: string;
  /** FULL cwd as well as the basename: `listSessions` falls back to listing
   *  EVERY workspace's sessions when the cwd-scoped query comes back empty, so
   *  a listed run may not belong to this folder. Labyrinth passes this back on
   *  `run_steps`; without it the engine resolves the run against its own
   *  process cwd and finds nothing. */
  cwd: string;
  updatedAt: string;
  /** True for the chat the answering client has open right now. */
  current: boolean;
}

/**
 * The tab already showing this engine session, if one is.
 *
 * The open chat is in the history list now — it IS history, and hiding it was
 * the defect. That makes it recallable, and recalling a chat that is already
 * open has to focus its tab rather than build a second one bound to the same
 * engine session. Keyed on the engine's session id, which is what a history
 * row carries; the returned key is the LOCAL tab id.
 */
export function openTabFor(
  tabs: Iterable<[string, { client?: { currentSessionId: string | null } | null }]>,
  sessionId: string,
): string | undefined {
  if (!sessionId) return undefined;
  for (const [localId, tab] of tabs) {
    if (tab?.client?.currentSessionId === sessionId) return localId;
  }
  return undefined;
}

/**
 * A row that never carried a turn. Blank counts: the engine's live-session
 * entries cross the wire without a title, and an untitled row has no chat to
 * show. `New session - <ISO>` is the engine's own placeholder title.
 */
export function isTurnless(title: string): boolean {
  const s = (title ?? '').trim();
  return !s || /^New session\b/i.test(s);
}

/**
 * Project engine session rows into history rows: turnless ones removed,
 * duplicates collapsed by id, collab labels applied where they exist.
 *
 * `currentSessionId` only MARKS a row. Passing it never removes anything —
 * the run index has to be able to show the run you are sitting in.
 */
export function historyRows(
  sessions: readonly HistorySession[],
  currentSessionId: string | null,
  marks: ReadonlyMap<string, CollabMark> = new Map(),
): HistoryRow[] {
  const seen = new Set<string>();
  const rows: HistoryRow[] = [];
  for (const s of sessions ?? []) {
    const sessionId = String(s?.sessionId ?? '');
    if (!sessionId || seen.has(sessionId)) continue;
    if (isTurnless(s?.title ?? '')) continue;
    seen.add(sessionId);
    rows.push({
      sessionId,
      title: s.title?.trim() || '(untitled chat)',
      folder: s.cwd ? path.basename(s.cwd) : '',
      cwd: s.cwd || '',
      updatedAt: s.updatedAt || '',
      current: sessionId === currentSessionId,
      ...(marks.get(sessionId) ?? {}),
    });
  }
  return rows;
}
