// collabAgents — the seed collab agent defs and their write-if-absent
// installer. A real temp dir stands in for the global agent dir (NEVER the
// user's ~/.config), with a mutable fake marker, exactly as archetypes.test.ts
// does.
//
// The CONTENT assertions are not decoration. Two of these fields are the whole
// feature working or not:
//   `collab: true`  - the engine discovers a collab agent as `options.collab`
//     truthy, and core/v1/config/agent.ts sweeps unknown frontmatter keys into
//     `options`. Drop the line and `collab_agents` returns nothing, with no
//     error anywhere to explain why.
//   `hidden: true`  - acp/directory.ts builds the chat's agent picker with
//     `mode !== "subagent" && hidden !== true`. Drop it and these two turn up
//     in every chat's agent list, which is not what they are for.
// And the deny-by-default permission block is what actually decides what they
// can do; the prose in the body is not enforcement.
//
// M4 adds the split the pair now embodies: crane is a WORKER (edit + bash) and
// heron stays an OBSERVER. That difference is the feature, so it is asserted
// per file rather than "both carry a block".

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCollabAgents, COLLAB_AGENTS } from '../../../src/dashboard/agentManager/collabAgents';
import {
  OBSERVER_PERMISSION_BLOCK,
  OBSERVER_STEPS,
  WORKER_PERMISSION_BLOCK,
  WORKER_STEPS,
  presetOf,
} from '../../../src/dashboard/agentManager/collabPresets';
import { COLLAB_AGENTS_V1, COLLAB_AGENTS_V3, COLLAB_AGENTS_V4, isLegacySeed } from '../../../src/dashboard/agentManager/collabAgentsLegacy';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-agents-'));
  tmp.push(d);
  return d;
}
function fakeMarker(initial = false) {
  const state = { installed: initial, setCalls: 0 };
  return {
    marker: { get: () => state.installed, set: () => { state.installed = true; state.setCalls += 1; } },
    state,
  };
}

afterAll(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

const FILES = ['collab-crane.md', 'collab-heron.md'];

describe('ensureCollabAgents', () => {
  it('writes both seed agents when none exist, then records the install', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(false);
    ensureCollabAgents({ marker, dir, log: () => {} });

    expect(fs.readdirSync(dir).sort()).toEqual(FILES);
    for (const a of COLLAB_AGENTS) {
      expect(fs.readFileSync(path.join(dir, a.file), 'utf8')).toBe(a.content);
    }
    expect(state.installed).toBe(true);
    expect(state.setCalls).toBe(1);
  });

  it('is idempotent: a second pass over the SAME dir writes nothing and does not re-mark', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(false);
    ensureCollabAgents({ marker, dir, log: () => {} });
    const before = FILES.map((f) => fs.statSync(path.join(dir, f)).mtimeMs);

    ensureCollabAgents({ marker, dir, log: () => {} });
    expect(FILES.map((f) => fs.statSync(path.join(dir, f)).mtimeMs)).toEqual(before);
    expect(state.setCalls).toBe(1);
  });

  it("never overwrites a file the user edited - their model line and persona win", () => {
    const dir = tmpDir();
    const edited = path.join(dir, 'collab-crane.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(edited, '---\nmodel: my/own-model\ncollab: true\n---\nMine.', 'utf8');

    const { marker } = fakeMarker(false);
    ensureCollabAgents({ marker, dir, log: () => {} });

    expect(fs.readFileSync(edited, 'utf8')).toBe('---\nmodel: my/own-model\ncollab: true\n---\nMine.');
    expect(fs.existsSync(path.join(dir, 'collab-heron.md'))).toBe(true);   // the other still lands
  });

  it('with the marker already set, writes nothing at all', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(true);
    ensureCollabAgents({ marker, dir, log: () => {} });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(state.setCalls).toBe(0);
  });

  it('does not resurrect a seed the user deleted after the marker was recorded', () => {
    const dir = tmpDir();
    const { marker } = fakeMarker(false);
    ensureCollabAgents({ marker, dir, log: () => {} });
    fs.rmSync(path.join(dir, 'collab-heron.md'));
    ensureCollabAgents({ marker, dir, log: () => {} });
    expect(fs.existsSync(path.join(dir, 'collab-heron.md'))).toBe(false);
  });

  it('is non-fatal: a write failure is logged, never thrown, and leaves the marker unset so it retries', () => {
    const dir = tmpDir();
    // A regular FILE where the agent dir should be, so mkdir throws.
    const blocked = path.join(dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory', 'utf8');

    const { marker, state } = fakeMarker(false);
    const logged: string[] = [];
    expect(() => ensureCollabAgents({ marker, dir: blocked, log: (m) => logged.push(m) })).not.toThrow();
    expect(logged.join(' ')).toContain('Collab seed agents skipped');
    expect(state.installed).toBe(false);
  });
});

