// Persistence for the sidebar's chat-grouping feature.
//
// Only "Main" is built-in (pinned, undeletable, never stored); sections exist only
// when the user makes one. Retired fixed sections fold back to Main on load.

import type { Memento } from 'vscode';

/** A user-created section. `id` is generated once (addSection) and is what
 *  membership entries and rename/delete target — never the display name,
 *  which can change. */
export interface ChatSectionDef {
  id: string;
  name: string;
  collapsed: boolean;
}

/** What we persist: which chat is in which section, and each section's
 *  collapse state. `membership[id]` is one of `sections[].id`; ABSENT means
 *  Main — Main is never stored, it is "everything left over" (including a
 *  chat whose section was since deleted, or named a built-in that no longer
 *  exists — see loadChatSections). */
export interface ChatSectionsState {
  membership: Record<string, string>;
  sections: ChatSectionDef[];
  mainCollapsed: boolean;
}

const CHAT_SECTIONS_KEY = 'origami.chatSections';
export const DEFAULT_SECTION_NAME = 'New Section';

export function defaultChatSectionsState(): ChatSectionsState {
  return { membership: {}, sections: [], mainCollapsed: false };
}

/** The id the pre-v2 single "spare" custom section always migrated onto.
 *  Rejected here (like a blank or duplicate id) so an install that ran that
 *  old migration doesn't have it resurface as if the user made it. */
const LEGACY_SECTION_ID = 'legacy-custom';

function parseSections(raw: unknown): ChatSectionDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChatSectionDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!id || !name || seen.has(id) || id === LEGACY_SECTION_ID) continue;
    seen.add(id);
    out.push({ id, name, collapsed: e.collapsed === true });
  }
  return out;
}

/**
 * Read the persisted state, or sane defaults when absent/malformed. Each
 * membership entry is validated individually so a corrupt map can't sink the
 * rest of the sidebar; an entry naming a retired section folds to Main.
 */
export function loadChatSections(memento: Memento): ChatSectionsState {
  const v = memento.get<Record<string, unknown>>(CHAT_SECTIONS_KEY);
  if (!v || typeof v !== 'object') return defaultChatSectionsState();

  const sections = parseSections(v.sections);
  const sectionIds = new Set(sections.map((s) => s.id));

  const membership: Record<string, string> = {};
  if (v.membership && typeof v.membership === 'object') {
    for (const [id, section] of Object.entries(v.membership as Record<string, unknown>)) {
      if (!id) continue;
      if (typeof section === 'string' && sectionIds.has(section)) membership[id] = section;
    }
  }

  return {
    membership,
    sections,
    mainCollapsed: v.mainCollapsed === true,
  };
}

export function saveChatSections(memento: Memento, state: ChatSectionsState): void {
  void memento.update(CHAT_SECTIONS_KEY, state);
}

/** Set (section given — a `sections[].id`) or clear (section null, i.e.
 *  Main) one chat's membership. */
export function withSessionSection(
  state: ChatSectionsState,
  sessionId: string,
  section: string | null,
): ChatSectionsState {
  const membership = { ...state.membership };
  if (section) membership[sessionId] = section;
  else delete membership[sessionId];
  return { ...state, membership };
}

/** Drop membership entries for chats that no longer exist, so a long-lived
 *  window's persisted map cannot grow forever with dead ids. Returns the SAME
 *  object when nothing changed, so a caller can skip an idle persist/echo. */
export function pruneChatSections(state: ChatSectionsState, liveIds: ReadonlySet<string>): ChatSectionsState {
  let changed = false;
  const membership: Record<string, string> = {};
  for (const [id, section] of Object.entries(state.membership)) {
    if (liveIds.has(id)) membership[id] = section;
    else changed = true;
  }
  return changed ? { ...state, membership } : state;
}

/** A fresh id for a newly created section — same shape as cronState.ts's and
 *  agentManager/state.ts's generators (timestamp + random, base36). Exposed
 *  so `addSection` can take a deterministic one under test. */
export function generateSectionId(): string {
  return `sec${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Create a section and return both the new state and the id it landed on —
 *  the caller (DashboardPanel) needs the id to reply/broadcast which chat, if
 *  any, should move into it immediately. A blank/whitespace name falls back
 *  to DEFAULT_SECTION_NAME rather than creating a nameless section. */
export function addSection(
  state: ChatSectionsState,
  name: string,
  genId: () => string = generateSectionId,
): { state: ChatSectionsState; id: string } {
  const id = genId();
  const trimmed = name.trim() || DEFAULT_SECTION_NAME;
  return { state: { ...state, sections: [...state.sections, { id, name: trimmed, collapsed: false }] }, id };
}

/** Delete a user section. Every chat in it moves back to Main (membership
 *  removed, not repointed). Returns the SAME object when `id` names no section. */
export function removeSection(state: ChatSectionsState, id: string): ChatSectionsState {
  if (!state.sections.some((s) => s.id === id)) return state;
  const sections = state.sections.filter((s) => s.id !== id);
  const membership: Record<string, string> = {};
  for (const [sid, section] of Object.entries(state.membership)) {
    if (section !== id) membership[sid] = section;
  }
  return { ...state, sections, membership };
}

/** Rename a user section. Main is not in `sections` at all, so this can
 *  never target it — the caller does not need its own guard. A
 *  blank name is a no-op (SAME object), matching the old single-section
 *  behaviour of never accepting an empty name. */
export function renameSection(state: ChatSectionsState, id: string, name: string): ChatSectionsState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  const found = state.sections.some((s) => s.id === id);
  if (!found) return state;
  return { ...state, sections: state.sections.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) };
}

/** Toggle one section's collapse — `'main'` is the one fixed slot, anything
 *  else is looked up in `sections`. An unknown id is a no-op (SAME object),
 *  the same defensive shape as removeSection/renameSection. */
export function toggleSectionCollapse(state: ChatSectionsState, id: string): ChatSectionsState {
  if (id === 'main') return { ...state, mainCollapsed: !state.mainCollapsed };
  const found = state.sections.some((s) => s.id === id);
  if (!found) return state;
  return { ...state, sections: state.sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)) };
}
