// Collabs M1 - collabAgents.ts: the two SEED collab agents, shipped as ordinary
// engine agent-definition files. Same delivery mechanism as archetypes.ts and
// for the same reason: the engine loads {agent,agents}/**/*.md from every config
// dir (config/agent.ts load()), so writing a .md into globalAgentDir() makes a
// real agent with zero extra plumbing.
//
// WHY `collab: true` AT THE TOP LEVEL. The wire contract discovers a collab
// agent as "Agent.Info where options.collab is truthy". A def does NOT need an
// `options:` block to get there: core/v1/config/agent.ts's AgentSchema is a
// StructWithRest, and its `normalize` sweeps every key not in KNOWN_KEYS into
// `options`. So a bare `collab: true` line lands at `options.collab === true`,
// which is exactly what the engine lane filters on.
//
// WHY `hidden: true`. acp/directory.ts builds the chat's agent picker with
// `agents.filter((item) => item.mode !== "subagent" && item.hidden !== true)`.
// `mode: all` + `hidden: true` therefore keeps these two OFF the ordinary chat
// picker while leaving them full agents the collab runner can drive. `hidden`
// is a real schema field (core/v1/config/agent.ts), not a convention.
//
// WHY THE PAIR IS A WORKER AND AN OBSERVER. Crane BUILDS - edit and bash are
// his, and the `steps:` line is his runaway backstop. Heron only reads, because
// a verifier that can rewrite the thing it is checking is not a verifier. The
// blocks themselves live in collabPresets.ts, which the CRUD writer shares.
//
// NO ROOM LANGUAGE IN EITHER PERSONA (generation v5, W9 owner ruling). Both
// bodies used to open "You are Crane, the builder in this collab" and both
// carried a shared `COLLAB_DISCIPLINE` block - one voice in a stream, @name
// wakes nobody, silence is a valid answer. Every word of that is now taught by
// the engine's own room manual (collab/collab-agent-base.txt, injected as the
// base prompt of a collab turn - see the engine's prompt-composition matrix),
// and the SAME def also runs as a solo bot chat and as another agent's
// sub-agent, where there is no room for the text to be about. So a persona that
// named the room was both a duplicate and, two times in three, a lie. What is
// left is identity plus a few generic habits: read first, evidence over claims,
// ask rather than guess. The v4 payload is frozen in collabAgentsLegacyV4.ts so
// an install still carrying it is recognised and offered the reseed note.
//
// UNPINNED BY DESIGN (generation v4). Earlier generations pinned a local LM
// Studio model and a remote OpenRouter one — dead on arrival on any machine
// that never set those exact providers up, which is every fresh install. An
// agent def with no `model:` line is already a first-class state end to end
// (engine wire: collab/acp.ts's `modelOf` answers `null`, never throws), so
// the fix is to ship that state rather than a guessed default. The pane
// surfaces it as an actionable "needs a model" note wherever the def is read
// (CollabAgentCard.svelte, CollabAgentForm.svelte's hint) instead of leaving
// it to be discovered as a turn failure. The frozen PRIOR (pinned) generation
// lives on as `COLLAB_AGENTS_V3` in collabAgentsLegacy.ts, so an existing
// install's untouched pinned seed is still recognised and offered a reseed.
// Editing either file stops this installer touching it, forever.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './archetypes';
import {
  OBSERVER_PERMISSION_BLOCK,
  OBSERVER_STEPS,
  WORKER_PERMISSION_BLOCK,
  WORKER_STEPS,
} from './collabPresets';

/** The install-once marker, backed by globalState in the panel and faked in
 *  tests. Mirrors ArchetypeMarker exactly: get() = "already installed",
 *  set() records a successful pass. */
export interface CollabAgentMarker {
  get(): boolean;
  set(): void;
}

/** The seed pair as shipped (generation v5). Short memorable bird names beat
 *  provider names in an @mention world: you type `@collab-crane`, not
 *  `@collab-lmstudio`. */
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

/**
 * Install the seed collab agents, once per marker generation.
 *
 * WRITE-IF-ABSENT, always. A file that exists is left exactly as it is - the
 * user's edits to a persona or, more to the point, to the `model:` line, win
 * over anything shipped here. This is generation v5 (collabAgentsLegacy.ts
 * freezes v1, v3 and - next door - v4), and unlike ensureArchetypes
 * there is still no pristine-upgrade branch: a marker bump alone never
 * rewrites an existing file, so an install already carrying an untouched
 * prior generation keeps it until the user deletes it (at which point the
 * pane's legacy-seed note has already told them why) - absent means write,
 * present means leave.
 *
 * Non-fatal by design: a failure is logged, swallowed, and leaves the marker
 * UNSET so the next boot retries. The sidebar must open whether or not the
 * config dir is writable.
 */
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
