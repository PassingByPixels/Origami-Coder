// The sidebar's Collabs section state, host side: the draggable Chats/Collabs divider height and
// whether the section is collapsed. Both are per-workspace preferences the webview cannot keep
// itself, so they travel on one reply.
//
// Extracted out of DashboardPanel.ts at its architecture cap, and kept separate from
// chatSectionsManager.ts: the collabs divider is a wire of its own, sharing no data with
// ChatsList's chatSections.

import type { Memento } from 'vscode';

/** The Collabs half's dragged height in px, or absent for the default 50/50 split. */
export const COLLABS_HEIGHT_KEY = 'origami.collabsSectionHeight';
/** Whether the Collabs half is OPEN. Absent = CLOSED (t-qhzy4k): the section
 *  does not render at all until the dock's Collabs item asks for it, the same
 *  rule as the memory graph and the front desk. The key's SENSE was inverted
 *  rather than its default flipped, because "stored only when it differs from
 *  the default" is what keeps an untouched workspace out of globalState — and
 *  the default is now closed. The old `...Collapsed` key is left behind rather
 *  than migrated: reading it would mean re-opening a section for everyone who
 *  ever collapsed one. */
export const COLLABS_OPEN_KEY = 'origami.collabsSectionOpen';

export const COLLABS_SECTION_MESSAGE_TYPES = new Set([
  'requestCollabsHeight',
  'resizeCollabsSection',
  'setCollabsCollapsed',
]);

export interface CollabsSectionHost {
  post(message: Record<string, unknown>): void;
  workspaceState(): Memento;
}

/** A stored height as the sidebar may use it: a positive finite number, or null for no drag yet. A
 *  non-positive value is coerced away rather than stored, so it can't erase the user's dragged
 *  split. */
export function usableHeight(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

function reply(host: CollabsSectionHost, memento: Memento): void {
  host.post({
    type: 'collabsHeight',
    heightPx: usableHeight(memento.get<number>(COLLABS_HEIGHT_KEY)),
    collapsed: memento.get<boolean>(COLLABS_OPEN_KEY) !== true,
  });
}

/** Read or write one field, then ECHO the whole section state back. The echo is
 *  what makes the sidebar show what was actually stored rather than what it
 *  hoped to store — a height the coercion above refused must not stay on
 *  screen. Fire-and-forget from the panel switch, like handleChatSectionMessage. */
export function handleCollabsSectionMessage(
  host: CollabsSectionHost,
  m: { type?: string; [k: string]: unknown },
): void {
  const memento = host.workspaceState();
  switch (m.type) {
    case 'resizeCollabsSection': {
      const heightPx = usableHeight(m.heightPx);
      void memento.update(COLLABS_HEIGHT_KEY, heightPx ?? undefined);
      reply(host, memento);
      return;
    }
    case 'setCollabsCollapsed': {
      // Stored only when OPEN. An absent key is the closed default, so writing
      // `false` would persist the default as if it had been chosen.
      const open = m.collapsed !== true;
      void memento.update(COLLABS_OPEN_KEY, open ? true : undefined);
      reply(host, memento);
      return;
    }
    case 'requestCollabsHeight':
      reply(host, memento);
      return;
  }
}
