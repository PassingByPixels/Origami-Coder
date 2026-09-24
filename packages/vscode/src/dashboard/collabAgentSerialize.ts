// collabAgentSerialize.ts — the WRITE half of the def file format.
//
// Reading answers "what does this file say"; writing answers "what may this
// board put back" — it must emit each optional key under its own
// omit-at-default rule without disturbing the two rules already here: a
// custom permission block is copied out verbatim, and a def with no block still has none.

import { permissionBlockFor, stepsFor, withVisionExternalDirectory } from './agentManager/collabPresets';
import { botContractLines } from './botContract';
import { presetOfTools, toolBlockFor } from './botTools';
import type { CollabAgentDef } from './collabAgentDef';

/**
 * The file a def becomes. `mode: all` + `hidden: true` keep it off the
 * ordinary chat picker while leaving it a full agent.
 *
 * `model:`/`glyph:` are omitted when empty — blank isn't the same as
 * "not pinned". `steps:` is the opposite: a collab turn always gets an
 * explicit budget, falling back to the preset's number. The bot contract
 * follows the omit-when-empty rule too, and sits ALONGSIDE the permission
 * block, never instead of it — the engine composes both.
 */
export function serializeAgentDef(def: CollabAgentDef): string {
    // Read off the ticks when the def states them — `preset` now only decides
    // the step budget, so a stored one that disagreed with the ticks would be wrong.
  const preset = def.tools ? presetOfTools(def.tools) : (def.preset ?? 'worker');
  const lines = [
    '---',
        // Omitted when blank; an empty description would render as a task-roster
        // line with nothing after the colon.
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
    // Omitted when false, same rule as `model:`/`glyph:`. Always written for a
    // profile, since the engine reads only `vision:` and nothing else.
  if (def.vision || def.visionProfile) lines.push('vision: true');
  if (def.bot) lines.push(...botContractLines(def.bot));
  lines.push(`steps: ${def.steps || stepsFor(preset)}`);
    // The tick set wins when the def states one (W6): the checklist is the
    // only permission surface the editor offers, so a preset block written
    // over a stated set would be the silent rewrite this file exists to refuse.
  const block = def.tools
    ? toolBlockFor(def.tools)
    : preset !== 'custom'
      ? permissionBlockFor(preset)
      : def.customPermission;
    // A vision profile gets one extra line the three branches above can't
    // supply, applied to whichever block was chosen.
  if (block) lines.push(def.visionProfile ? withVisionExternalDirectory(block) : block);
  lines.push('---', '', def.persona.trimEnd(), '');
  return lines.join('\n');
}
