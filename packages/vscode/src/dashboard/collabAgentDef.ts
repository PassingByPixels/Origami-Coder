// Collabs — collabAgentDef.ts: the def FILE FORMAT. Pure - no fs, no vscode.
//
// A hand-tuned permission block that is NEITHER shipped preset is copied
// back out verbatim — a save must never silently widen or narrow an agent.

import { presetOf, type CollabPreset } from './agentManager/collabPresets';
import { parseBotContract, type BotContract } from './botContract';
import { presetOfTools, toolsFromBlock } from './botTools';
import { isLegacySeed } from './agentManager/collabAgentsLegacy';
// Frontmatter primitives live in agentFrontmatter.ts. `permissionBlockIn` is
// re-exported so callers don't need to know where `---` parsing moved to.
import { FRONT_BLOCK, frontValue, permissionBlockIn } from './agentFrontmatter';

export { permissionBlockIn } from './agentFrontmatter';
// The WRITE half lives next door since the bot contract landed - this file was
// at 171 of its 175-line cap, and serializing is the half that kept growing
// (four more optional keys, each with its own omit-at-its-default rule).
export { serializeAgentDef } from './collabAgentSerialize';

/** A collab agent def as the pane edits it. Every string field is a plain
 *  string: `''` means "the file has none", never a fabricated default. */
export interface CollabAgentDef {
  /** Filename minus `.md`; the @mention handle. */
  slug: string;
  description: string;
  /** `provider/model`, or `''` for "no pinned model" (the session's is used). */
  model: string;
  /** An archetypeGlyphs key, or `''` for the letter-disc fallback. */
  glyph: string;
  /** The prompt body under the frontmatter. */
  persona: string;
    /**
     * Which permission preset the def carries. Optional: a missing preset must
     * never be read as "make it a worker" — it means "keep what's on disk".
     */
  preset?: CollabPreset;
  /** The verbatim `permission:` block, ONLY when preset is `custom`. */
  customPermission?: string;
    /**
     * WHICH TOOLS this bot has — the permission keys its block allows.
     * `undefined` means the file carries no block at all, which is NOT the
     * same as an empty tick set. Optional for the same reason as `preset`:
     * absent must read as "keep what's on disk".
     */
  tools?: string[];
  /** The `steps:` frontmatter value as written, or `''` for the preset default. */
  steps?: string;
    /**
     * `vision: true` — this agent may be handed real image parts; without it
     * an attached image reaches the agent as a blind note. Read as false when
     * absent — a model that can't see must never be told it can. Parsed AND
     * written, so a hand-added `vision:` line survives a save.
     */
  vision?: boolean;
    /**
     * `vision-profile: true` — this def is a VISION PROFILE, not a collab
     * agent; the one key that tells them apart, since they share a directory
     * and file format. Deliberately NOT `collab: true` — a profile has no
     * business appearing in the collab roster. Always carries `vision: true`
     * as well, since a profile that can't be shown pixels is useless.
     */
  visionProfile?: boolean;
    /**
     * THE BOT CONTRACT — `permissions:`, `memory:` (botContract.ts). Always
     * set by parse, as an empty object when the file declares none. Optional
     * on the type for the same message-boundary reason as `preset`.
     */
  bot?: BotContract;
  /** True when the file on disk is a prior shipped seed, untouched. Computed on
   *  read and ignored on write - the pane uses it for the reseed note. */
  legacySeed?: boolean;
}

/**
 * Parse a def file. Returns null when the file is neither a COLLAB agent nor
 * a VISION PROFILE — no frontmatter, or frontmatter carrying neither
 * `collab: true` nor `vision-profile: true`. Widened rather than replaced
 * from the old `collab: true`-only gate: a def must declare which of the two
 * it is so the board can put it under the right tab.
 */
export function parseAgentDef(slug: string, text: string): CollabAgentDef | null {
  const m = text.match(FRONT_BLOCK);
  if (!m) return null;
  const front = m[1];
  const isCollab = frontValue(front, 'collab') === 'true';
  const isVisionProfile = frontValue(front, 'vision-profile') === 'true';
  if (!isCollab && !isVisionProfile) return null;
  const block = permissionBlockIn(front);
    // The tick set is what the block means (W6), so the preset is read off it
    // rather than the block's bytes — otherwise a reordered worker would read
    // as `custom` the moment the checklist rewrote the file.
  const tools = toolsFromBlock(block);
  const preset = tools ? presetOfTools(tools) : presetOf(block);
  return {
    slug,
    description: frontValue(front, 'description'),
    model: frontValue(front, 'model'),
    glyph: frontValue(front, 'glyph'),
    // trimEnd MIRRORS serializeAgentDef, which writes `persona.trimEnd()` plus a
    // final newline. Without it every save/load cycle would grow one more
    // trailing blank line, and an unedited def would come back != what went in.
    persona: text.slice(m[0].length).replace(/^\r?\n/, '').trimEnd(),
    preset,
    customPermission: preset === 'custom' ? block : '',
    ...(tools ? { tools } : {}),
    steps: frontValue(front, 'steps'),
        // Only the literal `true` turns vision on. A profile implies it — the
        // one thing it exists to do — everything else is read literally so
        // guessing generously doesn't feed a picture to a text-only model.
    vision: isVisionProfile || frontValue(front, 'vision') === 'true',
    visionProfile: isVisionProfile,
    bot: parseBotContract(front),
    legacySeed: isLegacySeed(slug, text),
  };
}
