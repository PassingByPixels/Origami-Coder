// loopPersistence.ts — persist active /loop schedules (chatCommands.ts's
// interval scheduler, armed by DashboardPanel.startLoopSchedule) across a
// VS Code window reload. Keyed by the engine's session id, not the local
// session-N id — local ids reset every window (sessionCounter is module
// state) while the engine's session store persists on disk; see
// sessionRestore.ts, whose engine-id reasoning this mirrors for the open
// chat set.
//
// DashboardPanel calls savePersistedLoop() when a loop starts or ticks
// (keeping `runs` current) and removePersistedLoop() when it stops — via
// /loop stop, the Loops-pane cancel control, Stop, session close, or a
// permanent-done run. stopLoopSchedule is the ONE choke point all of those
// share, so persistence can never diverge from the live timer.
//
// At boot, once sessionRestore.ts has reopened the surviving chats,
// splitPersistedLoops tells the caller which persisted loops now have a
// live session to re-arm and which do not. A session that could not be
// restored is NEVER silently dropped or re-pointed at a different chat —
// it stays persisted exactly as it was, so the Loops pane can show it
// (prompt intact) and the user can cancel it explicitly.

import type { Memento } from 'vscode';

/** One persisted loop, keyed by its ENGINE session id. */
export interface PersistedLoop {
  sessionId: string;
  intervalMs: number;
  prompt: string;
  runs: number;
  createdAt: number;
  /**
   * Opt-in: keep this loop running after its CHAT is closed, by recalling the
   * engine session headlessly (no webview) and arming the timer there.
   *
   * ABSENT MEANS FALSE, and must keep meaning false forever — every loop
   * persisted before this field existed is a plain loop whose owner expects it
   * to die with the chat. A missing flag is never an invitation to guess.
   *
   * This is NOT a cron. Nothing fires with VS Code closed; a persistent loop
   * survives a closed chat and a window restart, not a shut editor.
   */
  persistent?: boolean;
}

/** The one place "is this loop persistent?" is decided, so absent-means-false
 *  cannot be re-litigated (or accidentally inverted) at each call site. */
export function isPersistent(loop: Pick<PersistedLoop, 'persistent'>): boolean {
  return loop.persistent === true;
}

const LOOP_SCHEDULES_KEY = 'origami.loopSchedules';

function isPersistedLoop(v: unknown): v is PersistedLoop {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return typeof l.sessionId === 'string' && l.sessionId.length > 0
    && typeof l.intervalMs === 'number'
    && typeof l.prompt === 'string'
    && typeof l.runs === 'number'
    && typeof l.createdAt === 'number'
    // Optional — a record written before the field existed is VALID, not
    // malformed. Only a present-but-wrong-typed value is a corrupt write.
    && (l.persistent === undefined || typeof l.persistent === 'boolean');
}

/** Read the persisted loops, dropping anything malformed (an older install
 *  or a corrupted write) rather than throwing. */
export function loadPersistedLoops(memento: Memento): PersistedLoop[] {
  const v = memento.get<PersistedLoop[]>(LOOP_SCHEDULES_KEY);
  return Array.isArray(v) ? v.filter(isPersistedLoop) : [];
}

function writePersistedLoops(memento: Memento, loops: PersistedLoop[]): void {
  void memento.update(LOOP_SCHEDULES_KEY, loops);
}

/** A loop started or ticked — upsert its record (replacing any prior entry
 *  for the same engine session; a session runs at most one loop). */
export function savePersistedLoop(memento: Memento, entry: PersistedLoop): void {
  const loops = loadPersistedLoops(memento).filter((l) => l.sessionId !== entry.sessionId);
  loops.push(entry);
  writePersistedLoops(memento, loops);
}

/** A loop stopped — drop its record so a later reload can't resurrect it.
 *  No-op (no extra write) when nothing was persisted for this id. */
export function removePersistedLoop(memento: Memento, engineSessionId: string): void {
  const loops = loadPersistedLoops(memento);
  const next = loops.filter((l) => l.sessionId !== engineSessionId);
  if (next.length !== loops.length) writePersistedLoops(memento, next);
}

// The restore DECISIONS (split / re-arm / recall) live in loopRearm.ts, which
// was split out when persistent loops pushed this file past its cap. Re-exported
// so callers keep one import site.
export { splitPersistedLoops, armRestoredLoops, type RearmHost } from './loopRearm';

/** Flip a persisted loop's `persistent` flag in place. No-op when nothing is
 *  persisted for that engine id — the caller's live state is the other half of
 *  the pair and is updated by DashboardPanel. */
export function setPersistedLoopPersistence(memento: Memento, engineSessionId: string, persistent: boolean): void {
  const loops = loadPersistedLoops(memento);
  const found = loops.find((l) => l.sessionId === engineSessionId);
  if (!found) return;
  writePersistedLoops(memento, loops.map((l) => (l.sessionId === engineSessionId ? { ...l, persistent } : l)));
}
