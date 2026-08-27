// botContract.ts — the frontmatter keys that turn an agent definition into a
// configured BOT, as this package reads and writes them.
//
// A "bot" is NOT a new concept and this file adds none: it is the agent
// definition the engine already loads out of `<config>/agent/*.md`, read for
// two more things it can declare about itself. The engine owns what they MEAN
// (packages/engine/src/agent/bot.ts); this owns only the FILE.
//
//   permissions:   strict | standard | open      a named starting tier
//   memory:        true | false                  its own persistent store
//
// TWO KEYS THIS FILE USED TO OWN ARE GONE (W6 owner rulings):
//   skills:        stripped. "Nobody cares what skills a bot has, only what
//                  tools" — the tool checklist (botTools.ts) is the whole
//                  permission surface now, and `skill` is one tick in it.
//   model_prefer:  stripped. A bot simply needs a pinned model, so a second,
//                  weaker way to state one was a fallback nobody could see.
// Neither is parsed and neither is written, so a def carrying one loses it on
// its next save — which is what "stripped" has to mean for a key whose whole
// job was to be read.
//
// THE ONE RULE EVERYTHING HERE FOLLOWS: absent stays absent. The def writer
// (collabAgentCrud.ts) resolves an unstated field from the file already on
// disk, and the card has to be able to say "the author chose this" as opposed
// to "the author left the default". So the parser never fills a default in and
// the serializer never writes one out — the same omit-at-default rule `model:`,
// `glyph:` and `vision:` already follow in collabAgentSerialize.ts.
//
// THE TIER NAMES ARE A MIRROR. `packages/engine` is not resolvable from this
// package (per-package installs), so they are copied, with the house obligation
// that comes with a mirror: botContract.test.ts reads the engine source and
// fails when the two disagree.
//
// Pure — no fs, no `vscode` — so every branch is exercised on strings.

import { frontValue } from './agentFrontmatter';

/** The named permission tiers the engine expands (bot.ts TIER_RULES). */
export const BOT_TIERS = ['strict', 'standard', 'open'] as const;
export type BotTier = (typeof BOT_TIERS)[number];

/** What a def DECLARED. Every field optional; absent means the file said
 *  nothing and the engine's own default applies. */
export interface BotContract {
  /** `permissions:`, when it names a tier this build knows. */
  tier?: BotTier;
  /** A `permissions:` value that is not a tier. Kept verbatim so the pane can
   *  show the typo instead of silently "fixing" it on the next save. */
  unknownTier?: string;
  /** `memory:` as STATED. undefined = unstated (the engine default, on). */
  memory?: boolean;
}

const isTier = (value: string): value is BotTier => (BOT_TIERS as readonly string[]).includes(value);

/** Read the contract off a frontmatter block. */
export function parseBotContract(front: string): BotContract {
  const permissions = frontValue(front, 'permissions');
  const memory = frontValue(front, 'memory');
  return {
    ...(permissions && isTier(permissions) ? { tier: permissions } : {}),
    ...(permissions && !isTier(permissions) ? { unknownTier: permissions } : {}),
    ...(memory === 'true' || memory === 'false' ? { memory: memory === 'true' } : {}),
  };
}

/**
 * The frontmatter lines a contract becomes, in the order the template lists
 * them. EMPTY for a contract that declares nothing, so a def edited on this
 * board keeps looking exactly as un-configured as it is.
 *
 * `memory: true` is deliberately NOT written: it is already the engine's
 * default, so the line would appear in every file and say nothing. Only the
 * opt-out is a fact worth recording.
 */
export function botContractLines(contract: BotContract): string[] {
  const lines: string[] = [];
  const tier = contract.tier ?? contract.unknownTier;
  if (tier) lines.push(`permissions: ${tier}`);
  if (contract.memory === false) lines.push('memory: false');
  return lines;
}