describe('the seed agent definitions', () => {
  it('ships exactly the two named seeds', () => {
    expect(COLLAB_AGENTS.map((a) => a.file)).toEqual(FILES);
  });

  it('each carries the frontmatter the ENGINE keys on: collab, hidden and mode', () => {
    for (const a of COLLAB_AGENTS) {
      const front = a.content.split('---')[1];
      expect(front, a.file).toContain('collab: true');
      expect(front, a.file).toContain('hidden: true');
      expect(front, a.file).toContain('mode: all');
      expect(front, a.file).toMatch(/description: ".+"/);
    }
  });

  it('ships UNPINNED — no `model:` line at all, on either seed', () => {
    // v4: earlier generations pinned a local LM Studio model and a free
    // OpenRouter one, both dead on arrival on a machine that never set up
    // those exact providers. `model: ''` (no line) is already a first-class
    // state end to end (collab/acp.ts's `modelOf` answers null, never
    // throws); shipping it is the fix. See collabAgents.ts's header.
    for (const a of COLLAB_AGENTS) {
      const front = a.content.split('---')[1];
      expect(front, a.file).not.toMatch(/^model:/m);
    }
  });

  it('CRANE is a worker: he can really edit files and run commands', () => {
    // The whole point of M4. Asked to create a folder, the read-only crane could
    // only glob for a folder he could never make, forever. These two lines are
    // the fix, and they are enforcement, not prose.
    const crane = COLLAB_AGENTS.find((a) => a.file === 'collab-crane.md')!;
    expect(crane.content).toContain(WORKER_PERMISSION_BLOCK);
    expect(crane.content).toMatch(/^ {2}edit: allow$/m);
    expect(crane.content).toMatch(/^ {2}bash: allow$/m);
    expect(presetOf(WORKER_PERMISSION_BLOCK)).toBe('worker');
  });

  it('presetOf recognises a block whatever whitespace it arrived in', () => {
    // Its callers hand it text straight off disk. A CRLF or trailing-space copy
    // of a shipped block that read as `custom` would make the pane refuse to
    // touch a block it wrote itself.
    expect(presetOf(WORKER_PERMISSION_BLOCK.replace(/\n/g, '\r\n'))).toBe('worker');
    expect(presetOf(OBSERVER_PERMISSION_BLOCK.replace(/\n/g, ' \n'))).toBe('observer');
    expect(presetOf(`${OBSERVER_PERMISSION_BLOCK}\n  webfetch: allow`)).toBe('custom');
    expect(presetOf('')).toBe('custom');
  });

  it('HERON stays an observer: a verifier that can rewrite the code is not a verifier', () => {
    const heron = COLLAB_AGENTS.find((a) => a.file === 'collab-heron.md')!;
    expect(heron.content).toContain(OBSERVER_PERMISSION_BLOCK);
    expect(heron.content).toMatch(/^ {2}edit: deny$/m);
    expect(heron.content).toMatch(/^ {2}bash: deny$/m);
  });

  it('neither can spawn subagents - delegation in a collab is an @mention', () => {
    // A worker that could call `task` would move the work somewhere the room
    // cannot read, which is the one thing a shared stream cannot allow.
    for (const a of COLLAB_AGENTS) {
      const front = a.content.split('---')[1];
      // Deny-by-default first: "*": deny flips the permissive base default, and
      // findLast means the re-grants below it win for the named tools only.
      expect(front.indexOf('"*": deny'), a.file).toBeGreaterThan(-1);
      for (const allowed of ['read: allow', 'grep: allow', 'glob: allow', 'list: allow']) {
        expect(front, a.file).toContain(allowed);
      }
      for (const denied of ['task: deny', 'todowrite: deny']) {
        expect(front, a.file).toContain(denied);
      }
      // The re-grants must come AFTER the wildcard deny or they never apply.
      expect(front.indexOf('read: allow'), a.file).toBeGreaterThan(front.indexOf('"*": deny'));
    }
  });

  it('each pins an explicit per-turn step budget, so a runaway turn cannot wake the room forever', () => {
    // Without `steps:` a collab turn inherits the engine's 500-step chat
    // backstop (session/prompt.ts DEFAULT_MAX_STEPS) - a number chosen for an
    // attended chat with a Stop button, not for a turn that fans out on finish.
    const steps = (file: string) => COLLAB_AGENTS.find((a) => a.file === file)!.content.match(/^steps: (\d+)$/m)?.[1];
    expect(steps('collab-crane.md')).toBe(String(WORKER_STEPS));
    expect(steps('collab-heron.md')).toBe(String(OBSERVER_STEPS));
  });

  // --- W9: the personas are BOT personas, not room personas -----------------
  // The ruling, and the whole reason the v4 payload had to be frozen: the SAME
  // def runs as a solo bot chat, as a room participant and as another agent's
  // sub-agent. Room protocol is injected by the runner at turn time
  // (collab/collab-agent-base.txt), so a persona that names the room is a
  // duplicate in one of those three cases and a lie in the other two.
  it('opens as a BOT IDENTITY, not as a role in a room', () => {
    expect(COLLAB_AGENTS.find((a) => a.file === 'collab-crane.md')!.content).toContain('You are the bot Crane.');
    expect(COLLAB_AGENTS.find((a) => a.file === 'collab-heron.md')!.content).toContain('You are the bot Heron.');
  });

  it('says nothing at all about rooms, collabs or the stream', () => {
    for (const a of COLLAB_AGENTS) {
      const body = a.content.split('\n---\n')[1] ?? '';
      for (const word of [/\bcollab\b/i, /\broom\b/i, /shared stream/i, /@mention/i, /task board/i, /handoff tool/i]) {
        expect(body, `${a.file} persona still talks about the room: ${word}`).not.toMatch(word);
      }
    }
  });

  // It composes ON TOP of the base agent prompt (the engine's prompt matrix:
  // bot session = base prompt + persona), which already says what origami is.
  // A persona re-announcing it spends context saying what was just said.
  it('does not re-declare what the base prompt already declares', () => {
    for (const a of COLLAB_AGENTS) {
      const body = a.content.split('\n---\n')[1] ?? '';
      expect(body, a.file).not.toMatch(/interactive CLI tool/i);
      expect(body, a.file).not.toMatch(/you are origami/i);
    }
  });

  it('the two personas are genuinely different agents, not one prompt twice', () => {
    const [crane, heron] = COLLAB_AGENTS;
    expect(crane.content).toContain('You are the bot Crane');
    expect(heron.content).toContain('You are the bot Heron');
    expect(crane.content).not.toBe(heron.content);
  });

  it("crane's persona tells him to BUILD - read, change, then prove it ran", () => {
    // A worker permission block behind a persona that still says "you cannot
    // change anything" is worse than either alone: the model believes the prose.
    const crane = COLLAB_AGENTS.find((a) => a.file === 'collab-crane.md')!.content;
    expect(crane).not.toContain('You cannot change anything on disk');
    expect(crane).toContain('you are the one who makes it real on disk');
    expect(crane).toMatch(/Read before you write/);
    expect(crane).toMatch(/Prove what you claim/);
    // And the anti-loop rule that the observed failure needed.
    expect(crane).toMatch(/never retry the same failing call in a loop/i);
  });

  // The four habits the owner named, in BOTH seeds and in the form's own seed
  // (personaDefaults.test.ts holds the cross-surface half). Here: neither seed
  // may quietly lose one while the other keeps it.
  it('both seeds carry the same generic working habits', () => {
    for (const a of COLLAB_AGENTS) {
      expect(a.content, `${a.file}: full paths`).toMatch(/full path/);
      expect(a.content, `${a.file}: workspace notes`).toMatch(/a handoff, a wiki, a decisions folder/);
      expect(a.content, `${a.file}: evidence`).toMatch(/never call something done that you have not seen work/i);
      expect(a.content, `${a.file}: ask rather than guess`).toMatch(/Do not guess quietly/);
    }
  });

  // WORKSPACE-AGNOSTIC: this ships to strangers, so a seed must not name a file
  // that only exists in the repo it was written in.
  it('names no workspace file of its own', () => {
    for (const a of COLLAB_AGENTS) {
      expect(a.content, a.file).not.toMatch(/AGENTS\.md|HANDOFF\.md|CLAUDE\.md|\.origami\//);
    }
  });
});

describe('the frozen M1 seeds', () => {
  it('recognises an untouched prior-generation file, whatever its line endings', () => {
    // The reseed note in the pane hangs off this. A Windows user who merely
    // OPENED the file has a CRLF copy of the same bytes and must still be told.
    const v1 = COLLAB_AGENTS_V1.find((a) => a.file === 'collab-crane.md')!.content;
    expect(isLegacySeed('collab-crane', v1)).toBe(true);
    expect(isLegacySeed('collab-crane', v1.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('does NOT flag the current generation, or a file the user changed', () => {
    const current = COLLAB_AGENTS.find((a) => a.file === 'collab-crane.md')!.content;
    expect(isLegacySeed('collab-crane', current)).toBe(false);
    const v1 = COLLAB_AGENTS_V1.find((a) => a.file === 'collab-heron.md')!.content;
    expect(isLegacySeed('collab-heron', `${v1}\nMy own note.\n`)).toBe(false);
    // ...nor a DIFFERENT agent that happens to hold identical bytes.
    expect(isLegacySeed('collab-owl', v1)).toBe(false);
  });

  it('the M1 pair was read-only, which is what makes the note worth showing', () => {
    for (const a of COLLAB_AGENTS_V1) expect(a.content).toContain(OBSERVER_PERMISSION_BLOCK);
  });

  it('every shipped byte is ASCII — these land in a config dir read by shells with no fixed encoding', () => {
    for (const a of COLLAB_AGENTS) {
      const bad = [...a.content].filter((c) => c.charCodeAt(0) > 127);
      expect(bad, `${a.file} carries non-ASCII: ${bad.join('')}`).toEqual([]);
    }
  });
});

describe('the frozen V3 seeds (the pinned generation the v3 marker shipped)', () => {
  it('recognises an untouched v3 install, whatever its line endings', () => {
    // v4 unpinned the seeds; an install that has not been touched since v3
    // still has the PINNED pair on disk, and must still get the reseed note.
    const v3 = COLLAB_AGENTS_V3.find((a) => a.file === 'collab-crane.md')!.content;
    expect(isLegacySeed('collab-crane', v3)).toBe(true);
    expect(isLegacySeed('collab-crane', v3.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('does NOT flag the current (unpinned) generation, or a file the user changed', () => {
    const current = COLLAB_AGENTS.find((a) => a.file === 'collab-heron.md')!.content;
    expect(isLegacySeed('collab-heron', current)).toBe(false);
    const v3 = COLLAB_AGENTS_V3.find((a) => a.file === 'collab-heron.md')!.content;
    expect(isLegacySeed('collab-heron', `${v3}\nMy own note.\n`)).toBe(false);
  });

  it('the V3 pair was pinned — that pin is exactly what v4 stopped doing', () => {
    for (const a of COLLAB_AGENTS_V3) expect(a.content).toMatch(/^model: \S+/m);
  });

  it('V1 and V3 are still told apart — a V1 file is never read as V3 or vice versa', () => {
    const v1Crane = COLLAB_AGENTS_V1.find((a) => a.file === 'collab-crane.md')!.content;
    const v3Crane = COLLAB_AGENTS_V3.find((a) => a.file === 'collab-crane.md')!.content;
    expect(v1Crane).not.toBe(v3Crane);
    expect(isLegacySeed('collab-crane', v1Crane)).toBe(true);
    expect(isLegacySeed('collab-crane', v3Crane)).toBe(true);
  });
});

// W9 rewrote the LIVE payload, which by this file's own standing rule makes it a
// new generation: the shipped bytes that are now on thousands of disks have to
// be frozen, or every one of those installs silently reads as user-authored and
// stops being offered the reseed note. That is the whole job of the legacy
// family, and it is the half a text change is most likely to forget.
describe('the frozen V4 seeds (the last ROOM-worded generation)', () => {
  it('recognises an untouched v4 install, whatever its line endings', () => {
    const v4 = COLLAB_AGENTS_V4.find((a) => a.file === 'collab-crane.md')!.content;
    expect(isLegacySeed('collab-crane', v4)).toBe(true);
    expect(isLegacySeed('collab-crane', v4.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('does NOT flag the current generation', () => {
    for (const a of COLLAB_AGENTS) expect(isLegacySeed(a.file.replace(/\.md$/, ''), a.content)).toBe(false);
  });

  // What made v4 a prior generation rather than a tweak: it named the room.
  it('is the generation whose personas were about a room', () => {
    for (const a of COLLAB_AGENTS_V4) {
      expect(a.content, a.file).toMatch(/in this collab/);
      expect(a.content, a.file).toMatch(/## Collab discipline/);
    }
    // ...and the frozen bytes are NOT the live ones, or the freeze proves nothing.
    for (const a of COLLAB_AGENTS_V4) {
      expect(a.content).not.toBe(COLLAB_AGENTS.find((b) => b.file === a.file)!.content);
    }
  });
});
