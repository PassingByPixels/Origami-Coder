// botContract.ts — the frontmatter keys that turn an agent definition into a
// configured BOT: `permissions:` (a named tier) and `memory:` (its own store).
// The engine owns what they mean; this owns only the file.
//
// `skills:` and `model_prefer:` are no longer parsed or written (W6 ruling):
// the tool checklist is the whole permission surface now.
//
// Absent stays absent: the parser never fills a default and the serializer
// never writes one. Tier names mirror the engine's own; botContract.test.ts
// fails on drift.

import { frontValue } from './agentFrontmatter';

/** The named permission tiers the engine expands (bot.ts TIER_RULES). */
export const BOT_TIERS = ['strict', 'standard', 'open'] as const;
export type BotTier = (typeof BOT_TIERS)[number];

/** What a def DECLARED. Every field optional; absent means the file said
 *  nothing and the engine's own default applies. */
export interface BotContract {
  /** `permissions:`, when it names a tier this build knows. */
  tier?: BotTier;
    /** A `permissions:` value that isn't a tier — kept so the pane can show the typo. */
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
 * The frontmatter lines a contract becomes, in template order — empty for a
 * contract that declares nothing. `memory: true` is never written since it's
 * already the engine default; only the opt-out is worth recording.
 */
export function botContractLines(contract: BotContract): string[] {
  const lines: string[] = [];
  const tier = contract.tier ?? contract.unknownTier;
  if (tier) lines.push(`permissions: ${tier}`);
  if (contract.memory === false) lines.push('memory: false');
  return lines;
}
