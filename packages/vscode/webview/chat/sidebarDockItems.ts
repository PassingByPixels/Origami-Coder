// THE SIDEBAR DOCK's seven items — order, labels and glyphs.
//
// (Mock-Redesign/CHANGES.md change 1, react-bits Components/Dock.) A leaf so
// the set can be asserted without a DOM: what the dock replaced was three
// toolbar buttons and three section toggles scattered down the panel, and the
// one thing a test should be able to state plainly is that every one of them
// still has a way in.
//
// OWNER DECISIONS (2026-09-21), recorded here because they are not obvious
// from the code:
//  * `Artifacts` held the place with an honest `(pending)` label while the
//    product had no artifacts surface. t-rz4555 gave it one: the click now
//    opens the board's Artifacts view, so the label is the plain word.
//  * The cog reads `Manager`, not the product's `Agents Manager`.
//  * NO DIVIDER (owner, 2026-09-21, t-qhzy4k): one unbroken row. The order is
//    the owner's: new chat, history, manager, memory graph, front desk,
//    collabs, artifacts.
//  * `Memory` opens from the brain ONLY. The sidebar's Memory label and its
//    toggle are gone from the DOM, not hidden.

export type DockKey = 'new' | 'history' | 'agents' | 'collabs' | 'frontdesk' | 'memory' | 'artifacts';

export interface DockItem {
  key: DockKey;
  label: string;
  /** SVG `d` attributes, drawn stroked on a 24x24 viewBox. */
  paths: string[];
  /** This item toggles a section, so it can read as on. */
  toggle?: boolean;
}

export const DOCK_ITEMS: DockItem[] = [
  { key: 'new', label: 'New chat', paths: ['M12 5v14', 'M5 12h14'] },
  { key: 'history', label: 'Chat history', paths: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5', 'M12 7v5l3 2'] },
  {
    key: 'agents',
    label: 'Manager',
    paths: [
      'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
      'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.2A1.7 1.7 0 0 0 7 19.6a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.7 15a1.7 1.7 0 0 0-1.5-1H1a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 2.7 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 4.4h.1A1.7 1.7 0 0 0 8.4 2.9V2a2 2 0 1 1 4 0v.2A1.7 1.7 0 0 0 15 3.6',
    ],
  },
  {
    key: 'memory',
    label: 'Memory graph',
    toggle: true,
    paths: ['M9.5 2.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 6 16a3 3 0 0 0 3.5 4.4V2.5Z', 'M14.5 2.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3 3 0 0 1 18 16a3 3 0 0 1-3.5 4.4V2.5Z'],
  },
  { key: 'frontdesk', label: 'Front Desk', toggle: true, paths: ['M3 21h18', 'M5 21V7l7-4 7 4v14', 'M9 21v-6h6v6'] },
  {
    key: 'collabs',
    label: 'Collabs',
    toggle: true,
    paths: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  },
  { key: 'artifacts', label: 'Artifacts', paths: ['M12 2 2 7l10 5 10-5-10-5Z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5'] },
];
