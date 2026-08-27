// Chat-section messages, routed out of DashboardPanel.ts's inline switch —
// mirrors collabManager.ts's own dispatcher shape (a MESSAGE_TYPES set the
// panel checks BEFORE its own switch, plus a handle() the panel delegates
// to), the SAME move made when that switch first grew big enough to bite
// DashboardPanel.ts's cap. Extracted here at t-kgserq v2 for the identical
// reason: the section-CRUD additions (create/delete alongside the existing
// set/toggle/rename) would otherwise have pushed the panel over its own.
//
// Every case here is wiring only — load, mutate via one of chatSections.ts's
// pure functions, save, echo. The state machine itself lives there.

import type { Memento } from 'vscode';
import {
  loadChatSections, saveChatSections, withSessionSection,
  addSection, removeSection, renameSection, toggleSectionCollapse,
} from './chatSections';

/** The wider context the dispatcher needs from the panel — deliberately just
 *  the memento and a reply channel, so this module never imports `vscode`
 *  beyond the `Memento` type and every case is exercised against a fake in
 *  tests, same convention as CollabManagerHost. */
export interface ChatSectionsManagerHost {
  post(msg: Record<string, unknown>): void;
  workspaceState(): Memento;
}

/** Every message type this dispatcher owns. Checked BEFORE DashboardPanel's
 *  own switch, mirroring COLLAB_MESSAGE_TYPES. */
export const CHAT_SECTION_MESSAGE_TYPES = new Set([
  'setChatSection', 'toggleChatSectionCollapse', 'renameChatSection',
  'createChatSection', 'deleteChatSection',
]);

/** Route one chat-section webview message. Fire-and-forget from the panel
 *  switch, same calling convention as handleCollabMessage. `sid` is
 *  DashboardPanel's own already-extracted `m.sessionId` (setChatSection's
 *  target chat) — passed in rather than re-read from `m` so this file never
 *  has to duplicate that cast. */
export function handleChatSectionMessage(
  host: ChatSectionsManagerHost,
  m: { type?: string; [k: string]: unknown },
  sid: string | undefined,
): void {
  const memento = host.workspaceState();
  switch (m.type) {
    case 'setChatSection': {
      // Any string names a section (a sections[].id); null (or anything
      // else) means Main. No existence check against the
      // live section list here — loadChatSections's own validation is what
      // catches a dangling id on the NEXT load.
      const targetId = sid ?? '';
      const section = typeof m.section === 'string' && m.section.trim() ? m.section.trim() : null;
      if (!targetId) return;
      const next = withSessionSection(loadChatSections(memento), targetId, section);
      saveChatSections(memento, next);
      host.post({ type: 'chatSections', state: next });
      return;
    }
    case 'toggleChatSectionCollapse': {
      const section = typeof m.section === 'string' ? m.section : '';
      if (!section) return;
      const current = loadChatSections(memento);
      const next = toggleSectionCollapse(current, section);
      if (next === current) return;
      saveChatSections(memento, next);
      host.post({ type: 'chatSections', state: next });
      return;
    }
    case 'renameChatSection': {
      const id = typeof m.id === 'string' ? m.id : '';
      const name = String(m.name ?? '').trim();
      if (!id || !name) return;
      const current = loadChatSections(memento);
      const next = renameSection(current, id, name);
      if (next === current) return;
      saveChatSections(memento, next);
      host.post({ type: 'chatSections', state: next });
      return;
    }
    case 'createChatSection': {
      const name = typeof m.name === 'string' ? m.name : '';
      const { state: next } = addSection(loadChatSections(memento), name);
      saveChatSections(memento, next);
      host.post({ type: 'chatSections', state: next });
      return;
    }
    case 'deleteChatSection': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) return;
      const current = loadChatSections(memento);
      const next = removeSection(current, id);
      if (next === current) return;
      saveChatSections(memento, next);
      host.post({ type: 'chatSections', state: next });
      return;
    }
  }
}
