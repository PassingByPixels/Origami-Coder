// Collabs M4 - collabPresets.ts: the two NAMED permission presets a collab
// agent can carry, extracted from collabAgents.ts so the seed defs, the CRUD
// writer and the def parser all read one copy.
//
// WORKER vs OBSERVER is the whole feature. A collab used to be read-only end to
// end, and the failure that produced this file was a model asked to create a
// folder: with no edit and no bash it could only glob for a folder it could
// never make, re-running the same search until the turn died. A worker builds;
// an observer verifies. Both are deny-by-default - the difference is exactly
// two lines.
//
// WHY `task` AND `todowrite` STAY DENIED FOR BOTH. Delegation in a collab is
// an @mention, not a subagent: the stream is the shared record, and work farmed
// out through the task tool happens where nobody in the room can read it. A
// worker that could spawn subagents would route around the collab it is in.
//
// WHY NO `write` PERMISSION KEY. This engine has no `write` permission - edit
// covers write/edit/patch (core/v1/config/agent.ts normalize maps all three
// onto `edit`). A `write: allow` line would parse fine and grant nothing, which
// is a worse lie than its absence. `"*": deny` is what actually closes the
// door; the explicit lines below are emphasis on the load-bearing ones.

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

/**
 * The per-turn agentic step budget each preset writes as `steps:` frontmatter.
 *
 * A collab turn is UNATTENDED in a way an ordinary chat is not: its reply fans
 * out to every other participant, so a runaway turn does not just burn tokens,
 * it wakes the room. The engine's own backstop is 500 steps
 * (session/prompt.ts DEFAULT_MAX_STEPS), which is a chat number. A worker gets
 * enough to read, change and prove one thing; an observer only ever reads.
 */
export const WORKER_STEPS = 40;
export const OBSERVER_STEPS = 25;

/** The block a preset writes. `custom` has no canonical block - its caller
 *  keeps the one already on disk - so it falls back to the worker block only
 *  when a caller asks for something impossible. */
export function permissionBlockFor(preset: CollabPreset): string {
  return preset === 'observer' ? OBSERVER_PERMISSION_BLOCK : WORKER_PERMISSION_BLOCK;
}

/**
 * The one line a VISION PROFILE's block carries that no collab agent's does.
 *
 * A profile is now a delegation target as well as a describe-only completion:
 * the engine re-admits it to the `task` roster, and the model is told to send
 * it a PATH. A screenshot almost never lives inside the project - it is in
 * Downloads, in the user's temp folder, on another drive - so the first thing
 * the profile does is read a file outside the worktree. Every block here opens
 * with `"*": deny`, which closes `external_directory` along with everything
 * else, so without this line the profile is denied before the user is ever
 * asked, and the only symptom is a description that never arrives.
 *
 * `ask`, not `allow`: reading arbitrary paths on the user's disk is exactly
 * the decision a human should make once, per folder, at the bar.
 *
 * APPENDED rather than written into the preset blocks, because those two are
 * matched byte-for-byte by `presetOf` - editing them would make every collab
 * def already on disk read as hand-edited. Idempotent, so a def that round-
 * trips through the editor does not grow a second copy.
 */
export function withVisionExternalDirectory(block: string): string {
  if (/^[ \t]+"?external_directory"?[ \t]*:/m.test(block)) return block;
  return `${block.replace(/\s+$/, '')}\n  external_directory: ask`;
}

export function stepsFor(preset: CollabPreset): number {
  return preset === 'observer' ? OBSERVER_STEPS : WORKER_STEPS;
}

/**
 * Line-ending and trailing-space normalisation, so a def VS Code has saved back
 * as CRLF is still recognised as the preset it is. Without this every Windows
 * user's shipped def would read as `custom` and the pane would refuse to touch
 * a block it wrote itself.
 */
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
