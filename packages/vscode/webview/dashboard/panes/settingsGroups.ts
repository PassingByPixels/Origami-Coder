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
  | 'backdrop'
  | 'elasticEnabled'
  | 'warmSpare'
  | 'idleAfter'
  | 'parkAfter'
  | 'parkUntimedAfter'
  | 'trimAfter'
  | 'retrim';

export interface SettingRowDef {
  id: SettingId;
  name: string;
  help: string;
  /** Set when the value is read once: the words of the "reload" pill's tooltip. */
  reload?: string;
  /** The pill's own word, when it is not "reload" (t-xtimx0: a spawn-time setting needs a new chat, not a reload). */
  pill?: string;
}

export interface SettingGroup {
  name: string;
  rows: SettingRowDef[];
}

// t-xtimx0: read when a chat's engine starts, and fixed for that chat (its spawn env), so no reload is needed.
const ENGINE_RELOAD = 'Read when a chat’s engine starts. New chats use the new value at once; open chats keep the value they started with.';

export const SETTING_GROUPS: SettingGroup[] = [
  { name: 'Chat', rows: [
    { id: 'density', name: 'Chat row density', reload: 'Read when the chat pane opens. Reload the window to apply.',
      help: 'Compact keeps the chat tab bar and message rows at the smallest size (24 px). Comfortable is the regular size.' },
  ] },
  { name: 'Agents', rows: [
    { id: 'subagentLimit', name: 'Sub-agent time limit', reload: ENGINE_RELOAD, pill: 'new chats',
      help: 'A sub-agent that still runs after this time is stopped, so a fan-out cannot run all night. Empty = the engine default, 4 hours.' },
  ] },
  { name: 'Engines', rows: [
    { id: 'elasticEnabled', name: 'Elastic engines',
      help: 'ON by default. Gives each chat’s engine an activity class — active on screen, background while hidden but working, idle when hidden and quiet — and lowers an idle engine’s OS priority and trims its memory. After a long idle time the engine process can park (see ‘Park idle chats after’); the chat stays and nothing in it is lost. Applies at once.' },
    { id: 'warmSpare', name: 'Warm spare', reload: 'Applies to the next new chat’s engine. A chat already open keeps the engine it has.', pill: 'new chats',
      help: 'ON by default. Keeps one spare engine ready for this window, so a new chat starts on an engine that is already up instead of waiting for one to start.' },
    { id: 'idleAfter', name: 'Idle after',
      help: 'Minutes a hidden, quiet chat waits before its engine is classed idle. Default: 5. It stays ‘background’ while a turn, an open question, a permission, a sub-agent or a /loop still runs. Applies at once.' },
    { id: 'parkAfter', name: 'Park idle chats after',
      help: 'Minutes after you leave a chat before its engine is parked, to free memory. The chat stays; your next message starts the engine again in about 2 seconds, with byte-identical requests, so a cache the provider still holds still hits. The park comes at this time whatever the provider’s cache life (Anthropic): a park does not clear that cache. With cache warming on, a parked chat wakes one minute before its warm is due, warms the cache and parks again. A chat on screen or running work is never parked. Default: 20, 0 turns parking off. Applies at once.' },
    { id: 'parkUntimedAfter', name: 'Park after, for providers with no published cache life',
      help: 'The same park, for providers with no published cache life (local servers such as vLLM or LM Studio, DeepSeek, OpenRouter). No clock says when their cache is gone; the first message after a park can miss that cache. Default: 20, never shorter than ‘Park idle chats after’. Applies at once.' },
    { id: 'trimAfter', name: 'Trim after (advanced)',
      help: 'Minutes an idle engine waits before it is asked to give back unused memory. Default: 0 (right away). Never asked within 2 minutes of its last turn, and never while a turn runs or a cache warm is due soon. Not available on macOS (no working-set equivalent); there, parking (see ‘Park idle chats after’) is what frees memory. Applies at once.' },
    { id: 'retrim', name: 'Re-trim every (advanced)',
      help: 'Minutes between two memory trims of the same idle engine. Default: 10. Doubles after a refusal, up to an hour, so a refusing engine is never asked in a loop. Not available on macOS; parking frees memory there instead. Applies at once.' },
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
    { id: 'cacheWarming', name: 'Keep the prompt cache warm', reload: ENGINE_RELOAD, pill: 'new chats',
      help: 'Off by default. While a chat is idle, the engine reads the cached prefix again before it expires, so the next message is a cache read. Each read is billed as a cache read of the whole cached prompt: turn this on if you often come back to idle chats within the cache life. A parked chat wakes one minute before its read is due, sends it and parks again.' },
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
