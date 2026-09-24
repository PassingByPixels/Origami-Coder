// botContractView.ts: what a bot card and the bot form say about a contract.
// Every contract key is optional; a card must distinguish three states per
// field: chosen, chosen-as-default, and never stated. `chosen` marks the
// first two.
//
// The shapes below mirror src/dashboard/botContract.ts. tsconfig.webview.json
// pins rootDir to `webview/`, so a .ts file here cannot import from `src/`,
// not even a type; botContractView.test.ts fails if the two field sets
// disagree.

/** Mirror of botContract.ts's BotTier. */
export type BotTier = 'strict' | 'standard' | 'open';

/** Mirror of botContract.ts's BotContract. */
export interface BotContract {
  tier?: BotTier;
  unknownTier?: string;
  memory?: boolean;
}

/** The parts of a def these projections read. Structural, so the real
 *  CollabAgentDef satisfies it without this file naming that type. */
export interface BotDefView {
  model?: string;
  persona?: string;
  visionProfile?: boolean;
  /** Ticked permission keys — WHICH TOOLS this bot has. Undefined = no block. */
  tools?: string[];
  bot?: BotContract;
}

/** One rendered fact. `chosen` = the def said this; false = it said nothing and
 *  the engine's own default is what is being described. */
export interface ContractFact {
  text: string;
  chosen: boolean;
  /** Hover text when the short form dropped something. */
  title?: string;
  /** True when this is not a working state — a value the engine cannot read. */
  bad?: boolean;
}

/** Tiers the engine expands. The editor no longer offers them as a control,
 *  but a def may still state one by hand, so the card must name it. */
export const TIER_CHOICES: Array<{ id: BotTier; label: string; hint: string }> = [
  { id: 'strict', label: 'Strict', hint: 'Reads only — read, search, list and skills. No file edits, no commands.' },
  { id: 'standard', label: 'Standard', hint: 'Can build — everything Strict allows, plus editing files and running commands.' },
  { id: 'open', label: 'Open', hint: 'Adds no rules at all; whatever the engine permits by default stands.' },
];

// A new bot's contract is `{}` (built once, in CollabAgentsPane's `blank`).
// No exported default constant exists on purpose: one would let a default
// quietly grow back. What makes a fresh bot usable is its tick set: every tool.

/** Persona's opening paragraph, flattened to one line: a bot is picked on
 *  who it is, and the persona is the only field carrying that. */
export function personaLine(def: BotDefView): string {
  return (def.persona || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
}

/** Why an unpinned bot may not run, or '' when it will. */
export function modelWarning(def: BotDefView): string {
  if (def.model) return '';
  return def.visionProfile
    ? 'No model pinned - this profile runs on the chat\'s own model, which cannot see. Edit to pin one.'
    : 'No model pinned - a turn falls back to whatever the engine defaults to, which a fresh install may not have. Pin one.';
}

/** The editor's model hint: the same fact `modelWarning` puts on the card,
 *  said where the pin is made, so the two can't drift apart. */
export function modelHint(kind: 'collab' | 'vision', model: string): string {
  if (kind === 'vision') {
    return model
      ? 'It must be a model that accepts images. A text-only model here will describe a picture it never received.'
      : 'Required. Without a pinned model this profile runs on the chat’s own model — the one that cannot see.';
  }
  return model
    ? 'This agent always runs on the model above, whatever the room around it is using.'
    : 'Left unset, a turn falls back to whatever the engine defaults to — not necessarily the model you expect, and not guaranteed to exist on a fresh install. Pin one to be sure.';
}

export function tierSummary(bot: BotContract): ContractFact {
  // A value the engine can't read adds no rules at all, so a def with a
  // typo runs on engine defaults while its file claims otherwise.
  if (bot.unknownTier) return { text: `${bot.unknownTier}?`, chosen: true, bad: true, title: `"${bot.unknownTier}" is not a permission tier — the engine ignores it, so no tier rules apply.` };
  if (bot.tier) return { text: bot.tier, chosen: true, title: TIER_CHOICES.find((c) => c.id === bot.tier)?.hint };
  return { text: 'engine default', chosen: false, title: 'No tier stated — whatever the engine permits by default stands, plus this def’s own permission block.' };
}

/** Which tools this bot has, compactly: a card can't list thirty checkboxes.
 *  `preset`'s naming rule lives host-side, in botTools.ts. */
export function toolsSummary(def: BotDefView, preset: string): ContractFact {
  const tools = def.tools;
  if (!tools) {
    return { text: 'engine default', chosen: false, title: 'No permission block — this bot is offered whatever the engine offers by default.' };
  }
  const title = tools.length > 0 ? tools.join(', ') : 'Every tool denied — this bot can read the room and answer, nothing else.';
  if (preset === 'worker' || preset === 'observer') return { text: preset, chosen: true, title };
  const n = tools.length;
  return { text: n === 1 ? '1 tool' : `${n} tools`, chosen: true, title };
}

/** Memory: on unless the def opted out, plus facts actually kept. An opted-
 *  out bot never shows a count, even from a store still on disk. */
export function memorySummary(bot: BotContract, facts: number): ContractFact & { on: boolean } {
  if (bot.memory === false) {
    return { on: false, text: 'off', chosen: true, title: 'memory: false — this bot starts every session blank.' };
  }
  const chosen = bot.memory === true;
  return {
    on: true,
    text: facts > 0 ? `${facts} kept` : 'on',
    chosen,
    title: facts > 0
      ? `${facts} fact${facts === 1 ? '' : 's'} in this bot’s own store, injected at the top of its turns.`
      : 'This bot keeps its own store across sessions. Nothing in it yet.',
  };
}
