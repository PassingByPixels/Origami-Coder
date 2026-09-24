// Restore the WHOLE open-set of chat tabs across a VS Code restart, not just the single
// active session: persists the engine session ids of every open chat (in tab order), which
// is active, and the grid layout, then reopens each via loadSession so the transcript
// renders exactly as it was. Engine ids, not local session-N ids, since local ids reset
// every window while the engine's session store persists on disk.

import type { Memento } from 'vscode';

/** What we persist: the open chat sessions' ENGINE ids in tab order, the active
 *  engine id (or null), and whether the sidebar was in grid layout. */
export interface OpenSetState {
  open: string[];
  active: string | null;
  grid: boolean;
}

/** The minimal shape of a live session this module reads. */
interface SessionLike {
  kind?: 'chat' | 'agent';
  client?: { currentSessionId?: string | null } | null;
}

const OPEN_SET_KEY = 'origami.openSessions';

/** Project the live sessions map to the persistable open-set: chat sessions only, in tab
 *  order, each contributing its engine id; a session with no engine id yet is skipped. */
export function computeOpenSet(
  sessions: Iterable<[string, SessionLike]>,
  activeLocalId: string | null,
  grid: boolean,
): OpenSetState {
  const open: string[] = [];
  let active: string | null = null;
  for (const [localId, s] of sessions) {
    if (s.kind === 'agent') continue;
    const engineId = s.client?.currentSessionId;
    if (!engineId) continue;
    open.push(engineId);
    if (localId === activeLocalId) active = engineId;
  }
  return { open, active, grid };
}

/** Read the persisted open-set, or null when absent/malformed (an older install
 *  that only ever wrote ACTIVE_SESSION_KEY -> the single-active fallback). */
export function loadOpenSet(memento: Memento): OpenSetState | null {
  const v = memento.get<OpenSetState>(OPEN_SET_KEY);
  if (!v || !Array.isArray(v.open) || typeof v.grid !== 'boolean') return null;
  const open = v.open.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const active = typeof v.active === 'string' ? v.active : null;
  return { open, active, grid: v.grid };
}

/** True when persisting would replace meaningful state with a premature empty set: the
 *  projection is empty yet chat sessions DO exist (mid-connect, not genuinely closed) —
 *  persist empty only when there are truly no chat tabs left. */
export function isPrematureEmpty(open: readonly string[], sessions: Iterable<[string, SessionLike]>): boolean {
  if (open.length > 0) return false;
  for (const [, s] of sessions) if (s.kind !== 'agent') return true;
  return false;
}

export function saveOpenSet(
  memento: Memento,
  sessions: Iterable<[string, SessionLike]>,
  activeLocalId: string | null,
  grid: boolean,
): void {
  const entries = [...sessions];
  const state = computeOpenSet(entries, activeLocalId, grid);
  if (isPrematureEmpty(state.open, entries)) return;
  void memento.update(OPEN_SET_KEY, state);
}

/** The reopen PLAN: which engine ids to reopen (filtered to existing + not already open,
 *  deduped), the active id if it survived, and the grid layout. Null when nothing is
 *  restorable, so the caller falls back to single-active replay. */
export function planReopen(
  persisted: OpenSetState | null,
  existingEngineIds: ReadonlySet<string>,
  alreadyOpen: ReadonlySet<string>,
): { reopen: string[]; active: string | null; grid: boolean } | null {
  if (!persisted || persisted.open.length === 0) return null;
  const reopen: string[] = [];
  const seen = new Set<string>();
  for (const id of persisted.open) {
    if (seen.has(id) || alreadyOpen.has(id) || !existingEngineIds.has(id)) continue;
    seen.add(id);
    reopen.push(id);
  }
  if (reopen.length === 0) return null;
  const active = persisted.active && existingEngineIds.has(persisted.active) ? persisted.active : null;
  return { reopen, active, grid: persisted.grid };
}

/** Callbacks the panel supplies to enact a plan. `reopen` returns the NEW local
 *  session id (so we can activate the right one after the loop). */
export interface RestoreHost {
  reopen: (engineId: string) => Promise<string>;
  setGrid: (grid: boolean) => void;
  activate: (localId: string) => void;
}

/** Enact a restore: probe which persisted ids still exist, plan, reopen each in order,
 *  restore grid, activate the surviving tab. Returns true iff something was reopened; any
 *  failure returns false without disturbing the persisted set. */
export async function restoreOpenSet(
  persisted: OpenSetState | null,
  client: { listSessions: () => Promise<Array<{ sessionId: string }>> } | null | undefined,
  host: RestoreHost,
): Promise<boolean> {
  if (!persisted || !client) return false;
  let existing: Set<string>;
  try {
    existing = new Set((await client.listSessions()).map((s) => s.sessionId));
  } catch {
    return false;
  }
  const plan = planReopen(persisted, existing, new Set());
  if (!plan) return false;
  host.setGrid(plan.grid);
  const localByEngine = new Map<string, string>();
  for (const engineId of plan.reopen) {
    localByEngine.set(engineId, await host.reopen(engineId));
  }
  const activeLocal = plan.active ? localByEngine.get(plan.active) : undefined;
  if (activeLocal) host.activate(activeLocal);
  return true;
}
