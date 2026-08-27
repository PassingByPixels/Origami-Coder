// The PINNED rows of the Instructions pane: the prompts the engine ships and
// the user can replace with a file of their own — the base agent prompt, and
// the layer a collab turn adds around an agent's persona. (M4.1 merged the
// room manual INTO that layer, so `collab-manual` is gone from here entirely
// rather than kept as a source nothing can send.)
//
// Pure rules, in their own module because InstructionsPane.svelte sits ON its
// architecture cap and the ratchet's remedy is extraction. Two honesty rules:
//  - a pinned row is NOT a file. Its path names where an override WOULD be
//    written, so a built-in must never read as something already on disk.
//  - the webview never names the path the host is about to write to. A pinned
//    row asks by KIND and the host resolves the target itself.

export type OverrideSource = 'base-prompt' | 'collab-agent-base';

/** Only the fields these rules read — the pane's Entry is a superset. */
export interface Row {
  path: string;
  source: string;
  overridden?: boolean;
}

/** Pinned priority order, main first. Files render BETWEEN main and collab. */
const PINNED: readonly string[] = ['base-prompt', 'collab-agent-base'];

const NAMES: Record<string, string> = {
  'base-prompt': 'Base agent prompt',
  'collab-agent-base': 'Collab base prompt',
};

export function isPinned(e: Row): boolean {
  return PINNED.includes(e.source);
}

/** Higher sorts FIRST. 0 = an ordinary file, ranked by its size instead. */
export function rank(e: Row): number {
  const index = PINNED.indexOf(e.source);
  return index === -1 ? 0 : PINNED.length - index;
}

/** The row's display name: the prompt's name when pinned, else its filename. */
export function displayName(e: Row): string {
  // Gated on isPinned rather than a bare NAMES lookup: an object index by an
  // arbitrary source string can hit Object.prototype and render a function.
  if (isPinned(e)) return NAMES[e.source]!;
  return e.path.split(/[\\/]/).pop() || e.path;
}

/** A pinned row says whose text it is; every other row says where it came from. */
export function badge(e: Row): string {
  return isPinned(e) ? (e.overridden ? 'overridden' : 'built-in') : e.source;
}

/** What clicking the row asks the host to do — null when there is nothing to open. */
export function openMessage(e: Row): { type: string; kind?: string; path?: string } | null {
  // A URL is not on disk; there is no file behind it to open.
  if (e.source === 'url') return null;
  // No path crosses for a pinned row: the host resolves AND seeds it, so this
  // webview never names a file the extension is about to write to.
  if (isPinned(e)) return { type: 'openBasePrompt', kind: e.source };
  // Reuses the panel's existing absolute-path opener; instruction paths are
  // always absolute, resolved engine-side.
  return { type: 'openAbsoluteFile', path: e.path };
}

/** The list's three TIERS: the single MAIN row at top, ordinary FILEs below it
 *  biggest first, then the COLLAB row last under its own subheading — split
 *  rather than sorted in place, so a subheading can sit between tiers. */
export interface Sections<T extends Row> { main: T[]; collab: T[]; files: T[] }
export function sections<T extends Row & { chars: number }>(entries: readonly T[]): Sections<T> {
  const byRank = (a: Row, b: Row) => rank(b) - rank(a);
  return {
    main: entries.filter((e) => e.source === 'base-prompt').sort(byRank),
    collab: entries.filter((e) => e.source === 'collab-agent-base').sort(byRank),
    files: entries.filter((e) => !isPinned(e)).sort((a, b) => b.chars - a.chars),
  };
}
