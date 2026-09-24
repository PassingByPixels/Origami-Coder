// Persist active /loop schedules across a VS Code window reload, keyed by the engine's
// session id (not the local per-window id, which resets every window). DashboardPanel saves
// on start/tick and removes on stop through one choke point, so persistence can never
// diverge from the live timer. At boot, splitPersistedLoops tells the caller which persisted
// loops now have a live session to re-arm; one that couldn't be restored stays persisted,
// never silently dropped or re-pointed, so the Loops pane can show it and the user can cancel.

import type { Memento } from 'vscode';

/** One persisted loop, keyed by its ENGINE session id. */
export interface PersistedLoop {
  sessionId: string;
  intervalMs: number;
  prompt: string;
  runs: number;
  createdAt: number;
  /** Opt-in: keep this loop running after its chat closes, by recalling the engine session
   *  headlessly and arming the timer there. Absent means false, permanently — every loop
   *  persisted before this field existed must keep dying with its chat. Not a cron: nothing
   *  fires with VS Code closed. */
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

// Restore decisions (split/re-arm/recall) live in loopRearm.ts, re-exported here so callers
// keep one import site.
export { splitPersistedLoops, armRestoredLoops, type RearmHost } from './loopRearm';

/** Flip a persisted loop's `persistent` flag; a no-op if nothing is persisted for that
 *  engine id. */
export function setPersistedLoopPersistence(memento: Memento, engineSessionId: string, persistent: boolean): void {
  const loops = loadPersistedLoops(memento);
  const found = loops.find((l) => l.sessionId === engineSessionId);
  if (!found) return;
  writePersistedLoops(memento, loops.map((l) => (l.sessionId === engineSessionId ? { ...l, persistent } : l)));
}
