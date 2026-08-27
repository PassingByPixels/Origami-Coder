// botContractView.ts — what a BOT CARD and the bot FORM say about a contract.
//
// Pure, and its own module rather than markup inside the card, for the reason
// every leaf on this board is: the interesting cases are the ones a screenshot
// cannot show. "An unstated tier is not `open`" and "a bot with no ticks is not
// a bot with no block" are sentences about DATA, and they are exactly the
// distinctions a card loses first.
//
// THE THREE STATES. Every contract key is optional and every default is today's
// behaviour, so a card has three things to draw per field, not two: chosen,
// chosen-as-the-default, and never stated. `chosen` is what lets the card render
// the third quietly — an unconfigured def that reads as "standard / memory on"
// looks deliberately set up, and nobody looks for a decision never made.
//
// THE SHAPES BELOW ARE A MIRROR, and have to be. tsconfig.webview.json pins
// rootDir to `webview/`, so a .ts file on this side cannot import from `src/`
// at all — not even a type (TS6059). The same constraint produced
// repoMapPillars.ts and repoMapPalette.ts, and it comes with the same house
// obligation: botContractView.test.ts reads src/dashboard/botContract.ts and
// fails when the two field sets disagree.
//
// (A .svelte file CAN import across the seam — tsc never processes one — which
// is why the card types its prop as the real CollabAgentDef and hands it to
// these functions structurally, and why BotContractFields.svelte reads the tool
// catalogue straight out of src/dashboard/botTools.ts.)

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

/** The tiers the engine expands. The editor no longer offers them as a control
 *  (W6: the checklist is the permission surface), but a def may still STATE one
 *  by hand, so the card has to name what it means. */
export const TIER_CHOICES: Array<{ id: BotTier; label: string; hint: string }> = [
  { id: 'strict', label: 'Strict', hint: 'Reads only — read, search, list and skills. No file edits, no commands.' },
  { id: 'standard', label: 'Standard', hint: 'Can build — everything Strict allows, plus editing files and running commands.' },
  { id: 'open', label: 'Open', hint: 'Adds no rules at all; whatever the engine permits by default stands.' },
];

// THE CONTRACT A NEW BOT IS BORN WITH is nothing at all, and it is written as
// the literal `{}` at the one place a new def is built (CollabAgentsPane's
// `blank`). It used to be a `QUICK_DEFAULTS` constant here, back when it carried
// `tier: 'standard'`; W6 emptied it and W9 removed it, because an exported name
// for `{}` is a place a default can quietly grow back — which is the exact
// "looks deliberately set up" failure this module exists to prevent. What makes
// a new bot usable in one pass is its TICK SET, and that is every tool.

/**
 * The persona's opening PARAGRAPH, flattened to one line.
 *
 * A bot is picked on who it is as much as on what it may do, and the persona is
 * the only field carrying that — but a card cannot hold a prompt, so this is
 * the opening and the card hangs the rest on a title attribute.
 */
export function personaLine(def: BotDefView): string {
  return (def.persona || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
}

/**
 * Why an UNPINNED bot may not run, or '' when it will.
 *
 * A `model_prefer:` chain used to silence this. W6 deleted that key outright —
 * "a bot simply needs a pinned model, period" — so there is one statement about
 * a bot's model again and exactly one condition on this warning.
 */
export function modelWarning(def: BotDefView): string {
  if (def.model) return '';
  return def.visionProfile
    ? 'No model pinned - this profile runs on the chat\'s own model, which cannot see. Edit to pin one.'
    : 'No model pinned - a turn falls back to whatever the engine defaults to, which a fresh install may not have. Pin one.';
}

/** The EDITOR's model hint — the same fact `modelWarning` puts on the card,
 *  said where the pin is actually made. One module for both, so the two cannot
 *  drift into disagreeing about what an unpinned def does. */
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
  // A value the engine cannot read adds NO rules at all, so a def with a typo
  // is running on the engine defaults while its file claims otherwise. That is
  // the one contract state a card must never draw quietly.
  if (bot.unknownTier) return { text: `${bot.unknownTier}?`, chosen: true, bad: true, title: `"${bot.unknownTier}" is not a permission tier — the engine ignores it, so no tier rules apply.` };
  if (bot.tier) return { text: bot.tier, chosen: true, title: TIER_CHOICES.find((c) => c.id === bot.tier)?.hint };
  return { text: 'engine default', chosen: false, title: 'No tier stated — whatever the engine permits by default stands, plus this def’s own permission block.' };
}

/**
 * WHICH TOOLS this bot has, compactly.
 *
 * A card cannot list thirty checkboxes, and a bare count would not say whether
 * this is a bot set up the ordinary way or one somebody tuned. So a set that IS
 * a preset is named, a set that started as one and was adjusted is named with
 * how far it has moved, and anything else falls back to the count. `preset` is
 * passed in rather than recomputed here because the rule for what a set is
 * called lives host-side with the tick sets themselves (botTools.ts).
 */
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

/**
 * Memory: on unless the def opted out, plus what the bot has actually KEPT.
 *
 * The fact count is the difference between "configured to remember" and "has
 * remembered" — the only one of the fields whose real state lives outside the
 * def file. A bot that opted out never shows a count, even when a store from
 * before the opt-out is still on disk: the number would suggest the bot is
 * reading something it is not.
 */
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
