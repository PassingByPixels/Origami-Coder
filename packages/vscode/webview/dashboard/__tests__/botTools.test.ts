// WHICH TOOLS A BOT HAS, as the def file states it (W6 owner ruling).
//
// The three failure classes these exist for:
//
//  1. A CHECKBOX THAT DECIDES NOTHING. The engine gates `edit`, `write` and
//     `apply_patch` on ONE permission key, so a per-tool-id checkbox would offer
//     two ticks that change nothing. The gate model has to collapse them, and a
//     test is the only place that can fail when it stops doing so.
//  2. A ROUND TRIP THAT LOSES A TICK. Ticks are the file's permission block and
//     nothing else, so tick -> save -> reload -> same ticks is the whole
//     contract. A key this build does not know must survive it too: dropping a
//     line the user wrote is the silent rewrite the def writer already refuses.
//  3. DRIFT FROM THE ENGINE. The tool universe is MIRRORED (packages/engine is
//     not resolvable from this package), and a mirror with no guard is a lie
//     waiting to happen: a tool added engine-side and not here is a capability
//     the checklist silently cannot grant or withhold.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARD_REQUIRED_TOOLS,
  OBSERVER_TOOLS,
  TOOL_GATES,
  TOOL_IDS,
  WORKER_TOOLS,
  allToolKeys,
  gateOf,
  gatesFor,
  presetOfTools,
  toolBlockFor,
  toolsFromBlock,
} from '../../../src/dashboard/botTools';

describe('gates — one checkbox per decision the engine can actually read', () => {
  // Permission.disabled maps all three onto `edit`. Three checkboxes would be
  // two lies: unticking `write` alone changes nothing at all.
  it('collapses edit, write and apply_patch onto the single `edit` key', () => {
    expect(gateOf('edit')).toBe('edit');
    expect(gateOf('write')).toBe('edit');
    expect(gateOf('apply_patch')).toBe('edit');
    const gate = gatesFor(['edit', 'write', 'apply_patch']);
    expect(gate).toEqual([{ key: 'edit', tools: ['apply_patch', 'edit', 'write'] }]);
  });

  it('gives every other tool its own key, so a tick is that tool', () => {
    expect(gatesFor(['bash', 'read'])).toEqual([
      { key: 'bash', tools: ['bash'] },
      { key: 'read', tools: ['read'] },
    ]);
  });

  // A user-file or plugin tool the engine reported is tickable at once — the
  // catalog is a fallback, never a whitelist the live list has to pass.
  it('gives a tool this build has never heard of its own gate', () => {
    expect(gatesFor(['acme_deploy']).map((g) => g.key)).toEqual(['acme_deploy']);
  });

  // A checkbox that cannot be unticked is not a decision. `invalid` is where the
  // engine redirects a malformed tool call, so denying it breaks repair.
  it('never offers a hard-required tool as a tick', () => {
    expect(gatesFor(['invalid', 'read']).map((g) => g.key)).toEqual(['read']);
    expect(TOOL_GATES.some((g) => g.key === 'invalid')).toBe(false);
  });
});

// --- what a NEW bot is born with (W9) ------------------------------------
// The owner's ruling replaced the two pre-tick buttons with one starting state:
// EVERYTHING on, and the user unticks. Two things can go silently wrong with
// that, and only these can fail on either.
describe('allToolKeys — a new bot starts able, and starts able at TODAY’s engine', () => {
  it('ticks every gate the shipped mirror knows, and never the untickable one', () => {
    expect(allToolKeys().sort()).toEqual(TOOL_GATES.map((g) => g.key).sort());
    // `invalid` is where the engine redirects a malformed call; a bot born with
    // it "ticked" would carry a line no checkbox could ever take back.
    for (const id of HARD_REQUIRED_TOOLS) expect(allToolKeys()).not.toContain(id);
    // One key for edit/write/apply_patch, so "all ticked" is all DECISIONS, not
    // all tool ids — three of them collapse to one.
    expect(allToolKeys()).toContain('edit');
    expect(allToolKeys()).not.toContain('write');
  });

  // THE GROWTH CASE. The mirror is a fallback, so a bot born from it while the
  // running engine offers a newer tool would open with a row already unticked —
  // the form contradicting the "all ticked" it just claimed.
  it('ticks a tool the engine reported that this build has never heard of', () => {
    const live = [...TOOL_IDS, 'acme_deploy'];
    expect(allToolKeys(live)).toContain('acme_deploy');
    expect(allToolKeys(live).sort()).toEqual([...allToolKeys(), 'acme_deploy'].sort());
  });

  // An empty catalog is "no chat open to ask", NOT "an engine with no tools".
  // Ticking nothing there would born every bot mute whenever the board opened
  // before a session did.
  it('falls back to the mirror when there is no engine to ask', () => {
    expect(allToolKeys([])).toEqual(allToolKeys());
    expect(allToolKeys(undefined).length).toBeGreaterThan(0);
  });
});

