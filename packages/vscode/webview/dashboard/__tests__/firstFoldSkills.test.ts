// /firstfold seeds the DEFAULT SKILL LIBRARY into a fresh workspace.
//
// This drives the real `runFirstFold` against a real temp directory rather than
// asserting over the exported string map: the map being right is not the claim —
// the claim is that twelve SKILL.md files land where the engine's discovery glob
// (`{skill,skills}/**/SKILL.md` under `.origami/`, see packages/engine/src/skill)
// will find them, each carrying the frontmatter that decides how it is grouped and
// whether it appears in the / palette.
//
// The second run is the one that protects the user: seeding is write-if-absent, so
// an edited skill must survive /firstfold being run again in a folded workspace.

import { describe, expect, it, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as realOs from 'node:os';

// A throwaway HOME so the model step reads (and can never write) a config that
// isn't the developer's own. Hoisted — vi.mock factories run before the graph.
const { HOME } = vi.hoisted(() => {
  const base = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || '/tmp';
  return { HOME: `${base}/origami-firstfold-${process.pid}-${Date.now()}` };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => HOME }, homedir: () => HOME };
});

import { runFirstFold } from '../../../src/dashboard/firstFold';
import { DEFAULT_SKILLS } from '../../../src/dashboard/defaultSkills';

/**
 * The contract, written out rather than derived from the module under test — a
 * table computed from DEFAULT_SKILLS would agree with any typo it contains.
 * `slash: true` marks the skills a USER invokes; the model-invoked ones are
 * deliberately absent from the / palette.
 */
const EXPECTED: Record<string, { category: string; slash: boolean }> = {
  wrap: { category: 'workflow', slash: true },
  'example-skill': { category: 'reference', slash: false },
  'grill-me': { category: 'workflow', slash: true },
  'to-spec': { category: 'planning', slash: true },
  'to-tickets': { category: 'planning', slash: true },
  triage: { category: 'workflow', slash: true },
  tdd: { category: 'testing', slash: false },
  'diagnosing-bugs': { category: 'testing', slash: false },
  'code-review': { category: 'quality', slash: false },
  wayfinder: { category: 'planning', slash: false },
  handoff: { category: 'workflow', slash: true },
  'optimize-code': { category: 'quality', slash: true },
};

/** The frontmatter block only — never the body, which legitimately talks ABOUT
 *  `slash: true` in prose and would otherwise read as declaring it. */
function frontmatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  return m ? m[1] : '';
}

