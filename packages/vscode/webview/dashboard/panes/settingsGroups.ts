// settingsGroups.ts — the Settings view's table (t-s9jr6u, mock rounds 5-6):
// which settings exist, in which group, with what name, help and reload rule.
// The row COMPONENTS own their wires; this owns the words and the order, so a
// test can state that every setting Insights used to hold has a home here, and
// the filter can hide a row without rendering it first.

export type SettingId =
  | 'density'
  | 'subagentLimit'
  | 'browserViewport'
  | 'browserReveal'
  | 'browserBeside'
  | 'cacheWarming'
  | 'backdrop';

export interface SettingRowDef {
  id: SettingId;
  name: string;
  help: string;
  /** Set when the value is read once: the words of the "reload" pill's tooltip. */
  reload?: string;
}

export interface SettingGroup {
  name: string;
  rows: SettingRowDef[];
}

const ENGINE_RELOAD = 'Read when the engine starts. Reload the window to apply.';

export const SETTING_GROUPS: SettingGroup[] = [
  { name: 'Chat', rows: [
    { id: 'density', name: 'Chat row density', reload: 'Read when the chat pane opens. Reload the window to apply.',
      help: 'Compact keeps the chat tab bar and message rows at the smallest size (24 px). Comfortable is the regular size.' },
  ] },
  { name: 'Agents', rows: [
    { id: 'subagentLimit', name: 'Sub-agent time limit', reload: ENGINE_RELOAD,
      help: 'A sub-agent that still runs after this time is stopped, so a fan-out cannot run all night. Empty = the engine default, 4 hours.' },
  ] },
  { name: 'Browser', rows: [
    { id: 'browserViewport', name: 'Screenshot viewport',
      help: 'Screenshots use this page size, whatever the size of the browser tab. Needs Browser: Bypass in the composer.' },
    { id: 'browserReveal', name: 'Bring the tab to the front',
      help: '“First open” stops later pages and screenshots from moving the tab you look at.' },
    { id: 'browserBeside', name: 'Open beside the chat',
      help: 'The agent’s browser opens in a group next to the chat, not over it.' },
  ] },
  { name: 'Cache', rows: [
    { id: 'cacheWarming', name: 'Keep the prompt cache warm', reload: ENGINE_RELOAD,
      help: 'While a chat is idle, the engine reads the cached prefix again before it expires, so the next message is a cache read. Each read costs a few input tokens.' },
  ] },
  { name: 'Appearance', rows: [
    { id: 'backdrop', name: 'Dot-grid backdrop',
      help: 'A quiet, static dot grid behind the chat. It is off when the OS reduces motion.' },
  ] },
];

export function settingRow(id: SettingId): SettingRowDef {
  for (const g of SETTING_GROUPS) for (const r of g.rows) if (r.id === id) return r;
  throw new Error(`settingsGroups: no row ${id}`);
}

export const SETTING_COUNT = SETTING_GROUPS.reduce((n, g) => n + g.rows.length, 0);

/** The filter matches the row's name or help, case-insensitively. Empty = all. */
export function rowMatches(row: SettingRowDef, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  return !q || `${row.name} ${row.help}`.toLowerCase().includes(q);
}

export function groupMatches(group: SettingGroup, filter: string): boolean {
  return group.rows.some((r) => rowMatches(r, filter));
}