describe('the preset NAMES survive as a reading of a tick set', () => {
  // The BUTTONS went (W9); the sets did not, because the card's chip still has
  // to say "worker" rather than "5 tools" and the serializer picks its `steps:`
  // budget off that name. What is gone is any way to STAMP one from the editor.
  it('still describes the two shipped sets', () => {
    expect(OBSERVER_TOOLS).not.toContain('bash');
    expect(OBSERVER_TOOLS).not.toContain('edit');
    expect(WORKER_TOOLS).toEqual(expect.arrayContaining([...OBSERVER_TOOLS, 'bash', 'edit']));
  });

  it('names a set back as the preset it is, in any order', () => {
    expect(presetOfTools([...WORKER_TOOLS].reverse())).toBe('worker');
    expect(presetOfTools(OBSERVER_TOOLS)).toBe('observer');
  });

  // The point of the ruling: the user may adjust the ticks, and an adjusted set
  // must not keep claiming to be the preset it started from.
  it('a manual change stops being the preset', () => {
    expect(presetOfTools([...WORKER_TOOLS, 'browser'])).toBe('custom');
    expect(presetOfTools(WORKER_TOOLS.filter((t) => t !== 'bash'))).toBe('custom');
  });

  // Every shipped bot's block carries `list: allow`, a key no tool in this
  // engine consults. Letting it vote would make every seeded def read as
  // hand-edited the first time the card drew it.
  it('ignores a key this build knows no tool for when naming the set', () => {
    expect(presetOfTools([...WORKER_TOOLS, 'list'])).toBe('worker');
  });

  // The all-ticked bot W9 makes by default is NOT one of the two named sets, and
  // it must not be reported as one: `stepsFor` would then quietly hand it an
  // observer's budget the moment the sets happened to line up.
  it('does not mistake the all-ticked default for a shipped preset', () => {
    expect(presetOfTools(allToolKeys())).toBe('custom');
  });
});

describe('the block — ticks in, ticks out', () => {
  it('writes allow for a tick and deny for everything else, under a deny-all base', () => {
    const block = toolBlockFor(['read', 'grep']);
    expect(block.split('\n')[0]).toBe('permission:');
    // `"*": deny` FIRST: it is what closes a tool this build has never heard of.
    expect(block.split('\n')[1]).toBe('  "*": deny');
    expect(block).toContain('  read: allow');
    expect(block).toContain('  grep: allow');
    expect(block).toContain('  bash: deny');
    expect(block).toContain('  edit: deny');
  });

  it('round-trips a tick set through the file and back unchanged', () => {
    for (const ticks of [WORKER_TOOLS, OBSERVER_TOOLS, [], ['browser', 'read', 'websearch']]) {
      expect(toolsFromBlock(toolBlockFor(ticks))).toEqual([...ticks].sort());
    }
  });

  // The silent rewrite the def writer already refuses everywhere else: a line
  // the user wrote by hand is theirs, even when this build knows no such tool.
  it('keeps a ticked key this build does not know, rather than dropping it', () => {
    expect(toolsFromBlock(toolBlockFor(['read', 'list']))).toEqual(['list', 'read']);
  });

  // Absence is a real, different answer from an empty tick set: no block means
  // the def never said anything and the engine's defaults stand.
  it('reads NO block as undefined, and an all-denied block as the empty set', () => {
    expect(toolsFromBlock('')).toBeUndefined();
    expect(toolsFromBlock('steps: 40')).toBeUndefined();
    expect(toolsFromBlock(toolBlockFor([]))).toEqual([]);
  });

  // The shipped worker block, as every existing def on disk carries it.
  it('reads a hand-written block in the shipped format', () => {
    const shipped = ['permission:', '  "*": deny', '  read: allow', '  edit: allow', '  bash: deny'].join('\n');
    expect(toolsFromBlock(shipped)).toEqual(['edit', 'read']);
  });
});

