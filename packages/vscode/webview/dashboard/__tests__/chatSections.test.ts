// chatSections.ts (src/dashboard) unit tests — the sidebar chat-grouping
// feature's (t-kgserq, extended t-kgserq v2, retired-built-ins at t-r43glr)
// EXTENSION-side persistence: which chat is in which section (Main implicit,
// N user sections — no other built-in), collapse state, section CRUD. Pure
// functions + a Map-backed fake Memento (same fake as sessionRestore.test.ts
// and loopPersistence.test.ts). Asserts observable behaviour: a saved state
// round-trips; an absent, malformed, or pre-v2 LEGACY memento value reads
// back as safe defaults rather than throwing; a membership entry naming a
// RETIRED built-in ('loops', or the pre-v2 "spare" custom section) folds to
// Main rather than erroring or orphaning the chat (t-r43glr — see the
// dedicated describe block below); withSessionSection sets AND actually
// removes (not just blanks) a membership entry; pruneChatSections/
// removeSection/renameSection/toggleSectionCollapse return the SAME object
// reference on a no-op, the exact invariant DashboardPanel.ts relies on to
// skip a re-persist/re-echo.

import { describe, it, expect } from 'vitest';
import type { Memento } from 'vscode';
import {
  loadChatSections, saveChatSections, withSessionSection, pruneChatSections,
  addSection, removeSection, renameSection, toggleSectionCollapse,
  defaultChatSectionsState, DEFAULT_SECTION_NAME, type ChatSectionsState,
} from '../../../src/dashboard/chatSections';

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}

const KEY = 'origami.chatSections';

describe('loadChatSections — absent, malformed, and legacy values read back as safe defaults', () => {
  it('an absent key reads as the default state', () => {
    expect(loadChatSections(fakeMemento())).toEqual(defaultChatSectionsState());
  });

  it('a pre-feature legacy value at the key (not an object shaped like ChatSectionsState) does not throw and reads as defaults', () => {
    expect(() => loadChatSections(fakeMemento({ [KEY]: 'not-an-object' }))).not.toThrow();
    expect(loadChatSections(fakeMemento({ [KEY]: 'not-an-object' }))).toEqual(defaultChatSectionsState());
    expect(loadChatSections(fakeMemento({ [KEY]: ['eng-A', 'eng-B'] }))).toEqual(defaultChatSectionsState());
    expect(loadChatSections(fakeMemento({ [KEY]: 42 }))).toEqual(defaultChatSectionsState());
    expect(loadChatSections(fakeMemento({ [KEY]: null }))).toEqual(defaultChatSectionsState());
  });

  it('a membership map with invalid/unknown section ids or a non-object shape is dropped entry-by-entry, not wholesale', () => {
    const v = {
      // 'loops' is exactly as invalid as 'no-such-section' post-t-r43glr —
      // see the dedicated describe block below for the full migration story.
      membership: { 'eng-A': 'loops', 'eng-B': 'no-such-section', 'eng-C': 'sec1', '': 'sec1' },
      sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }],
      mainCollapsed: false,
    };
    expect(loadChatSections(fakeMemento({ [KEY]: v })).membership).toEqual({ 'eng-C': 'sec1' });

    const v2 = { membership: 'nope', sections: [], mainCollapsed: false };
    expect(loadChatSections(fakeMemento({ [KEY]: v2 })).membership).toEqual({});
  });

  it('mainCollapsed coerces anything other than literal true to false', () => {
    const v = { membership: {}, sections: [], mainCollapsed: 1 };
    const state = loadChatSections(fakeMemento({ [KEY]: v }));
    expect(state.mainCollapsed).toBe(false);
  });

  it('a malformed sections array entry (missing id/name, duplicate id) is dropped, not thrown on', () => {
    const v = {
      membership: {},
      sections: [
        { id: 'sec1', name: 'Reviews', collapsed: false },
        { id: '', name: 'No id' },
        { id: 'sec2', name: '   ' },
        { id: 'sec1', name: 'Duplicate id' },
        'not-an-object',
        null,
      ],
      mainCollapsed: false,
    };
    expect(loadChatSections(fakeMemento({ [KEY]: v })).sections).toEqual([
      { id: 'sec1', name: 'Reviews', collapsed: false },
    ]);
  });

  describe('t-r43glr — no built-in sections: Loops and the pre-v2 "spare" custom section fold to Main', () => {
    it('a fresh install has ONLY Main — no seeded/pinned section of any kind', () => {
      const state = loadChatSections(fakeMemento());
      expect(state.sections).toEqual([]);
      expect(state.membership).toEqual({});
      expect(state.mainCollapsed).toBe(false);
    });

    it('a v2 blob with chats filed under the retired built-in "loops": every one of them resolves to Main, none orphaned, nothing throws', () => {
      const v = {
        membership: { 'eng-A': 'loops', 'eng-B': 'loops', 'eng-C': 'sec1' },
        sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }],
        mainCollapsed: false,
      };
      expect(() => loadChatSections(fakeMemento({ [KEY]: v }))).not.toThrow();
      const state = loadChatSections(fakeMemento({ [KEY]: v }));
      // eng-A/eng-B are simply ABSENT from membership — that IS "in Main"
      // (see ChatSectionsState's own doc comment: Main is never stored).
      expect(state.membership).toEqual({ 'eng-C': 'sec1' });
      expect(state.sections).toEqual([{ id: 'sec1', name: 'Reviews', collapsed: false }]);
    });

    it('a NEVER-migrated pre-v2 blob (customName/customCollapsed, no sections array): no section is synthesized any more, its chats fold to Main, nothing throws', () => {
      const legacyBlob = {
        membership: { 'eng-A': 'loops', 'eng-B': 'custom', 'eng-C': 'loops' },
        loopsCollapsed: true, customCollapsed: false, customName: 'Focus',
      };
      expect(() => loadChatSections(fakeMemento({ [KEY]: legacyBlob }))).not.toThrow();
      const state = loadChatSections(fakeMemento({ [KEY]: legacyBlob }));
      expect(state.sections).toEqual([]);
      expect(state.membership).toEqual({});
      expect(state.mainCollapsed).toBe(false);
    });

    it('an ALREADY-migrated v2 blob (an earlier release already wrote the spare section to `sections` under id "legacy-custom"): it is stripped on load like any other retired built-in, its chats fold to Main, a real user section alongside it is untouched', () => {
      const v = {
        membership: { 'eng-A': 'legacy-custom', 'eng-B': 'sec1' },
        sections: [
          { id: 'legacy-custom', name: 'Focus', collapsed: false }, // mirrors chatSections.ts's private LEGACY_SECTION_ID
          { id: 'sec1', name: 'Reviews', collapsed: false },
        ],
        mainCollapsed: false,
      };
      const state = loadChatSections(fakeMemento({ [KEY]: v }));
      expect(state.sections).toEqual([{ id: 'sec1', name: 'Reviews', collapsed: false }]);
      expect(state.membership).toEqual({ 'eng-B': 'sec1' });
    });

    it('a real user-created section (never named "loops" or "legacy-custom") survives an upgrade untouched, chats and all', () => {
      const v = {
        membership: { 'eng-A': 'sec-real' },
        sections: [{ id: 'sec-real', name: 'My section', collapsed: true }],
        mainCollapsed: false,
      };
      const state = loadChatSections(fakeMemento({ [KEY]: v }));
      expect(state.sections).toEqual([{ id: 'sec-real', name: 'My section', collapsed: true }]);
      expect(state.membership).toEqual({ 'eng-A': 'sec-real' });
    });
  });
});

