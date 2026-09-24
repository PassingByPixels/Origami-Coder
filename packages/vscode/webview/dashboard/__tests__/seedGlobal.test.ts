// seedGlobal.ts unit tests — the once-per-version GLOBAL seed sweep.
//
// Every case drives the real `ensureGlobalSeeds` against a real temp directory
// through the `dir` option. The developer's own `~/.origami` is NEVER a target:
// realConfigGuard.ts does not cover that subtree (it guards ~/.config/origami
// and ~/.origami/repos.json), so `dir` is the whole defence here and no test
// below omits it.
//
// The claims that matter to a user, in order:
//   - a workspace that never ran /firstfold gets the default skills;
//   - a skill they wrote themselves is never overwritten;
//   - a pristine older copy IS upgraded when the shipped body changes;
//   - the sweep costs nothing on the boots where it has nothing to do;
//   - and it never, under any branch, writes into a workspace.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureGlobalSeeds,
  ensureSubagentToolDefaults,
  SUBAGENT_TOOLS_MARKER,
  globalSeedRoot,
  GLOBAL_SEEDS,
  PRIOR_GENERATIONS,
  type GlobalSeed,
} from '../../../src/dashboard/seedGlobal';
import { ARCHETYPES, ARCHETYPES_V2, ARCHETYPES_V4 } from '../../../src/dashboard/agentManager/archetypes';
import { DEFAULT_SKILLS } from '../../../src/dashboard/defaultSkills';
import { sampleSkillMd, wrapSkillMd } from '../../../src/dashboard/firstFold';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seedglobal-'));
  tmp.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmp) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* temp */
    }
  }
});

const V1 = '0.4.65';
const V2 = '0.4.66';

/** A marker whose stored version is observable, matching the globalState
 *  semantics of the real call site: get() reports it, set() records one. */
function fakeMarker(initial?: string) {
  const state = { version: initial, setCalls: 0 } as { version: string | undefined; setCalls: number };
  return {
    marker: {
      get: () => state.version,
      set: (v: string) => {
        state.version = v;
        state.setCalls += 1;
      },
    },
    state,
  };
}

const at = (dir: string, seed: GlobalSeed) => path.join(dir, ...seed.file.split('/'));
const seedFor = (name: string) => GLOBAL_SEEDS.find((s) => s.file === `skills/${name}/SKILL.md`)!;

/** Every file under `dir`, as `/`-joined paths relative to it. Used to assert
 *  the sweep's whole footprint, not just that the files it meant to write are
 *  present — the "never touches a workspace" claim is about what ELSE appeared. */
