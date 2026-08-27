// collabAgentSerialize.ts — the WRITE half of the def file format, split out of
// collabAgentDef.ts (171 of its 175-line cap) when the bot contract arrived.
//
// The split is not arbitrary. Reading a def answers "what does this file say";
// writing one answers "what may this board put back", and the second question
// is the one that keeps growing — it now has to emit four more optional keys,
// each under its own omit-at-its-default rule, without disturbing the two rules
// that were already here (a custom permission block is copied out verbatim, and
// a def that HAD no block still has none).
//
// Re-exported by collabAgentDef.ts, so no importer moved.
//
// Pure — no fs, no `vscode` — so every branch is exercised on strings.

import { permissionBlockFor, stepsFor, withVisionExternalDirectory } from './agentManager/collabPresets';
import { botContractLines } from './botContract';
import { presetOfTools, toolBlockFor } from './botTools';
import type { CollabAgentDef } from './collabAgentDef';

/**
 * The file a def becomes. `mode: all` + `hidden: true` keep it off the ordinary
 * chat picker while leaving it a full agent (see collabAgents.ts).
 *
 * `model:` and `glyph:` are OMITTED when empty rather than written blank: a
 * `model:` with nothing after it is a pinned empty model, which is not the same
 * as not pinning one. `steps:` is the opposite - a collab turn always gets an
 * explicit budget, so an unset one falls back to the preset's number rather
 * than to the engine's 500-step chat default.
 *
 * THE BOT CONTRACT follows the `model:`/`glyph:` rule, not the `steps:` one:
 * every one of its four keys is omitted when the def declared nothing, so a def
 * that was never configured as a bot keeps looking that way. botContract.ts
 * owns which of them that means (`memory: true` is the engine default and is
 * therefore never written).
 *
 * The contract sits ALONGSIDE the permission block, never instead of it: the
 * engine composes the two (a tier is a starting point; an explicit `permission:`
 * line beats it), so dropping either when the other is present would silently
 * change what the bot may do.
 */
export function serializeAgentDef(def: CollabAgentDef): string {
  // READ OFF THE TICKS when the def states them. `preset` only decides the step
  // budget now, and a stored one that disagreed with the ticks would stamp a
  // worker's 40 steps on a def whose checklist says observer. One source of
  // truth, and it is the set the user actually looked at.
  const preset = def.tools ? presetOfTools(def.tools) : (def.preset ?? 'worker');
  const lines = [
    '---',
    // OMITTED when blank, the same rule `model:` and `glyph:` follow below.
    // `description: ""` is not "no description" downstream: the engine renders
    // its task roster off this field and an empty string produced a line reading
    // `- name: ` with nothing after the colon. Absent, its fallback applies.
    ...(def.description.trim() ? [`description: "${def.description.replace(/"/g, '\\"')}"`] : []),
    'mode: all',
    'hidden: true',
    // EXCLUSIVE by construction: a vision profile is written as a profile and
    // never as a collab agent. Writing both would put one file in both tabs,
    // and put a describe-only agent in the roster a collab is built from.
    ...(def.visionProfile ? ['vision-profile: true'] : ['collab: true']),
  ];
  if (def.model) lines.push(`model: ${def.model}`);
  if (def.glyph) lines.push(`glyph: ${def.glyph}`);
  // OMITTED when false, the same rule `model:` and `glyph:` follow. `vision:
  // false` and no `vision:` line mean the same thing to the engine, and writing
  // the negative on every def would put a key in five files to say nothing.
  // ALWAYS written for a profile: the engine reads `vision:` and nothing else,
  // so a profile without it is a def the engine would hand a blind note to.
  if (def.vision || def.visionProfile) lines.push('vision: true');
  if (def.bot) lines.push(...botContractLines(def.bot));
  lines.push(`steps: ${def.steps || stepsFor(preset)}`);
  // THE TICK SET WINS when the def states one (W6): the checklist is the only
  // permission surface the editor offers now, so a stated set is what the user
  // last looked at and a preset block written over it would be the silent
  // rewrite this file exists to refuse. An UNSTATED set falls back to the two
  // rules that were already here — `custom` is copied out exactly as it came
  // in, and a def that HAD no permission block still has none.
  const block = def.tools
    ? toolBlockFor(def.tools)
    : preset !== 'custom'
      ? permissionBlockFor(preset)
      : def.customPermission;
  // A VISION PROFILE gets one line the three branches above cannot supply -
  // see `withVisionExternalDirectory`. Applied to whichever block was chosen,
  // including a hand-written one, because the need comes from what a profile
  // IS, not from which branch wrote its permissions.
  if (block) lines.push(def.visionProfile ? withVisionExternalDirectory(block) : block);
  lines.push('---', '', def.persona.trimEnd(), '');
  return lines.join('\n');
}
