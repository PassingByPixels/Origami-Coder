// THE THREE PERSONA DEFAULTS, held to one set of rules (W9 owner ruling).
//
// A "persona default" is text this build puts in front of a stranger's model
// without them asking for it, and there are exactly three of them:
//
//   1. the ENGINE's scaffold          packages/engine/src/agent/bot-def-template.txt
//   2. the two SHIPPED SEED bots      src/dashboard/agentManager/collabAgents.ts
//   3. the FORM's seed for a new bot  webview/dashboard/components/collabPersonaSeed.ts
//
// They live on three different sides of two seams — an engine .txt, an extension
// module, a webview module — so nothing but a test can hold them to the same
// rules, and each of the three has drifted from the others before.
//
// THE RULES, and why each one is a rule rather than taste:
//
//  A. IT OPENS AS A BOT IDENTITY. A persona COMPOSES on top of the base agent
//     prompt (the engine's own composition matrix: a bot session is base prompt
//     + persona, test/session/prompt-matrix.test.ts row B). A persona that
//     re-announces being an interactive CLI tool spends context restating the
//     paragraph directly above it, and contradicts it whenever the two disagree.
//  B. NO ROOM LANGUAGE. The same definition runs three ways — a solo bot chat, a
//     participant in a room, and another agent's sub-agent. The room's rules are
//     injected by the runner at turn time (collab/collab-agent-base.txt), so
//     naming the room in a persona is a duplicate in one case and a lie in two.
//  C. THE SAME FOUR HABITS. Full paths, the workspace's own notes, evidence
//     before a claim, and asking rather than guessing. Three defaults teaching
//     three different sets of habits is how a fleet ends up behaving three ways.
//  D. WORKSPACE-AGNOSTIC. This ships to strangers. A default that names AGENTS.md
//     or HANDOFF.md sends every bot everywhere hunting a file that is ours.
//
// The engine template is read as a FILE rather than imported: a webview test
// cannot import from packages/engine (per-package installs), and reading the
// bytes is the stronger check anyway — it is what the engine ships.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLAB_AGENTS } from '../../../src/dashboard/agentManager/collabAgents';
import { personaSeed } from '../components/collabPersonaSeed';

/** The engine's scaffold, from the file the engine actually imports. */
const TEMPLATE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', 'engine', 'src', 'agent', 'bot-def-template.txt',
  ),
  'utf8',
);

/** Only the PERSONA half of each default — the frontmatter above the closing
 *  fence is configuration, and `permission:`/`collab:` there are not prose. */
const bodyOf = (text: string): string => {
  const parts = text.split(/^---$/m);
  return parts.length > 2 ? parts.slice(2).join('---') : text;
};

/** Matched against WHITESPACE-COLLAPSED text: the engine template is hard
 *  wrapped at 80 columns and the other two are not, so a sentence that reads
 *  identically on screen differs by a newline in the middle of a phrase. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

const named = (name: string, body: string) => ({ name, body, flat: flatten(body) });

const DEFAULTS = [
  named('engine bot-def-template.txt', bodyOf(TEMPLATE)),
  ...COLLAB_AGENTS.map((a) => named(`seed ${a.file}`, bodyOf(a.content))),
  named('form personaSeed()', personaSeed('collab-scout')),
];

/** The subset that describes DOING the work. Heron is deliberately read-only —
 *  telling a verifier to make small surgical changes would be describing a job
 *  its own permission block forbids, which is the one lie a persona must not
 *  tell (a model believes the prose over the block). */
const WRITERS = DEFAULTS.filter((d) => !d.name.includes('heron'));

describe('A. every persona default opens as a BOT IDENTITY', () => {
  it.each(DEFAULTS)('$name says "You are the bot …"', ({ body }) => {
    expect(body.trimStart()).toMatch(/^You are the bot /);
  });

  it.each(DEFAULTS)('$name does not re-declare what the base prompt declares', ({ flat }) => {
    expect(flat).not.toMatch(/interactive CLI tool/i);
    expect(flat).not.toMatch(/you are origami/i);
    expect(flat).not.toMatch(/software engineering tasks/i);
  });
});

describe('B. no persona default mentions a room', () => {
  // `collab`/`room` are the two the seeds carried for four generations; the rest
  // are the vocabulary that came with them and would drag the concept back in.
  it.each(DEFAULTS)('$name is silent about rooms and collabs', ({ flat }) => {
    for (const word of [/\bcollabs?\b/i, /\brooms?\b/i, /shared stream/i, /@mention/i, /task board/i]) {
      expect(flat, `still says ${word}`).not.toMatch(word);
    }
  });
});

describe('C. the same working habits, everywhere', () => {
  // Phrased as "what the habit means", not "the exact sentence": these are three
  // separate documents and one of them is a scaffold full of instructions to the
  // AUTHOR. Pinning bytes would make every wording tweak a test edit, which is
  // how a guard stops being read and starts being satisfied.
  const UNIVERSAL: Array<[string, RegExp]> = [
    ['name files by their full path', /full path/i],
    ['read the workspace’s own notes first', /a handoff, a wiki, a decisions folder/i],
    ['never claim what you have not seen work', /never call something done that you have not seen work/i],
    ['ask rather than guess', /(ask, or stop and say|ask rather than guess)/i],
  ];
  it.each(DEFAULTS)('$name teaches every universal habit', ({ flat }) => {
    for (const [what, re] of UNIVERSAL) expect(flat, `missing: ${what}`).toMatch(re);
  });

  // Two more that only make sense for a default that WRITES. See `WRITERS`.
  it.each(WRITERS)('$name also teaches the two habits of writing', ({ flat }) => {
    expect(flat, 'missing: read before you write').toMatch(/read before you write/i);
    expect(flat, 'missing: small, surgical changes').toMatch(/small, surgical changes/i);
  });
});

describe('D. nothing names a file that only exists in one workspace', () => {
  it.each(DEFAULTS)('$name is workspace-agnostic', ({ flat }) => {
    expect(flat).not.toMatch(/AGENTS\.md|HANDOFF\.md|CLAUDE\.md|README\.md|\.origami\//);
  });

  // The workspace-notes habit is CONDITIONAL for the same reason: a stranger's
  // repo may keep no notes at all, and an unconditional order to read them
  // teaches every bot to open its turn hunting for something that is not there.
  it.each(DEFAULTS)('$name states the notes habit conditionally', ({ flat }) => {
    expect(flat).toMatch(/If this workspace keeps/i);
  });
});

describe('a role card, not a rulebook', () => {
  // The owner's word was SHORT. There is no correct number, so this is a
  // TRIPWIRE rather than a limit: the seeds sit around 1.4k characters, and a
  // default that has doubled has stopped being a role card without anyone
  // deciding it should.
  it.each(DEFAULTS)('$name stays short enough to read', ({ flat }) => {
    expect(flat.length).toBeLessThan(2600);
  });
});