function tree(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...tree(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

describe('ensureGlobalSeeds — first run on a machine that never folded a workspace', () => {
  it('writes every seed, byte for byte, and records the version', () => {
    const dir = tmpDir();
    const { marker, state } = fakeMarker(undefined);
    ensureGlobalSeeds({ version: V1, marker, dir, log: () => {} });
    for (const seed of GLOBAL_SEEDS) {
      expect(fs.existsSync(at(dir, seed)), `${seed.file} was not written`).toBe(true);
      expect(fs.readFileSync(at(dir, seed), 'utf8')).toBe(seed.content);
    }
    expect(state.version).toBe(V1);
    expect(state.setCalls).toBe(1);
  });

  it('writes ONLY skill files under skills/ — no origami.json, no workspace folder', () => {
    // The sweep owns one subtree. Anything else appearing here would be a write
    // the caller never asked for, and origami.json in particular is /firstfold's
    // to own: a global config rewritten on every release bump would clobber the
    // user's provider setup.
    const dir = tmpDir();
    ensureGlobalSeeds({ version: V1, marker: fakeMarker().marker, dir, log: () => {} });
    const written = tree(dir);
    expect(written).toEqual(GLOBAL_SEEDS.map((s) => s.file).sort());
    for (const rel of written) expect(rel.startsWith('skills/')).toBe(true);
    expect(written).not.toContain('origami.json');
  });

  it('cannot place a seed outside the root, whatever a future entry is named', () => {
    // `file` is joined onto the root, so a name carrying `..` would write into
    // the user's home instead — and `tree()` above walks only INSIDE the root,
    // so such a file would be invisible to that assertion. Checked on the table
    // rather than on disk, which is where the mistake would be made.
    const root = path.resolve('/root');
    for (const seed of GLOBAL_SEEDS) {
      const resolved = path.resolve(root, ...seed.file.split('/'));
      expect(resolved.startsWith(path.join(root, 'skills') + path.sep), `${seed.file} escapes the seed root`).toBe(true);
    }
  });

  it('lands each skill where the engine globs for it — skills/<name>/SKILL.md', () => {
    // The engine scans `{skill,skills}/**/SKILL.md` under each config dir
    // (packages/engine/src/skill/index.ts:24,256-259) and keys the registry off
    // the frontmatter `name`, so the folder name and the declared name must agree
    // or the skill answers to a name nobody can find it under.
    for (const seed of GLOBAL_SEEDS) {
      const name = seed.file.slice('skills/'.length, -'/SKILL.md'.length);
      expect(/^---\r?\n[\s\S]*?^name:\s*(.+)$/m.exec(seed.content)?.[1]?.trim()).toBe(name);
    }
  });

  it('seeds the SAME library /firstfold does, each payload the identical value', () => {
    // Byte-identity is what makes the global copy and the workspace copy
    // interchangeable when the engine picks a duplicate-name winner at random
    // (skill/index.ts:165-180 under unbounded concurrency at :291-294). These are
    // reference comparisons against /firstfold's own sources, so a transcribed
    // copy — which could not stay identical, firstFold.ts being CRLF and
    // defaultSkills.ts LF — fails here rather than in a user's session.
    const names = GLOBAL_SEEDS.map((s) => s.file.slice('skills/'.length, -'/SKILL.md'.length));
    expect(names.sort()).toEqual(['wrap', 'example-skill', ...Object.keys(DEFAULT_SKILLS)].sort());
    expect(seedFor('wrap').content).toBe(wrapSkillMd());
    expect(seedFor('example-skill').content).toBe(sampleSkillMd());
    for (const [name, body] of Object.entries(DEFAULT_SKILLS)) {
      expect(seedFor(name).content, `${name} drifted from DEFAULT_SKILLS`).toBe(body);
    }
  });

  it('carries /wrap\'s HANDOFF marker into the global copy, so the skill still works', () => {
    // /wrap inserts its block directly below this marker. A global wrap that lost
    // it would be a skill that cannot do the one thing it is for — and unlike the
    // workspace copy, no /firstfold run would ever repair it.
    expect(seedFor('wrap').content).toContain('HANDOFF:NEW-BLOCKS-BELOW');
  });
});

describe('ensureGlobalSeeds — the marker', () => {
  it('with the version already recorded, does no fs work at all', () => {
    // Two independent proofs. (1) A fresh dir stays empty, so nothing was
    // created or written. (2) A `dir` whose parent is a regular FILE makes any
    // mkdir throw; a throw would be caught and logged, so an empty log proves
    // the loop was never entered.
    const dir = tmpDir();
    const { marker, state } = fakeMarker(V1);
    ensureGlobalSeeds({ version: V1, marker, dir, log: () => {} });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(state.setCalls).toBe(0); // no redundant re-set on a short-circuit

    const blocker = path.join(tmpDir(), 'afile');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const logged: string[] = [];
    ensureGlobalSeeds({
      version: V1,
      marker: fakeMarker(V1).marker,
      dir: path.join(blocker, 'impossible'),
      log: (m) => logged.push(m),
    });
    expect(logged).toEqual([]); // nothing was attempted, so nothing failed
    expect(fs.existsSync(path.join(blocker, 'impossible'))).toBe(false);
  });

  it('does not resurrect a skill the user deleted, until the version changes', () => {
    const dir = tmpDir();
    const f = fakeMarker(undefined);
    ensureGlobalSeeds({ version: V1, marker: f.marker, dir, log: () => {} });
    const victim = at(dir, seedFor('tdd'));
    fs.rmSync(victim);

    ensureGlobalSeeds({ version: V1, marker: f.marker, dir, log: () => {} }); // same build
    expect(fs.existsSync(victim)).toBe(false); // the marker guards it

    ensureGlobalSeeds({ version: V2, marker: f.marker, dir, log: () => {} }); // next release
    expect(fs.readFileSync(victim, 'utf8')).toBe(seedFor('tdd').content); // re-armed, once
    expect(f.state.version).toBe(V2);
  });

  it('a downgrade also re-arms — the marker is an equality check, not an ordering', () => {
    // Deliberate: an install that rolls back to an older build should reconcile
    // to THAT build's payloads rather than sit on a newer generation's files.
    const dir = tmpDir();
    const f = fakeMarker(V2);
    ensureGlobalSeeds({ version: V1, marker: f.marker, dir, log: () => {} });
    expect(fs.existsSync(at(dir, seedFor('tdd')))).toBe(true);
    expect(f.state.version).toBe(V1);
  });
});

describe('ensureGlobalSeeds — reconciling what is already on disk', () => {
  it('never overwrites a skill the user modified, and still seeds the rest around it', () => {
    // The guarantee /firstfold gives inside a workspace, held at the global root
    // too: a body the user changed is theirs, on this release and every later one.
    const dir = tmpDir();
    const mine = at(dir, seedFor('tdd'));
    const MINE = '---\nname: tdd\ncategory: testing\ndescription: My own version.\n---\n\n# mine\n';
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, MINE, 'utf8');

    ensureGlobalSeeds({ version: V1, marker: fakeMarker().marker, dir, log: () => {} });
    expect(fs.readFileSync(mine, 'utf8')).toBe(MINE);
    for (const seed of GLOBAL_SEEDS.filter((s) => s !== seedFor('tdd'))) {
      expect(fs.readFileSync(at(dir, seed), 'utf8')).toBe(seed.content);
    }

    // And it stays theirs across a version bump, which is the boot that re-arms
    // every other branch.
    ensureGlobalSeeds({ version: V2, marker: fakeMarker(V1).marker, dir, log: () => {} });
    expect(fs.readFileSync(mine, 'utf8')).toBe(MINE);
  });

  it('leaves a hand-written global wrap alone — the case that is REAL on this machine', () => {
    // Not hypothetical: the author of this change already has a
    // ~/.origami/skills/wrap/SKILL.md dated 2026-07-10, written by hand, that is
    // a DIFFERENT skill from /firstfold's — same name, its own description and
    // body. The fixture below mirrors that file's shape (frontmatter derived from
    // the real one; the body is not reproduced). `wrap` is the single most likely
    // collision in the library, because it is the one people write for themselves,
    // and this branch is the only thing standing between the sweep and someone's
    // own session-close skill.
    const dir = tmpDir();
    const THEIRS = [
      '---',
      'name: wrap',
      'description: Distil the current session into a durable handoff before context is lost.',
      '---',
      '',
      '# Wrap',
      '',
      'Produce a tight, durable handoff of this session.',
      '',
    ].join('\n');
    const theirWrap = at(dir, seedFor('wrap'));
    fs.mkdirSync(path.dirname(theirWrap), { recursive: true });
    fs.writeFileSync(theirWrap, THEIRS, 'utf8');

    const f = fakeMarker(undefined);
    ensureGlobalSeeds({ version: V1, marker: f.marker, dir, log: () => {} });
    expect(fs.readFileSync(theirWrap, 'utf8')).toBe(THEIRS); // theirs, untouched
    for (const seed of GLOBAL_SEEDS.filter((s) => s !== seedFor('wrap'))) {
      expect(fs.readFileSync(at(dir, seed), 'utf8')).toBe(seed.content); // every other seed lands
    }

    // And every future release leaves it alone too — the branch must not decay
    // into "user edits win once".
    ensureGlobalSeeds({ version: V2, marker: f.marker, dir, log: () => {} });
    expect(fs.readFileSync(theirWrap, 'utf8')).toBe(THEIRS);
  });

  it('leaves a byte-identical current file alone rather than rewriting it', () => {
    const dir = tmpDir();
    ensureGlobalSeeds({ version: V1, marker: fakeMarker().marker, dir, log: () => {} });
    const target = at(dir, seedFor('triage'));
    const before = fs.statSync(target).mtimeMs;
    fs.utimesSync(target, new Date(0), new Date(0)); // an mtime nothing else would produce
    ensureGlobalSeeds({ version: V2, marker: fakeMarker(V1).marker, dir, log: () => {} });
    expect(fs.readFileSync(target, 'utf8')).toBe(seedFor('triage').content);
    expect(fs.statSync(target).mtimeMs).toBe(0); // untouched: a rewrite would restamp it
    expect(before).toBeGreaterThan(0);
  });

  it('upgrades a file byte-identical to a PRIOR shipped generation', () => {
    // The branch every future release depends on: release N+1 moves N's payloads
    // into PRIOR_GENERATIONS, and a user still carrying N's pristine body must be
    // moved forward — while an edited one beside it is not. Nothing has shipped
    // yet, so the generation is injected; the code path is the production one.
    const dir = tmpDir();
    const oldTdd: GlobalSeed = { file: seedFor('tdd').file, content: '---\nname: tdd\n---\n\nthe v0 body\n' };
    const oldTriage: GlobalSeed = { file: seedFor('triage').file, content: '---\nname: triage\n---\n\nthe v0 body\n' };
    for (const s of [oldTdd, oldTriage]) {
      fs.mkdirSync(path.dirname(at(dir, s)), { recursive: true });
      fs.writeFileSync(at(dir, s), s.content, 'utf8');
    }
    const EDITED = '---\nname: triage\n---\n\nmy own triage\n';
    fs.writeFileSync(at(dir, oldTriage), EDITED, 'utf8'); // this one the user then changed

    ensureGlobalSeeds({
      version: V2,
      marker: fakeMarker(V1).marker,
      dir,
      priors: [[oldTdd, oldTriage]],
      log: () => {},
    });

    expect(fs.readFileSync(at(dir, oldTdd), 'utf8')).toBe(seedFor('tdd').content); // pristine -> upgraded
    expect(fs.readFileSync(at(dir, oldTriage), 'utf8')).toBe(EDITED); // edited -> untouched
  });

  it('ships an EMPTY prior table at v1, so nothing on disk can be mistaken for ours', () => {
    // A non-empty table at the first release would mean claiming a body we never
    // shipped is pristine, and overwriting a user's file on that claim.
    expect(PRIOR_GENERATIONS).toEqual([]);
  });
});

describe('ensureGlobalSeeds — failure is never fatal', () => {
  it('logs a failed pass, throws nothing, and leaves the marker unset so it retries', () => {
    const { marker, state } = fakeMarker(undefined);
    const logged: string[] = [];
    const blocker = path.join(tmpDir(), 'afile');
    fs.writeFileSync(blocker, 'x', 'utf8'); // a regular file where a directory must go
    expect(() =>
      ensureGlobalSeeds({ version: V1, marker, dir: blocker, log: (m) => logged.push(m) }),
    ).not.toThrow();
    expect(logged.length).toBe(1);
    expect(state.version).toBeUndefined(); // retryable on the next boot
    expect(state.setCalls).toBe(0);
  });

  it('a pass that dies partway leaves the files it did write, but records no version', () => {
    // Half a library plus a recorded version would be permanent: the marker
    // would suppress the retry that completes it.
    const dir = tmpDir();
    const first = GLOBAL_SEEDS[0];
    const second = GLOBAL_SEEDS[1];
    // Occupy the SECOND seed's directory slot with a regular file, so its
    // mkdirSync throws after the first seed has already been written.
    fs.mkdirSync(path.dirname(path.dirname(at(dir, second))), { recursive: true });
    fs.writeFileSync(path.dirname(at(dir, second)), 'x', 'utf8');

    const { marker, state } = fakeMarker(undefined);
    const logged: string[] = [];
    ensureGlobalSeeds({ version: V1, marker, dir, log: (m) => logged.push(m) });

    expect(fs.readFileSync(at(dir, first), 'utf8')).toBe(first.content); // got that far
    expect(logged.length).toBe(1);
    expect(state.version).toBeUndefined(); // and will run again
  });
});

describe('globalSeedRoot mirrors the engine home resolution', () => {
  it('honours ORIGAMI_TEST_HOME, then ORIGAMI_REPOS_HOME, then the real home', () => {
    // ORIGAMI_TEST_HOME is what the engine itself honours (core/src/global.ts:18-26),
    // so the sweep writes where the engine reads under it. ORIGAMI_REPOS_HOME is
    // the fallback the vitest setup already points at a temp dir.
    const saved = { t: process.env.ORIGAMI_TEST_HOME, r: process.env.ORIGAMI_REPOS_HOME };
    try {
      process.env.ORIGAMI_TEST_HOME = path.join('/engine', 'home');
      process.env.ORIGAMI_REPOS_HOME = path.join('/repos', 'home');
      expect(globalSeedRoot()).toBe(path.join('/engine', 'home', '.origami'));
      delete process.env.ORIGAMI_TEST_HOME;
      expect(globalSeedRoot()).toBe(path.join('/repos', 'home', '.origami'));
      delete process.env.ORIGAMI_REPOS_HOME;
      expect(globalSeedRoot()).toBe(path.join(os.homedir(), '.origami'));
    } finally {
      if (saved.t === undefined) delete process.env.ORIGAMI_TEST_HOME;
      else process.env.ORIGAMI_TEST_HOME = saved.t;
      if (saved.r === undefined) delete process.env.ORIGAMI_REPOS_HOME;
      else process.env.ORIGAMI_REPOS_HOME = saved.r;
    }
  });

  it('never resolves inside a workspace — it is always <home>/.origami', () => {
    expect(path.basename(globalSeedRoot())).toBe('.origami');
    expect(globalSeedRoot()).not.toContain(path.join('.origami', '.origami'));
  });
});

// ---------------------------------------------------------------------------
// t-f3a74m — the subagent-tools-v1 sweep: put the default tool matrix onto the
// archetype DEFINITIONS of an install that already has them, exactly once.
//
// Every case drives the real `ensureSubagentToolDefaults` against a real temp
// directory through `dir`. The developer's own ~/.config/origami/agent is never
// a target: realConfigGuard.ts guards the config FILE, not this subtree, so
// `dir` is the whole defence and no case below omits it.
// ---------------------------------------------------------------------------

describe('ensureSubagentToolDefaults', () => {
  const at = (dir: string, file: string) => path.join(dir, file);
  const cur = (file: string) => ARCHETYPES.find((a) => a.file === file)!.content;

  it('rewrites a PRISTINE install to the matrix and records the marker once', () => {
    const dir = tmpDir();
    for (const a of ARCHETYPES_V4) fs.writeFileSync(at(dir, a.file), a.content, 'utf8');
    const f = fakeMarker(undefined);

    ensureSubagentToolDefaults({ marker: f.marker, dir, log: () => {} });

    for (const a of ARCHETYPES) expect(fs.readFileSync(at(dir, a.file), 'utf8')).toBe(a.content);
    expect(f.state.version).toBe(SUBAGENT_TOOLS_MARKER);
    expect(f.state.setCalls).toBe(1);

    // ...and the second boot is free: nothing is read, nothing is written.
    fs.writeFileSync(at(dir, 'ask.md'), 'EDITED AFTER THE SWEEP', 'utf8');
    ensureSubagentToolDefaults({ marker: f.marker, dir, log: () => {} });
    expect(fs.readFileSync(at(dir, 'ask.md'), 'utf8')).toBe('EDITED AFTER THE SWEEP');
    expect(f.state.setCalls).toBe(1);
  });

  it('leaves a USER-EDITED archetype exactly as it is, while reconciling its pristine siblings', () => {
    // The claim that matters to a user: a definition they customised is theirs,
    // and a default matrix is not a reason to overwrite it.
    const dir = tmpDir();
    for (const a of ARCHETYPES_V4) fs.writeFileSync(at(dir, a.file), a.content, 'utf8');
    const mine = '---\ndescription: "mine"\nmode: all\n---\n\nMy own architect.\n';
    fs.writeFileSync(at(dir, 'architect.md'), mine, 'utf8');

    ensureSubagentToolDefaults({ marker: fakeMarker(undefined).marker, dir, log: () => {} });

    expect(fs.readFileSync(at(dir, 'architect.md'), 'utf8')).toBe(mine);
    for (const a of ARCHETYPES.filter((x) => x.file !== 'architect.md')) {
      expect(fs.readFileSync(at(dir, a.file), 'utf8')).toBe(a.content);
    }
  });

  it('upgrades an OLDER pristine generation too, and writes a file the install never had', () => {
    const dir = tmpDir();
    for (const a of ARCHETYPES_V2) fs.writeFileSync(at(dir, a.file), a.content, 'utf8'); // v2: no scout, no cartographer
    expect(fs.existsSync(at(dir, 'cartographer.md'))).toBe(false);

    ensureSubagentToolDefaults({ marker: fakeMarker(undefined).marker, dir, log: () => {} });

    expect(fs.readFileSync(at(dir, 'debug.md'), 'utf8')).toBe(cur('debug.md'));
    expect(fs.readFileSync(at(dir, 'cartographer.md'), 'utf8')).toBe(cur('cartographer.md'));
  });

  it('writes nothing outside the agent dir — no origami.json, no config of any kind', () => {
    // The sweep's hard boundary. The matrix belongs in the DEFINITIONS; a copy of
    // it in origami.json would be an override the user never made, and the
    // ledger's "Reset to defaults" could then never get back to it.
    const root = tmpDir();
    const dir = path.join(root, 'agent');
    fs.mkdirSync(dir);
    for (const a of ARCHETYPES_V4) fs.writeFileSync(at(dir, a.file), a.content, 'utf8');

    ensureSubagentToolDefaults({ marker: fakeMarker(undefined).marker, dir, log: () => {} });

    expect(tree(root).sort()).toEqual(ARCHETYPES.map((a) => `agent/${a.file}`).sort());
  });

  it('is non-fatal: a failure is logged, and the marker is left unset so it retries', () => {
    const clash = path.join(tmpDir(), 'afile');
    fs.writeFileSync(clash, 'x', 'utf8');
    const f = fakeMarker(undefined);
    const logged: string[] = [];

    expect(() =>
      ensureSubagentToolDefaults({ marker: f.marker, dir: path.join(clash, 'agent'), log: (m) => logged.push(m) }),
    ).not.toThrow();

    expect(logged).toHaveLength(1);
    expect(f.state.version).toBeUndefined();
  });

  it('is keyed by a NAME, not the release version — a marker from the skill sweep does not count', () => {
    // The two sweeps share the marker SHAPE and nothing else. A globalState slot
    // carrying "0.4.138" must not read as "the matrix pass already ran".
    const dir = tmpDir();
    for (const a of ARCHETYPES_V4) fs.writeFileSync(at(dir, a.file), a.content, 'utf8');
    const f = fakeMarker('0.4.138');

    ensureSubagentToolDefaults({ marker: f.marker, dir, log: () => {} });

    expect(fs.readFileSync(at(dir, 'ask.md'), 'utf8')).toBe(cur('ask.md'));
    expect(f.state.version).toBe(SUBAGENT_TOOLS_MARKER);
  });
});