// --- the mirror's drift guard ---------------------------------------------
// A tool added engine-side and not here is a capability this checklist can
// neither grant nor withhold, and nothing else in the build would say so.
//
// W9 SHARPENED WHAT THE GUARD IS FOR. While Worker/Observer pre-ticked a fixed
// five, a stale mirror only cost the user a row they could have ticked. Now the
// mirror IS the starting set whenever no chat is open to ask the engine
// (`allToolKeys()`), so a tool missing here is a tool every offline-born bot is
// silently DENIED — `toolBlockFor` writes `"*": deny` and never names it, so the
// def reads as a deliberate decision nobody made.
const toolDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engine', 'src', 'tool',
);
const engineFile = (name: string) => readFileSync(path.join(toolDir, name), 'utf8');

describe('the mirrored tool universe still agrees with the engine registry', () => {
  it('lists every tool the engine defines with a literal id', () => {
    const found = new Set<string>();
    for (const name of readdirSync(toolDir)) {
      if (!name.endsWith('.ts')) continue;
      for (const m of engineFile(name).matchAll(/Tool\.define(?:<[\s\S]{0,400}?>)?\(\s*"([a-z_]+)"/g)) found.add(m[1]);
    }
    for (const id of found) expect(TOOL_IDS, `engine defines "${id}"`).toContain(id);
  });

  // The three ids the engine states through a constant rather than inline, each
  // read from where it is stated so a rename there fails here.
  it('lists the three tools whose id is a constant', () => {
    expect(readFileSync(path.join(toolDir, 'shell', 'id.ts'), 'utf8')).toContain('export const ToolID = "bash"');
    expect(engineFile('task.ts')).toContain('const id = "task"');
    expect(engineFile('code-mode.ts')).toContain('export const CODE_MODE_TOOL = "execute"');
    for (const id of ['bash', 'task', 'execute']) expect(TOOL_IDS).toContain(id);
  });

  // Read the engine's own grouping and check gateOf AGREES with it, rather than
  // checking the engine still says what it says: a fourth tool folded onto
  // `edit` there would otherwise get a checkbox here that decides nothing.
  it('mirrors the engine\'s own edit/write/apply_patch grouping', () => {
    const src = readFileSync(path.join(toolDir, '..', 'permission', 'index.ts'), 'utf8');
    const edits = [...src.match(/const edits = \[([^\]]*)\]/)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    for (const id of edits) expect(gateOf(id), `engine gates "${id}" on edit`).toBe('edit');
    expect(gatesFor(edits)).toHaveLength(1);
  });

  // The consequence spelled out, so the guard above cannot be read as pedantry:
  // every engine tool this build knows has to be in the set a new bot is born
  // with, or that bot arrives already denied a capability nobody withheld.
  it('births a bot able to use every tool the mirror knows', () => {
    const born = allToolKeys();
    for (const id of TOOL_IDS) {
      if (HARD_REQUIRED_TOOLS.includes(id)) continue;
      expect(born, `a new bot is born denied "${id}"`).toContain(gateOf(id));
    }
    // ...and the block it becomes says so: the ONLY deny left is the deny-all
    // base, which is what still closes a tool a NEWER engine adds later.
    expect(toolBlockFor(born).split('\n').filter((l) => l.endsWith(': deny'))).toEqual(['  "*": deny']);
    expect(toolsFromBlock(toolBlockFor(born))).toEqual([...born].sort());
  });

  it('mirrors the engine\'s hard-required set', () => {
    const src = readFileSync(path.join(toolDir, '..', 'session', 'prompt-capture.ts'), 'utf8');
    const found = [...src.match(/REPAIR_ONLY_TOOLS[^\n]*Set\(\[([^\]]*)\]/)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(HARD_REQUIRED_TOOLS).toEqual(found);
  });
});
