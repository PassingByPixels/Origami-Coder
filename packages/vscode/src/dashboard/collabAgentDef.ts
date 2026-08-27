// Collabs M4 - collabAgentDef.ts: the def FILE FORMAT, split out of
// collabAgentCrud.ts when the preset work took that file past its cap. Pure -
// no `fs`, no `vscode` - so every branch is exercised on strings.
//
// The one rule this module exists to enforce: a permission block that is
// NEITHER shipped preset is a block the user wrote, and it is copied back out
// verbatim. Re-serialising a hand-tuned block as a preset would silently widen
// or narrow what an agent is allowed to do, which is the one edit a save button
// must never make on its own.

import { presetOf, type CollabPreset } from './agentManager/collabPresets';
import { parseBotContract, type BotContract } from './botContract';
import { presetOfTools, toolsFromBlock } from './botTools';
import { isLegacySeed } from './agentManager/collabAgentsLegacy';
// The frontmatter primitives live next door (agentFrontmatter.ts) since
// t-kgtr6c. `permissionBlockIn` is RE-EXPORTED rather than moved out of the
// public surface: collabAgentCrud.ts re-exports it in turn, and a caller
// importing "collab agent defs" should not have to learn where the `---`
// parsing moved to.
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
   * Which permission preset the def carries.
   *
   * OPTIONAL on purpose. A def can reach the writer across a message boundary
   * that only forwards the text fields, and a missing preset must never be
   * read as "make it a worker" - it means "keep whatever the file already
   * says". writeCollabAgentDef resolves it from disk; parse always sets it.
   */
  preset?: CollabPreset;
  /** The verbatim `permission:` block, ONLY when preset is `custom`. */
  customPermission?: string;
  /**
   * WHICH TOOLS this bot has — the permission keys its `permission:` block
   * allows (botTools.ts). `undefined` = the file carries no block at all, which
   * is NOT the same as an empty tick set: no block means the def said nothing
   * and the engine's own defaults stand.
   *
   * OPTIONAL for the same reason `preset` and `vision` are: a def can reach the
   * writer across a message boundary that only forwards the text fields, and an
   * absent tick set must read as "keep whatever the file already says" rather
   * than as "this bot is deliberately allowed nothing".
   */
  tools?: string[];
  /** The `steps:` frontmatter value as written, or `''` for the preset default. */
  steps?: string;
  /**
   * `vision: true` - this agent may be handed REAL image parts (M4.4 gates them
   * on this frontmatter key; without it an attached image reaches the agent as a
   * blind note). Optional and read as false when absent, which is the honest
   * default: a model that cannot see must never be told it can.
   *
   * It is parsed AND written. Before this it was parse-less, so a `vision:` line
   * added by hand was dropped the first time the pane saved the def - the agent
   * silently went blind on an edit that never mentioned vision.
   */
  vision?: boolean;
  /**
   * `vision-profile: true` - this def is a VISION PROFILE (t-kgtr6c), not a
   * collab agent. It is the ONE key that tells the two apart, because they
   * live in the same directory and are the same file format otherwise.
   *
   * A profile is what a chat hands an image to when its own model cannot see
   * one. It is deliberately NOT `collab: true`: a profile has no business
   * appearing in the roster a collab is built from, where it would be picked
   * for work it is not written for. The engine needs neither key - it loads
   * both as ordinary hidden agents, and reads only `vision:` (collab/runner.ts)
   * - so this stays a pane-side distinction and adds nothing to the wire.
   *
   * A profile ALWAYS carries `vision: true` as well; serializeAgentDef writes
   * it, because a profile that cannot be shown pixels is the one def where the
   * default would be silently useless.
   */
  visionProfile?: boolean;
  /**
   * THE BOT CONTRACT - `permissions:`, `skills:`, `model_prefer:`, `memory:`
   * (botContract.ts). Always set by parse, as an EMPTY object when the file
   * declares none of them.
   *
   * OPTIONAL on the type for the same reason `preset` is: a def can reach the
   * writer across a message boundary that only forwards the text fields, and an
   * absent contract must read as "keep whatever the file already says" rather
   * than as "this bot is deliberately configured with nothing".
   */
  bot?: BotContract;
  /** True when the file on disk is a prior shipped seed, untouched. Computed on
   *  read and ignored on write - the pane uses it for the reseed note. */
  legacySeed?: boolean;
}

/**
 * Parse a def file. Returns null when the file is neither a COLLAB agent nor a
 * VISION PROFILE - either it has no frontmatter at all, or its frontmatter
 * carries neither `collab: true` nor `vision-profile: true`. That filter is the
 * whole reason this lists the directory safely: the same folder holds the
 * archetypes (architect/ask/debug/...), and offering to edit one of those from
 * the Agents board would be wrong.
 *
 * The gate was `collab: true` ALONE until t-kgtr6c. It is widened rather than
 * removed: a def has to declare which of the two things it is, so the board can
 * put it under the right tab. A file carrying BOTH keys reads as a collab agent
 * that also happens to see - which is exactly what it says, and what it already
 * was before profiles existed.
 */
export function parseAgentDef(slug: string, text: string): CollabAgentDef | null {
  const m = text.match(FRONT_BLOCK);
  if (!m) return null;
  const front = m[1];
  const isCollab = frontValue(front, 'collab') === 'true';
  const isVisionProfile = frontValue(front, 'vision-profile') === 'true';
  if (!isCollab && !isVisionProfile) return null;
  const block = permissionBlockIn(front);
  // The TICK SET is what the block means since W6, so the preset is read off it
  // rather than off the block's bytes: a def whose ticks are the worker set is a
  // worker however its lines are ordered, and `presetOf` would call every one of
  // them `custom` the moment the checklist rewrote the file. A def with NO block
  // still falls through to `presetOf`, which answers `custom` and leaves it
  // blockless — the one rule this file has always enforced.
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
    // Only the literal `true` turns vision on. Anything else - absent, empty,
    // `yes`, `1` - is false: this key decides whether an image is really sent,
    // and guessing generously is how a text-only model gets fed a picture.
    // A profile that is not `vision: true` could not be shown a picture, which
    // is the only thing it exists to do - so the key is IMPLIED for a profile
    // and read literally for everything else.
    vision: isVisionProfile || frontValue(front, 'vision') === 'true',
    visionProfile: isVisionProfile,
    bot: parseBotContract(front),
    legacySeed: isLegacySeed(slug, text),
  };
}
