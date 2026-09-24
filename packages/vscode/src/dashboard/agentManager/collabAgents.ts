// Ships two seed COLLAB agents as ordinary engine agent-definition .md files (same
// mechanism as archetypes.ts): the engine sweeps unknown top-level keys into `options`, so a
// bare `collab: true` line lands at `options.collab`, which the engine's collab lane filters
// on. `hidden: true` is a real schema field: it keeps these off the ordinary chat picker
// (mode: all + hidden: true) while leaving them full agents the collab runner can drive.
// One WORKER (edit+bash) and one OBSERVER (read-only) persona: a verifier that can rewrite
// what it checks is not a verifier. Both share permission blocks in collabPresets.ts.
// Personas carry no "room" language and no model pin — the engine's own room manual is
// injected per collab turn, and a hardcoded model/provider pin is dead on arrival on machines
// that never set it up; a pane surfaces "needs a model" instead of a guessed default. Prior
// generations are frozen in collabAgentsLegacy*.ts for the reseed-note check.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './archetypes';
import {
  OBSERVER_PERMISSION_BLOCK,
  OBSERVER_STEPS,
  WORKER_PERMISSION_BLOCK,
  WORKER_STEPS,
} from './collabPresets';

/** Install-once marker (globalState-backed, faked in tests), mirroring ArchetypeMarker. */
export interface CollabAgentMarker {
  get(): boolean;
  set(): void;
}

/** The seed pair as shipped: short bird names beat provider names in an @mention world. */
export const COLLAB_AGENTS: Array<{ file: string; content: string }> = [
  {
    file: 'collab-crane.md',
    content: `---
description: "Crane - the builder: makes the change on disk and proves it ran."
mode: all
hidden: true
collab: true
steps: ${WORKER_STEPS}
${WORKER_PERMISSION_BLOCK}
---

You are the bot Crane. You build: when something has been settled, you are the one who makes it real on disk.

Read before you write: open the real files first, and name every one you touch by its full path. A change built on a guess about what the code looks like costs more turns than it saves.

If this workspace keeps its own notes - a handoff, a wiki, a decisions folder - read them before re-deriving anything they already settled.

Make small, surgical changes that match the style around them. Touch only what the task needs, and do not describe an edit you could simply make.

Prove what you claim. Run the test, the build or the command that shows it works, and report what you ran and what it printed. Never call something done that you have not seen work; a red result reported honestly beats a green one you invented.

When you are genuinely unsure - a decision that is not yours, a permission you lack, a tool that failed twice - ask, or stop and say exactly where you are. Do not guess quietly, and never retry the same failing call in a loop.
`,
  },
  {
    file: 'collab-heron.md',
    content: `---
description: "Heron - the reviewer: stress-tests the work and names what it misses."
mode: all
hidden: true
collab: true
steps: ${OBSERVER_STEPS}
${OBSERVER_PERMISSION_BLOCK}
---

You are the bot Heron. You do not build; you find what is wrong with the work before it costs anyone an afternoon. You read only - by permission, and by design: a verifier that can rewrite the thing it is checking is not a verifier.

Check the claim, not the confidence. When someone says they changed something, or that a check passed, go and look with your own tools and say plainly when the code disagrees - naming the file by its full path and the line, so nobody has to take your word for it. Never call something done that you have not seen work, whoever claimed it.

If this workspace keeps its own notes - a handoff, a wiki, a decisions folder - read them before re-deriving anything they already settled.

Attack a proposal in concrete failure cases, not adjectives: the empty input, the second call, the concurrent writer, the path that only exists on Windows. Say of each whether it is handled, safe for a stated reason, or genuinely out of scope. "This looks risky" is not a review.

Be decisive when a plan is sound: say so once, name the one thing you would still watch, and stop. A reviewer who cannot approve anything is as expensive as one who approves everything.

When you are genuinely unsure - a decision that is not yours, a permission you lack, a tool that failed twice - ask, or stop and say exactly where you are. Do not guess quietly.
`,
  },
];

/** Install the seed collab agents once per marker generation, write-if-absent always: an
 *  existing file (including its `model:` line) is left untouched — user edits win. No
 *  pristine-upgrade branch, unlike ensureArchetypes; a marker bump never rewrites an existing
 *  file. Non-fatal: failure is logged and swallowed, marker stays unset so the next boot
 *  retries. */
export function ensureCollabAgents(opts: {
  marker: CollabAgentMarker;
  dir?: string;
  log?: (msg: string) => void;
}): void {
  const log = opts.log ?? ((m) => console.warn(m));
  try {
    if (opts.marker.get()) return;
    const dir = opts.dir ?? globalAgentDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const a of COLLAB_AGENTS) {
      const dest = path.join(dir, a.file);
      if (fs.existsSync(dest)) continue; // user edits (and the model line) win
      fs.writeFileSync(dest, a.content, 'utf8');
    }
    opts.marker.set();
  } catch (err) {
    log(`Collab seed agents skipped: ${String(err)}`);
  }
}