describe('saveChatSections / loadChatSections round-trip', () => {
  it('save then load returns exactly the persisted state', () => {
    const m = fakeMemento();
    const state: ChatSectionsState = {
      membership: { 'eng-A': 'sec-other', 'eng-B': 'sec1' },
      sections: [{ id: 'sec1', name: 'Deep work', collapsed: false }, { id: 'sec-other', name: 'Other', collapsed: false }],
      mainCollapsed: false,
    };
    saveChatSections(m, state);
    expect(loadChatSections(m)).toEqual(state);
  });
});

describe('withSessionSection — set and ACTUALLY remove (not just blank) a membership entry', () => {
  it('setting a section adds/overwrites the id; unrelated entries are untouched', () => {
    const base = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other' } };
    const next = withSessionSection(base, 'eng-B', 'sec1');
    expect(next.membership).toEqual({ 'eng-A': 'sec-other', 'eng-B': 'sec1' });
    expect(base.membership).toEqual({ 'eng-A': 'sec-other' }); // input not mutated
  });

  it('clearing (section=null, i.e. Main) deletes the key entirely — id is absent, not present with a null/undefined value', () => {
    const base = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other', 'eng-B': 'sec1' } };
    const next = withSessionSection(base, 'eng-A', null);
    expect('eng-A' in next.membership).toBe(false);
    expect(next.membership).toEqual({ 'eng-B': 'sec1' });
  });

  it('clearing an id that was never a member is a no-op on membership contents', () => {
    const base = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other' } };
    expect(withSessionSection(base, 'eng-Z', null).membership).toEqual({ 'eng-A': 'sec-other' });
  });
});

describe('pruneChatSections — the closeSession invariant: SAME reference when nothing changed', () => {
  it('drops membership entries whose id is not in liveIds, keeps the rest', () => {
    const state = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other', 'eng-B': 'sec1', 'eng-C': 'sec-other' } };
    expect(pruneChatSections(state, new Set(['eng-A', 'eng-C'])).membership).toEqual({ 'eng-A': 'sec-other', 'eng-C': 'sec-other' });
  });

  it('returns the SAME object (===) when every member id is still live', () => {
    const state = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other' } };
    expect(pruneChatSections(state, new Set(['eng-A', 'eng-Z-not-a-member']))).toBe(state);
  });

  it('returns the SAME object when membership is already empty', () => {
    const state = defaultChatSectionsState();
    expect(pruneChatSections(state, new Set())).toBe(state);
  });

  it('returns a DIFFERENT object (and a smaller membership) when at least one id was dropped', () => {
    const state = { ...defaultChatSectionsState(), membership: { 'eng-A': 'sec-other', 'eng-B': 'sec1' } };
    const pruned = pruneChatSections(state, new Set(['eng-A']));
    expect(pruned).not.toBe(state);
    expect(pruned.membership).toEqual({ 'eng-A': 'sec-other' });
    expect(pruned.mainCollapsed).toBe(state.mainCollapsed);
  });
});

