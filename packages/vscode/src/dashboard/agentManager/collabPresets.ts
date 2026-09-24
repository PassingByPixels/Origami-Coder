// The two named permission presets (WORKER, OBSERVER) a collab agent can carry, shared by
// the seed defs, the CRUD writer and the def parser. Worker builds (edit+bash); observer only
// verifies — a collab agent with no edit/bash previously could only loop trying to glob a
// folder it could never create. `task`/`todowrite` stay denied for both: delegation in a
// collab is an @mention, and a subagent farming work out would be invisible to the room.
// This engine has no `write` permission key — edit covers write/edit/patch — so
// `write: allow` would parse but grant nothing; `"*": deny` is what actually closes the door.

/** Which shipped preset a def's permission block is. `custom` = neither, i.e.
 *  a hand-edited block, which nothing here may rewrite. */
export type CollabPreset = 'worker' | 'observer' | 'custom';

/** Can edit and run commands. The default for a new collab agent. */
export const WORKER_PERMISSION_BLOCK = `permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  list: allow
  edit: allow
  bash: allow
  task: deny
  todowrite: deny`;

/** Reads only. What every collab agent used to be. */
export const OBSERVER_PERMISSION_BLOCK = `permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  list: allow
  edit: deny
  bash: deny
  task: deny
  todowrite: deny`;

/** Per-turn step budget written as `steps:` frontmatter. A collab turn is unattended and its
 *  reply fans out to the room, so a runaway turn wakes everyone, not just burns tokens. The
 *  engine's own backstop (500) is a chat number; a worker gets enough to read/change/prove
 *  one thing, an observer only ever reads. */
export const WORKER_STEPS = 40;
export const OBSERVER_STEPS = 25;

/** The block a preset writes; `custom` (hand-edited) falls back to worker only when asked
 *  for something impossible. */
export function permissionBlockFor(preset: CollabPreset): string {
  return preset === 'observer' ? OBSERVER_PERMISSION_BLOCK : WORKER_PERMISSION_BLOCK;
}

/** The one line a VISION PROFILE's block carries that no collab agent's does: profiles are
 *  now delegation targets and need to read a path outside the project (a screenshot rarely
 *  lives in it), but every preset opens with `"*": deny`, which closes `external_directory`
 *  too. `ask` not `allow`, since reading arbitrary disk paths is a human decision. Appended
 *  rather than written into the preset blocks (which `presetOf` matches byte-for-byte), and
 *  idempotent so a round-tripped def doesn't grow a second copy. */
export function withVisionExternalDirectory(block: string): string {
  if (/^[ \t]+"?external_directory"?[ \t]*:/m.test(block)) return block;
  return `${block.replace(/\s+$/, '')}\n  external_directory: ask`;
}

export function stepsFor(preset: CollabPreset): number {
  return preset === 'observer' ? OBSERVER_STEPS : WORKER_STEPS;
}

/** Line-ending/trailing-space normalisation so a CRLF-saved (Windows) def still matches its
 *  preset — without it every Windows user's def would read as custom. */
const normalize = (block: string): string =>
  block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();

/** Which preset a permission block is, by exact match after normalisation. */
export function presetOf(block: string): CollabPreset {
  const text = normalize(block);
  if (text === normalize(WORKER_PERMISSION_BLOCK)) return 'worker';
  if (text === normalize(OBSERVER_PERMISSION_BLOCK)) return 'observer';
  return 'custom';
}
