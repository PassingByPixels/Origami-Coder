// chatSectionsManager — the dispatcher EXTRACTED from DashboardPanel.ts's
// inline chat-section switch (t-kgserq v2, at that file's own cap). Same
// purpose as collabManager.test.ts's own header: the "zero behaviour change"
// pin for the extraction — every case still loads, mutates via the SAME pure
// function chatSections.test.ts already proves, saves, and echoes back the
// SAME `chatSections` reply shape ChatsList.svelte depends on. The pure
// mutation logic is NOT re-tested here (chatSections.test.ts owns that); this
// file is about the WIRING: which message reaches which function, with which
// args, and whether a no-op correctly skips the save/echo.

import { describe, it, expect } from 'vitest';
import type { Memento } from 'vscode';
import {
  CHAT_SECTION_MESSAGE_TYPES,
  handleChatSectionMessage,
  type ChatSectionsManagerHost,
} from '../../../src/dashboard/chatSectionsManager';
import { loadChatSections, saveChatSections, defaultChatSectionsState } from '../../../src/dashboard/chatSections';

function fakeMemento(seed: Record<string, unknown> = {}): Memento {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); },
    keys: () => [...m.keys()],
  } as unknown as Memento;
}

interface FakeHost extends ChatSectionsManagerHost {
  posts: Array<Record<string, unknown>>;
}
function fakeHost(memento: Memento): FakeHost {
  const posts: Array<Record<string, unknown>> = [];
  return { posts, post: (msg) => posts.push(msg), workspaceState: () => memento };
}

describe('CHAT_SECTION_MESSAGE_TYPES — exactly the five messages this dispatcher owns', () => {
  it('names every case handled below, nothing else', () => {
    expect([...CHAT_SECTION_MESSAGE_TYPES].sort()).toEqual([
      'createChatSection', 'deleteChatSection', 'renameChatSection',
      'setChatSection', 'toggleChatSectionCollapse',
    ].sort());
  });
});

describe('handleChatSectionMessage — setChatSection', () => {
  it('sets the target session (sid) into the named section, saves, and echoes', () => {
    // A real section must already exist for it to survive the round-trip
    // through loadChatSections (t-r43glr — no id is valid by fiat any more,
    // 'loops' included; see the next test for what an unknown one does).
    const memento = fakeMemento({
      'origami.chatSections': { membership: {}, sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }], mainCollapsed: false },
    });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'setChatSection', section: 'sec1' }, 'eng-A');
    expect(loadChatSections(memento).membership).toEqual({ 'eng-A': 'sec1' });
    expect(host.posts).toEqual([{ type: 'chatSections', state: loadChatSections(memento) }]);
  });

  it('setting a RETIRED built-in id (e.g. "loops") is stored as given (no existence check here) but folds to Main on the next load — the caller never sees a chat stuck in a dead section', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'setChatSection', section: 'loops' }, 'eng-A');
    expect(loadChatSections(memento).membership).toEqual({});
  });

  it('a null/absent section clears membership (moves the chat to Main)', () => {
    const memento = fakeMemento({ 'origami.chatSections': { membership: { 'eng-A': 'sec1' }, sections: [{ id: 'sec1', name: 'Reviews', collapsed: false }], mainCollapsed: false } });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'setChatSection', section: null }, 'eng-A');
    expect(loadChatSections(memento).membership).toEqual({});
  });

  it('no sid (sessionId) is a no-op — nothing saved, nothing posted', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'setChatSection', section: 'sec1' }, undefined);
    expect(loadChatSections(memento)).toEqual(defaultChatSectionsState());
    expect(host.posts).toEqual([]);
  });
});

describe('handleChatSectionMessage — toggleChatSectionCollapse', () => {
  it("'main' flips mainCollapsed and echoes", () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'toggleChatSectionCollapse', section: 'main' }, undefined);
    expect(loadChatSections(memento).mainCollapsed).toBe(true);
    expect(host.posts).toHaveLength(1);
  });

  it('an unknown section id (including the retired built-in "loops") is a no-op — nothing posted', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'toggleChatSectionCollapse', section: 'no-such-id' }, undefined);
    expect(host.posts).toEqual([]);
    const host2 = fakeHost(memento);
    handleChatSectionMessage(host2, { type: 'toggleChatSectionCollapse', section: 'loops' }, undefined);
    expect(host2.posts).toEqual([]);
  });
});

describe('handleChatSectionMessage — renameChatSection', () => {
  it('renames the matching section by id and echoes', () => {
    const memento = fakeMemento({ 'origami.chatSections': { membership: {}, sections: [{ id: 's1', name: 'Old', collapsed: false }], mainCollapsed: false } });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'renameChatSection', id: 's1', name: 'New name' }, undefined);
    expect(loadChatSections(memento).sections).toEqual([{ id: 's1', name: 'New name', collapsed: false }]);
  });

  it('a blank name is a no-op — nothing posted', () => {
    const memento = fakeMemento({ 'origami.chatSections': { membership: {}, sections: [{ id: 's1', name: 'Old', collapsed: false }], mainCollapsed: false } });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'renameChatSection', id: 's1', name: '   ' }, undefined);
    expect(host.posts).toEqual([]);
  });
});

describe('handleChatSectionMessage — createChatSection', () => {
  it('appends a new section and echoes the state carrying it', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'createChatSection', name: 'Reviews' }, undefined);
    expect(loadChatSections(memento).sections).toHaveLength(1);
    expect(loadChatSections(memento).sections[0].name).toBe('Reviews');
    expect(host.posts).toHaveLength(1);
  });

  it('a blank/absent name still creates a section, under the default name', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'createChatSection' }, undefined);
    expect(loadChatSections(memento).sections).toHaveLength(1);
    expect(loadChatSections(memento).sections[0].name).toBeTruthy();
  });
});

describe('handleChatSectionMessage — deleteChatSection', () => {
  it('removes the section and reverts its members to Main, then echoes', () => {
    const memento = fakeMemento({
      'origami.chatSections': { membership: { 'eng-A': 's1' }, sections: [{ id: 's1', name: 'Reviews', collapsed: false }], mainCollapsed: false },
    });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'deleteChatSection', id: 's1' }, undefined);
    const after = loadChatSections(memento);
    expect(after.sections).toEqual([]);
    expect(after.membership).toEqual({});
  });

  it('no id is a no-op — nothing saved, nothing posted', () => {
    const memento = fakeMemento();
    saveChatSections(memento, { ...defaultChatSectionsState(), sections: [{ id: 's1', name: 'Reviews', collapsed: false }] });
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'deleteChatSection' }, undefined);
    expect(loadChatSections(memento).sections).toHaveLength(1); // untouched
    expect(host.posts).toEqual([]);
  });

  it('an unknown id is a no-op — nothing posted', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'deleteChatSection', id: 'no-such-id' }, undefined);
    expect(host.posts).toEqual([]);
  });
});

describe('handleChatSectionMessage — an unrecognised type is a silent no-op', () => {
  it('does nothing for a message type outside the five owned above', () => {
    const memento = fakeMemento();
    const host = fakeHost(memento);
    handleChatSectionMessage(host, { type: 'notAChatSectionMessage' }, undefined);
    expect(host.posts).toEqual([]);
  });
});
