// Which sub-agent rows a chat has RETIRED from its drawer (t-fiszlv R9).
//
// The × on a row and the failed-spawn dismiss were webview state only, so a
// window reload resurrected every row they had removed — a chat that fanned out
// all afternoon came back carrying every corpse the owner had already cleared.
// (t-h8gv8w retired the bulk clear and the age sweep: a finished row is history
// the drawer keeps, and the row's × is the only way out.)
//
// WHY A MEMENTO AND NOT THE SESSION LOG. The dismissal is OURS: the engine knows
// nothing about it, so it cannot ride the transcript the way the done marker and
// the token total do. A window reload reopens each chat through the engine by its
// ENGINE session id (agentManager/sessionRestore.ts) and rebuilds the message log
// from the `session/load` replay — the host's own log starts EMPTY, so a rider
// written into it would not survive the one event this exists for. The workspace
// memento does, and it is keyed by the same engine id the open-set is.
//
// BOUNDED on purpose: this is housekeeping, not a record. The oldest chats fall
// off the end rather than growing a list nobody prunes.

/** The `vscode.Memento` slice this reads — a plain shape so the store is
 *  testable with no `vscode` at all. */
export interface DismissedMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

export const SUBAGENT_DISMISSED_KEY = 'origami.subagentDismissed';

/** How many chats keep a set, and how many keys one chat keeps. A fan-out of a
 *  dozen an hour for a long day is well inside both. */
const MAX_CHATS = 40;
const MAX_KEYS = 300;

type Store = Record<string, string[]>;

function readStore(memento: DismissedMemento): Store {
  const raw = memento.get<unknown>(SUBAGENT_DISMISSED_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Store = {};
  for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !Array.isArray(keys)) continue;
    out[id] = keys.filter((k): k is string => typeof k === 'string' && k !== '');
  }
  return out;
}

/** Every row this chat has retired, oldest first. `''` for an engine id answers
 *  empty: a chat with no engine session has nothing persisted to find. */
export function readSubagentDismissed(memento: DismissedMemento, engineId: string | null | undefined): string[] {
  if (!engineId) return [];
  return readStore(memento)[engineId] ?? [];
}

/**
 * Record ONE retired row. Re-inserted last so the chat counts as the most
 * recently used — object key order is the eviction order, and a chat still
 * being worked in must not fall off the end because it was opened first.
 */
export function noteSubagentDismissed(
  memento: DismissedMemento,
  engineId: string | null | undefined,
  key: string,
): void {
  if (!engineId || !key) return;
  const store = readStore(memento);
  const held = store[engineId] ?? [];
  if (held.includes(key) && Object.keys(store).at(-1) === engineId) return;
  const keys = held.includes(key) ? held : [...held, key].slice(-MAX_KEYS);
  delete store[engineId];
  const next: Store = { ...store, [engineId]: keys };
  for (const stale of Object.keys(next).slice(0, -MAX_CHATS)) delete next[stale];

  void memento.update(SUBAGENT_DISMISSED_KEY, next);
}
