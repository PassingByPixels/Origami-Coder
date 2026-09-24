// The requestHistory -> historyList projection: engine session rows in, rows the chat-history
// dropdown and Labyrinth run index draw out. Lifted out of DashboardPanel.ts so the drop rules are
// testable without an extension host.
//
// Only turnless placeholder rows are dropped ("New session - <ISO>", unrenamed by a real turn). The
// session the caller currently has OPEN is never dropped — it used to be, which made a live chat
// look deleted — it is marked `current` instead so a surface can style or skip it.
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
  /** FULL cwd as well as the basename: `listSessions` falls back to listing every workspace's
   *  sessions when the cwd-scoped query is empty, so a listed run may not belong to this folder.
   *  Labyrinth needs this on `run_steps` or the engine resolves against its own process cwd and
   *  finds nothing. */
  cwd: string;
  updatedAt: string;
  /** True for the chat the answering client has open right now. */
  current: boolean;
  /** WHICH history. 'claude' rows come from claudeHistory.ts; both arrive on one `historyList`. */
  kind: 'origami';
}

/**
 * The tab already showing this engine session, if one is. The open chat is now IN the history list,
 *  so recalling it must focus its existing tab rather than build a second one bound to the same
 *  engine session. Keyed on the engine's session id; returns the local tab id.
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
 * A row that never carried a turn — the engine's live-session entries cross the wire with no title,
 *  and `New session - <ISO>` is its own placeholder title.
 */
export function isTurnless(title: string): boolean {
  const s = (title ?? '').trim();
  return !s || /^New session\b/i.test(s);
}

/**
 * Project engine session rows into history rows: turnless ones removed, duplicates collapsed by id,
 *  collab labels applied. `currentSessionId` only MARKS a row — passing it never removes anything,
 *  since the run index must still show the run you are sitting in.
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
      current: sessionId === currentSessionId, kind: 'origami',
      ...(marks.get(sessionId) ?? {}),
    });
  }
  return rows;
}