describe('addSection — a fresh id, an appended def, an injectable generator', () => {
  it('appends a new section with the given name and returns its id', () => {
    const { state, id } = addSection(defaultChatSectionsState(), 'Reviews', () => 'sec-fixed');
    expect(id).toBe('sec-fixed');
    expect(state.sections).toEqual([{ id: 'sec-fixed', name: 'Reviews', collapsed: false }]);
  });

  it('a blank/whitespace name falls back to the default name, not an empty one', () => {
    const { state } = addSection(defaultChatSectionsState(), '   ', () => 'sec-fixed');
    expect(state.sections[0].name).toBe(DEFAULT_SECTION_NAME);
  });

  it('existing sections and membership are untouched, and the input is not mutated', () => {
    const base = { ...defaultChatSectionsState(), sections: [{ id: 'sec1', name: 'Old', collapsed: true }] };
    const { state } = addSection(base, 'New', () => 'sec2');
    expect(state.sections).toEqual([
      { id: 'sec1', name: 'Old', collapsed: true },
      { id: 'sec2', name: 'New', collapsed: false },
    ]);
    expect(base.sections).toHaveLength(1); // input not mutated
  });

  it('the real generator produces a non-empty, distinct id on two calls', () => {
    const a = addSection(defaultChatSectionsState(), 'A');
    const b = addSection(defaultChatSectionsState(), 'B');
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe('removeSection — deletes the def AND reverts its members to Main (not repointed, DROPPED)', () => {
  it('removes the section and clears membership entries that pointed at it', () => {
    const base: ChatSectionsState = {
      membership: { 'eng-A': 'sec1', 'eng-B': 'sec-other', 'eng-C': 'sec1' },
      sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }],
      mainCollapsed: false,
    };
    const next = removeSection(base, 'sec1');
    expect(next.sections).toEqual([]);
    // eng-A / eng-C go back to Main (absent), eng-B (elsewhere) is untouched.
    expect(next.membership).toEqual({ 'eng-B': 'sec-other' });
  });

  it('an unknown id is a no-op, returning the SAME object', () => {
    const base = { ...defaultChatSectionsState(), sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }] };
    expect(removeSection(base, 'no-such-id')).toBe(base);
  });
});

describe('renameSection — targets a section id, never Main (not in `sections` to begin with)', () => {
  it('renames the matching section, leaves others untouched', () => {
    const base = {
      ...defaultChatSectionsState(),
      sections: [{ id: 'sec1', name: 'Old', collapsed: false }, { id: 'sec2', name: 'Kept', collapsed: false }],
    };
    const next = renameSection(base, 'sec1', 'New name');
    expect(next.sections).toEqual([
      { id: 'sec1', name: 'New name', collapsed: false },
      { id: 'sec2', name: 'Kept', collapsed: false },
    ]);
  });

  it('a blank name is a no-op, returning the SAME object', () => {
    const base = { ...defaultChatSectionsState(), sections: [{ id: 'sec1', name: 'Old', collapsed: false }] };
    expect(renameSection(base, 'sec1', '   ')).toBe(base);
  });

  it('an unknown id is a no-op, returning the SAME object', () => {
    const base = { ...defaultChatSectionsState(), sections: [{ id: 'sec1', name: 'Old', collapsed: false }] };
    expect(renameSection(base, 'no-such-id', 'New')).toBe(base);
  });
});

describe('toggleSectionCollapse — the one fixed slot (Main) plus any user section, all by the SAME call', () => {
  it("'main' flips mainCollapsed", () => {
    expect(toggleSectionCollapse(defaultChatSectionsState(), 'main').mainCollapsed).toBe(true);
  });

  it('a section id flips that section alone', () => {
    const base = {
      ...defaultChatSectionsState(),
      sections: [{ id: 'sec1', name: 'A', collapsed: false }, { id: 'sec2', name: 'B', collapsed: false }],
    };
    const next = toggleSectionCollapse(base, 'sec1');
    expect(next.sections).toEqual([
      { id: 'sec1', name: 'A', collapsed: true },
      { id: 'sec2', name: 'B', collapsed: false },
    ]);
  });

  it('an unknown id is a no-op, returning the SAME object', () => {
    const base = defaultChatSectionsState();
    expect(toggleSectionCollapse(base, 'no-such-id')).toBe(base);
  });
});