function field(md: string, key: string): string | undefined {
  const line = frontmatter(md)
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const skillPath = (cwd: string, name: string) => path.join(cwd, '.origami', 'skills', name, 'SKILL.md');

/** Every seeded SKILL.md, keyed by directory name — read straight off disk. */
function seededOnDisk(cwd: string): Record<string, string> {
  const root = path.join(cwd, '.origami', 'skills');
  if (!fs.existsSync(root)) return {};
  const out: Record<string, string> = {};
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, 'SKILL.md');
    if (fs.existsSync(file)) out[dir] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

function runOnce(cwd: string) {
  const narration: string[] = [];
  return runFirstFold(
    cwd,
    {
      start: () => {},
      todos: () => {},
      narrate: (line) => narration.push(line),
      done: () => {},
    },
    {
      mode: 'full',
      // Cancelling the picker keeps the run entirely on the scaffolding path —
      // no provider is written anywhere.
      connectModel: async () => null,
      confirmReconfigure: async () => false,
    },
  ).then(() => narration);
}

let cwd = '';
let afterFirst: Record<string, string> = {};
let firstNarration: string[] = [];
let secondNarration: string[] = [];
const EDITED = '---\nname: tdd\ncategory: testing\ndescription: My own version.\n---\n\n# mine\n';

beforeAll(async () => {
  cwd = fs.mkdtempSync(path.join(realOs.tmpdir(), 'origami-firstfold-'));
  firstNarration = await runOnce(cwd);
  afterFirst = seededOnDisk(cwd);

  // The user makes one skill their own, then folds the workspace again.
  fs.writeFileSync(skillPath(cwd, 'tdd'), EDITED, 'utf8');
  secondNarration = await runOnce(cwd);
}, 120_000);

describe('/firstfold seeds the default skill library', () => {
  it('writes exactly the twelve expected skills, and nothing else', () => {
    expect(Object.keys(afterFirst).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('gives every skill the category it is grouped under', () => {
    const categories = Object.fromEntries(Object.entries(afterFirst).map(([n, md]) => [n, field(md, 'category')]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([n, e]) => [n, e.category]));
    expect(categories).toEqual(expected);
  });

  it('puts slash: true on the user-invoked skills only', () => {
    const withSlash = Object.entries(afterFirst)
      .filter(([, md]) => field(md, 'slash') === 'true')
      .map(([n]) => n)
      .sort();
    // Model-invoked skills (tdd, diagnosing-bugs, code-review, wayfinder) must NOT
    // be here — a / entry for them advertises a command that does nothing a user
    // needs to type.
    expect(withSlash).toEqual(['grill-me', 'handoff', 'optimize-code', 'to-spec', 'to-tickets', 'triage', 'wrap']);
  });

  it('names each skill after the folder it sits in, so the engine registry and the path agree', () => {
    for (const [dir, md] of Object.entries(afterFirst)) {
      expect(field(md, 'name'), `${dir}/SKILL.md declares a different name`).toBe(dir);
    }
  });

  it('keeps every frontmatter value free of a bare colon, which YAML would reject', () => {
    // A `description: fix: the thing` line makes the whole block unparseable and
    // the engine drops the skill with only a warning — the exact silent
    // disappearance `Skill.problems` exists to explain.
    for (const [dir, md] of Object.entries(afterFirst)) {
      for (const line of frontmatter(md).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const value = line.slice(line.indexOf(':') + 1);
        expect(value.includes(': '), `${dir}/SKILL.md frontmatter line is not a plain scalar: ${line}`).toBe(false);
      }
    }
  });

  it('gives each skill a description, so it can be advertised without opening the file', () => {
    for (const [dir, md] of Object.entries(afterFirst)) {
      expect(field(md, 'description') ?? '', `${dir}/SKILL.md has no description`).not.toBe('');
    }
  });

  it('reports how many skills it created rather than naming a single sample one', () => {
    expect(firstNarration.some((l) => l.includes('12 skills'))).toBe(true);
  });

  it('keeps the /wrap HANDOFF marker and its four block anchors intact', () => {
    // Load-bearing and signed off: /wrap inserts below this marker, and the
    // HANDOFF stub written by the same run carries the matching line.
    const wrap = afterFirst.wrap!;
    expect(wrap).toContain('HANDOFF:NEW-BLOCKS-BELOW');
    for (const anchor of ['## <YYYY-MM-DD> · <topic>', 'done:', 'next:', 'wiki: [[<page-name>]]']) {
      expect(wrap, `the /wrap block anchor "${anchor}" is gone`).toContain(anchor);
    }
    expect(fs.readFileSync(path.join(cwd, 'HANDOFF.md'), 'utf8')).toContain('HANDOFF:NEW-BLOCKS-BELOW');
  });

  it('tells /wrap to distil a skill lesson into the wiki under a skills tag', () => {
    const wrap = afterFirst.wrap!;
    expect(wrap).toContain('skills');
    expect(wrap.toLowerCase()).toContain('gotcha');
  });

  it('frames the wiki as the agent\'s persistent memory, not an end-of-session filing chore', () => {
    // The whole point of the reframe: a future session knows ONLY what the
    // wiki holds, so under-recording is memory loss, not economy.
    const wrap = afterFirst.wrap!;
    expect(wrap.toLowerCase()).toContain('memory');
    expect(wrap.toLowerCase()).toContain('future session');
  });

  it('nudges the wiki page to use diagrams, images, and structured markdown, not just prose', () => {
    const wrap = afterFirst.wrap!;
    expect(wrap).toContain('mermaid');
    expect(wrap).toContain('![');
    expect(wrap).toContain('<details>');
    // A nudge, not a mandate — plain prose must stay a legitimate choice.
    expect(wrap.toLowerCase()).toContain('nudge');
  });
});

describe('/firstfold run again in a folded workspace', () => {
  it('leaves a skill the user edited exactly as they left it', () => {
    // The whole point of write-if-absent: re-folding must not restore our text
    // over theirs.
    expect(fs.readFileSync(skillPath(cwd, 'tdd'), 'utf8')).toBe(EDITED);
  });

  it('rewrites none of the other skills', () => {
    const afterSecond = seededOnDisk(cwd);
    for (const [name, body] of Object.entries(afterFirst)) {
      if (name === 'tdd') continue;
      expect(afterSecond[name], `${name}/SKILL.md was rewritten on the second run`).toBe(body);
    }
  });

  it('says everything was already present instead of claiming new work', () => {
    expect(secondNarration.some((l) => l.includes('already present'))).toBe(true);
    expect(secondNarration.some((l) => l.includes('skills'))).toBe(true);
  });
});

describe('the default skill library module', () => {
  it('holds the ten skills firstFold does not own itself', () => {
    // wrap + example-skill stay in firstFold.ts beside the HANDOFF stub; the
    // count guards against a body being added to the map but never seeded.
    expect(Object.keys(DEFAULT_SKILLS)).toHaveLength(10);
    expect(Object.keys(DEFAULT_SKILLS)).not.toContain('wrap');
    expect(Object.keys(DEFAULT_SKILLS)).not.toContain('example-skill');
  });

  it('points every tracker reference at the local markdown layout', () => {
    // No external issue tracker is assumed to exist in a fresh workspace.
    const tracker = ['to-spec', 'to-tickets', 'triage', 'wayfinder'];
    for (const name of tracker) {
      expect(DEFAULT_SKILLS[name], `${name} does not name the .scratch tracker`).toContain('.scratch/');
    }
    expect(DEFAULT_SKILLS['to-tickets']).toContain('Blocked by:');
    expect(DEFAULT_SKILLS['to-tickets']).toContain('Status:');
  });

  it('sends durable knowledge to the wiki, not to a CONTEXT.md', () => {
    const all = Object.values(DEFAULT_SKILLS).join('\n');
    expect(all).toContain('wiki/pages/');
    expect(all).not.toContain('CONTEXT.md');
  });

  it('cross-references the session-close skill as /wrap', () => {
    // The handoff skill is the guide; /wrap is the command that does the work.
    expect(DEFAULT_SKILLS['handoff']).toContain('/wrap');
  });

  // optimize-code's BODY is the deliverable — it is a staged pipeline, and the
  // stages are what make it safe to point at a whole repository. A trimmed copy
  // that lost Stage 0 would refactor from an unknown baseline; one that lost
  // Stage 4 would report numbers it never re-ran the gates behind.
  it('walks optimize-code through all six stages, in order', () => {
    const body = DEFAULT_SKILLS['optimize-code']!;
    let at = -1;
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const i = body.indexOf(`## Stage ${n} `);
      expect(i, `optimize-code is missing Stage ${n}, or it is out of order`).toBeGreaterThan(at);
      at = i;
    }
  });

  it('keeps optimize-code honest about the metric and about what it verified', () => {
    const body = DEFAULT_SKILLS['optimize-code']!;
    // Without the anti-gaming rule the skill degrades into "make the number go
    // down", which is the exact failure the upstream skill exists to prevent —
    // and the verification wording is this workspace's own standing rule.
    expect(body).toContain('Never game the metric');
    expect(body).toContain('verified by running');
    expect(body).toContain('untested — would confirm by');
  });

  it('credits the Apache-2.0 skill optimize-code is adapted from', () => {
    // A licence obligation, not decoration.
    const body = DEFAULT_SKILLS['optimize-code']!;
    expect(body).toContain('saurabhkumar8112/cyclomatic-complexity-skill');
    expect(body).toContain('Apache-2.0');
  });

  it('lets the project\'s own complexity threshold win over the skill\'s defaults', () => {
    // Seeding a skill that overrules a repo's configured eslint/radon/sonar limit
    // would make it fight the project it was pointed at.
    expect(DEFAULT_SKILLS['optimize-code']).toContain("project's own threshold wins");
  });
});

// A workspace that ALREADY has a skill by one of our default names. The engine
// keys its registry off the frontmatter `name` (packages/engine/src/skill), so
// two files both claiming `optimize-code` would be a duplicate — and there the
// last one loaded wins, under unbounded concurrency, which is to say nobody wins
// predictably. writeIfAbsent settles it one layer earlier by never creating the
// second file: the user's copy is the only one, on the FIRST fold as well as a
// re-fold. The tdd case above proves the re-fold half; this proves the half a
// brand-new default skill actually lands in.
describe('/firstfold in a workspace that already has its own optimize-code', () => {
  const MINE = '---\nname: optimize-code\ncategory: quality\ndescription: My own optimiser.\n---\n\n# mine\n';
  let ownCwd = '';

  beforeAll(async () => {
    ownCwd = fs.mkdtempSync(path.join(realOs.tmpdir(), 'origami-firstfold-own-'));
    fs.mkdirSync(path.dirname(skillPath(ownCwd, 'optimize-code')), { recursive: true });
    fs.writeFileSync(skillPath(ownCwd, 'optimize-code'), MINE, 'utf8');
    await runOnce(ownCwd);
  }, 120_000);

  it('leaves their optimize-code exactly as they wrote it', () => {
    expect(fs.readFileSync(skillPath(ownCwd, 'optimize-code'), 'utf8')).toBe(MINE);
  });

  it('still seeds every other default skill around it', () => {
    const seeded = seededOnDisk(ownCwd);
    expect(Object.keys(seeded).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(seeded['tdd']).toBe(DEFAULT_SKILLS['tdd']);
  });
});
