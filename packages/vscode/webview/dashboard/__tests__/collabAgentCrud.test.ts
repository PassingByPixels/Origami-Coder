// collabAgentCrud — create / edit / delete a collab agent's .md def.
//
// Everything here runs against a REAL temp directory, because the whole point
// of the module is that the file on disk is the truth (the engine reads defs
// once, at startup, so an engine-listed def cannot be the source). A mocked fs
// would prove only that the module calls fs.
//
// Four things are load-bearing and each has its own test:
//   1. The permission block is a SHIPPED preset, verbatim. What an agent may do
//      is decided here; a drifted copy is a silent permission change.
//   2. `collab: true` is the filter. The same directory holds the archetypes,
//      and offering to edit (or delete) one of those from this pane is wrong.
//   3. A `read: allow` line NESTED under `permission:` must not be mistaken for
//      a top-level key — which is exactly what a naive line scan would do.
//   4. A block matching NEITHER preset is the user's. It round-trips byte for
//      byte; a save button may not quietly widen or narrow it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SLUG_RE,
  deleteCollabAgentDef,
  listArchetypeRefs,
  listCollabAgentDefs,
  listVisionAgentDefs,
  parseAgentDef,
  parseArchetypeRef,
  readCollabAgentDef,
  serializeAgentDef,
  setArchetypeModel,
  writeCollabAgentDef,
  type CollabAgentDef,
} from '../../../src/dashboard/collabAgentCrud';
import { COLLAB_AGENTS } from '../../../src/dashboard/agentManager/collabAgents';
import { COLLAB_AGENTS_V1 } from '../../../src/dashboard/agentManager/collabAgentsLegacy';
import {
  OBSERVER_PERMISSION_BLOCK,
  OBSERVER_STEPS,
  WORKER_PERMISSION_BLOCK,
  WORKER_STEPS,
} from '../../../src/dashboard/agentManager/collabPresets';
import { OBSERVER_TOOLS, WORKER_TOOLS, allToolKeys, toolBlockFor } from '../../../src/dashboard/botTools';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-crud-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const def = (over: Partial<CollabAgentDef> = {}): CollabAgentDef => ({
  slug: 'collab-owl',
  description: 'Owl - the collab\'s note taker',
  model: 'lmstudio/qwen3',
  glyph: 'heron',
  persona: 'You are Owl. Keep the record.',
  preset: 'worker',
  customPermission: '',
  steps: '',
  // Stated explicitly rather than left off: `undefined` means "keep whatever
  // the file says" to the writer, which is a different case with its own tests
  // below. The baseline def is a text-only agent.
  vision: false,
  // Stated for the same reason `vision` is (t-kgtr6c): to the writer an absent
  // one means "keep whatever the file says", and it decides which of the two
  // lists the def appears in. The baseline def is a COLLAB agent.
  visionProfile: false,
  legacySeed: false,
  ...over,
});

/** What `parseAgentDef` returns for a def written from `def()`: the same fields,
 *  with the ones the FILE decides filled in from what was written.
 *
 *  `bot: {}` is one of those: parse ALWAYS reports the bot contract, and an
 *  empty object is what a def declaring none of its keys has. The baseline def
 *  above leaves it off, because to the WRITER an absent contract means "keep
 *  whatever the file says" — the same rule `vision` follows.
 *
 *  `tools` is the same shape of fact (W6): the baseline def states a PRESET and
 *  no ticks, and the ticks are what the block it wrote turns out to say. The
 *  shipped worker block also allows `list`, a permission key no tool in this
 *  engine consults — read back verbatim rather than dropped, because a line the
 *  file states is the file's, not this parser's to tidy away. */
const parsed = (over: Partial<CollabAgentDef> = {}): CollabAgentDef =>
  def({ steps: String(WORKER_STEPS), tools: [...WORKER_TOOLS, 'list'].sort(), bot: {}, ...over });

describe('collabAgentCrud — the slug grammar', () => {
  it('accepts the shapes an agent filename can safely be', () => {
    for (const ok of ['collab-crane', 'a', 'a0', 'x_y-z', '9lives', 'a'.repeat(64)]) {
      expect(SLUG_RE.test(ok), ok).toBe(true);
    }
  });

  it('refuses anything that would not survive being a path segment', () => {
    for (const bad of ['', 'Collab-Crane', '-leading', '_leading', 'has space', 'has/slash', '..', 'a'.repeat(65), 'emoji🦉']) {
      expect(SLUG_RE.test(bad), bad).toBe(false);
    }
  });

  it('a refused slug is reported, not sanitised into a different agent', () => {
    const err = writeCollabAgentDef(def({ slug: 'Bad Slug' }), dir);
    expect(err).toContain('Bad Slug');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('collabAgentCrud — the file a def becomes', () => {
  it('writes the WORKER block verbatim for a worker, not a copy of it', () => {
    const text = serializeAgentDef(def({ preset: 'worker' }));
    expect(text).toContain(WORKER_PERMISSION_BLOCK);
    expect(text).toMatch(/^\s*"\*": deny$/m);
    expect(text).toMatch(/^\s*edit: allow$/m);
    expect(text).toMatch(/^\s*bash: allow$/m);
    // Never a subagent: handing work on inside a collab is an @mention.
    expect(text).toMatch(/^\s*task: deny$/m);
  });

  it('writes the OBSERVER block verbatim for an observer', () => {
    const text = serializeAgentDef(def({ preset: 'observer' }));
    expect(text).toContain(OBSERVER_PERMISSION_BLOCK);
    expect(text).toMatch(/^\s*edit: deny$/m);
    expect(text).toMatch(/^\s*bash: deny$/m);
  });

  it('pins the preset step budget, so a collab turn never inherits the 500-step chat default', () => {
    expect(serializeAgentDef(def({ preset: 'worker' }))).toMatch(new RegExp(`^steps: ${WORKER_STEPS}$`, 'm'));
    expect(serializeAgentDef(def({ preset: 'observer' }))).toMatch(new RegExp(`^steps: ${OBSERVER_STEPS}$`, 'm'));
  });

  it('keeps a step budget the file already states, rather than restamping it', () => {
    expect(serializeAgentDef(def({ preset: 'worker', steps: '7' }))).toMatch(/^steps: 7$/m);
  });

  it('carries the three frontmatter facts that make it a hidden collab agent', () => {
    const text = serializeAgentDef(def());
    expect(text).toMatch(/^mode: all$/m);
    expect(text).toMatch(/^hidden: true$/m);
    expect(text).toMatch(/^collab: true$/m);
  });

  it('OMITS model and glyph when unset — a blank `model:` is a pinned empty model, not an unpinned one', () => {
    const text = serializeAgentDef(def({ model: '', glyph: '' }));
    expect(text).not.toMatch(/^model:/m);
    expect(text).not.toMatch(/^glyph:/m);
    expect(parseAgentDef('collab-owl', text)!.model).toBe('');
  });

  it('quotes the description, so one containing a colon does not break the frontmatter', () => {
    const d = def({ description: 'Owl: the note taker, "quoted" and all' });
    const back = parseAgentDef(d.slug, serializeAgentDef(d));
    expect(back!.description).toBe('Owl: the note taker, "quoted" and all');
  });
});

describe('collabAgentCrud — round trip', () => {
  it('write -> list -> read returns every field unchanged', () => {
    expect(writeCollabAgentDef(def(), dir)).toBeNull();

    expect(listCollabAgentDefs(dir)).toEqual([parsed()]);
    expect(readCollabAgentDef('collab-owl', dir)).toEqual(parsed());
  });

  it('a multi-paragraph persona survives, blank lines and all', () => {
    const persona = 'First line.\n\nSecond paragraph.\n\n- a bullet\n- another';
    writeCollabAgentDef(def({ persona }), dir);
    expect(readCollabAgentDef('collab-owl', dir)!.persona).toBe(persona);
  });

  it('re-saving an unedited def leaves the file BYTE-identical', () => {
    // The round-trip has to be idempotent, not merely lossless. The pane's edit
    // flow is read -> show -> write, so if parse and serialize disagreed on
    // trailing whitespace, every open-and-save of an untouched agent would
    // append another blank line and the file would creep.
    //
    // Measured from the SECOND write on: W6 changed the block a preset writes
    // into the explicit tick block, so the first save of a def written by the
    // old serializer legitimately rewrites those lines once. What must never
    // happen is a file that keeps changing, which is what this pins.
    const persona = 'First line.\n\nSecond paragraph.';
    writeCollabAgentDef(def({ persona }), dir);
    writeCollabAgentDef(readCollabAgentDef('collab-owl', dir)!, dir);
    const first = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    writeCollabAgentDef(readCollabAgentDef('collab-owl', dir)!, dir);
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).toBe(first);
  });

  // The migration that idempotence is measured after: what the old preset block
  // MEANT has to survive being rewritten as ticks, or every existing bot
  // silently changes what it may do on the first save of an unrelated edit.
  it('a shipped preset block migrates to the tick block without changing what it allows', () => {
    writeCollabAgentDef(def(), dir); // writes WORKER_PERMISSION_BLOCK
    const migrated = readCollabAgentDef('collab-owl', dir)!;
    writeCollabAgentDef(migrated, dir);

    const after = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(after).not.toContain(WORKER_PERMISSION_BLOCK);
    for (const tool of WORKER_TOOLS) expect(after).toMatch(new RegExp(`^  ${tool}: allow$`, 'm'));
    // ...and the ones the worker block closed are still closed, now out loud.
    for (const tool of ['task', 'todowrite', 'browser']) expect(after).toMatch(new RegExp(`^  ${tool}: deny$`, 'm'));
    expect(readCollabAgentDef('collab-owl', dir)!.tools).toEqual(migrated.tools);
  });

  it('a second write overwrites in place rather than making a second agent', () => {
    writeCollabAgentDef(def(), dir);
    writeCollabAgentDef(def({ description: 'edited' }), dir);
    const all = listCollabAgentDefs(dir);
    expect(all).toHaveLength(1);
    expect(all[0].description).toBe('edited');
  });

  it('reads a CRLF def — the form a def takes once Windows has edited it', () => {
    // This ships on Windows and the def is a plain .md the user is invited to
    // open. VS Code will save it back CRLF, so every line ending here is \r\n:
    // the frontmatter scan, the blank line after `---`, and the trailing
    // newline the persona must NOT keep.
    const text = serializeAgentDef(def()).replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), text, 'utf8');
    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.persona).toBe('You are Owl. Keep the record.');
    expect(back.description).toBe(def().description);
    expect(back.model).toBe('lmstudio/qwen3');
    expect(back.glyph).toBe('heron');
    // ...and the preset survives the line endings. Without CRLF normalisation
    // every def on Windows would read as `custom` and become untouchable.
    expect(back.preset).toBe('worker');
  });

  // --- M4.4: `vision:` decides whether an image posted to a room reaches this
  // agent as real picture data or as a note saying one was attached. It was
  // WRITE-ONLY by hand and READ by nobody, so the pane's first save dropped it
  // — an agent went blind on an edit that never mentioned vision.
  it('a hand-added `vision: true` survives a read-and-save round trip', () => {
    // Exactly the file a user hand-edits: the serialiser's own output with the
    // key added, so nothing else about the def can explain a difference.
    const withVision = serializeAgentDef(def()).replace('glyph: heron', 'glyph: heron\nvision: true');
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), withVision, 'utf8');

    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.vision).toBe(true);

    // The save the pane performs — read, show, write back untouched.
    expect(writeCollabAgentDef(back, dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).toContain('vision: true');
    expect(readCollabAgentDef('collab-owl', dir)!.vision).toBe(true);
  });

  it('omits the key entirely when vision is off — no `vision: false` line', () => {
    writeCollabAgentDef(def({ vision: false }), dir);
    const text = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(text).not.toContain('vision');
    expect(readCollabAgentDef('collab-owl', dir)!.vision).toBe(false);
  });

  it('only the literal `true` is vision — `yes` / `1` / blank are not', () => {
    for (const raw of ['yes', '1', 'True', '']) {
      const text = serializeAgentDef(def()).replace('glyph: heron', `glyph: heron\nvision: ${raw}`);
      fs.writeFileSync(path.join(dir, 'collab-owl.md'), text, 'utf8');
      expect(readCollabAgentDef('collab-owl', dir)!.vision).toBe(false);
    }
  });

  it('a save that says NOTHING about vision keeps the file\'s own value', () => {
    // The message boundary forwards only the fields the form stated. An
    // unstated vision must not reset a seeing agent to blind — the same rule
    // `preset` already follows, and the reason both are optional.
    const withVision = serializeAgentDef(def()).replace('glyph: heron', 'glyph: heron\nvision: true');
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), withVision, 'utf8');

    const { vision: _dropped, ...silent } = def({ description: 'edited elsewhere' });
    expect(writeCollabAgentDef(silent as CollabAgentDef, dir)).toBeNull();

    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.vision).toBe(true);
    expect(back.description).toBe('edited elsewhere');
  });

  it('reads `vision: true` out of a CRLF def — the form it takes on Windows', () => {
    // This ships on Windows and the def is a plain .md the user is invited to
    // open; VS Code saves it back CRLF. A stray \r on the value would make it
    // `"true\r"`, which is not `true`, and the agent would go blind on a save
    // that only changed its line endings.
    const text = serializeAgentDef(def({ vision: true })).replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), text, 'utf8');
    expect(readCollabAgentDef('collab-owl', dir)!.vision).toBe(true);
  });

  it('does NOT mistake an indented `vision:` inside the permission block', () => {
    // The reader anchors every key at column 0 for exactly this reason. A
    // nested key is a permission rule, not the agent's capability.
    const text = serializeAgentDef(def({ vision: false }))
      .replace('permission:', 'permission:\n  vision: true');
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), text, 'utf8');
    expect(readCollabAgentDef('collab-owl', dir)!.vision).toBe(false);
  });

  it('...and on a brand-new file that same silence means OFF, not on', () => {
    const { vision: _dropped, ...silent } = def({ slug: 'collab-new' });
    writeCollabAgentDef(silent as CollabAgentDef, dir);
    expect(readCollabAgentDef('collab-new', dir)!.vision).toBe(false);
  });

  it('the shipped seed defs parse back out of their own on-disk form', () => {
    // The strongest available check that this reader and the seed writer agree:
    // it reads the EXACT bytes collabAgents.ts installs.
    for (const seed of COLLAB_AGENTS) {
      fs.writeFileSync(path.join(dir, seed.file), seed.content, 'utf8');
    }
    const slugs = listCollabAgentDefs(dir).map((d) => d.slug);
    expect(slugs).toEqual(['collab-crane', 'collab-heron']);
    const crane = readCollabAgentDef('collab-crane', dir)!;
    expect(crane.description).toContain('Crane');
    // v4: the shipped seeds ship UNPINNED — '' round-trips as "no pinned
    // model", not as a model literally named nothing (collabAgentDef.ts).
    expect(crane.model).toBe('');
    expect(crane.persona).toContain('You are the bot Crane');
  });
});

// --- M4. Which preset a def carries is a fact about the FILE, and the pane's
// form has to read it back correctly before it offers to change it. The custom
// case is the one that matters: it is the only block this module must not write.

describe('collabAgentCrud — the preset a def on disk carries', () => {
  it('reads back the shipped seeds as the presets they are', () => {
    for (const seed of COLLAB_AGENTS) fs.writeFileSync(path.join(dir, seed.file), seed.content, 'utf8');
    expect(readCollabAgentDef('collab-crane', dir)!.preset).toBe('worker');
    expect(readCollabAgentDef('collab-heron', dir)!.preset).toBe('observer');
  });

  it('calls a hand-edited block CUSTOM and hands it back verbatim', () => {
    const block = 'permission:\n  "*": deny\n  read: allow\n  bash:\n    "*": deny\n    "git status": allow';
    fs.writeFileSync(
      path.join(dir, 'collab-owl.md'),
      `---\ndescription: "mine"\nmode: all\nhidden: true\ncollab: true\nsteps: 12\n${block}\n---\n\nYou are Owl.\n`,
      'utf8',
    );
    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.preset).toBe('custom');
    expect(back.customPermission).toBe(block);
    expect(back.steps).toBe('12');
  });

  it('SAVING a custom def leaves its block and its step budget exactly as written', () => {
    // The whole rule. A pane that re-serialised this as a preset would quietly
    // hand an agent `bash: allow` when its author had narrowed it to one command.
    const block = 'permission:\n  "*": deny\n  read: allow\n  bash:\n    "*": deny\n    "git status": allow';
    fs.writeFileSync(
      path.join(dir, 'collab-owl.md'),
      `---\ndescription: "mine"\nmode: all\nhidden: true\ncollab: true\nsteps: 12\n${block}\n---\n\nYou are Owl.\n`,
      'utf8',
    );
    const edited = { ...readCollabAgentDef('collab-owl', dir)!, description: 'renamed' };
    expect(writeCollabAgentDef(edited, dir)).toBeNull();

    const after = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(after).toContain(block);
    expect(after).toMatch(/^steps: 12$/m);
    expect(after).not.toContain(WORKER_PERMISSION_BLOCK);
    expect(readCollabAgentDef('collab-owl', dir)!.description).toBe('renamed');
  });

  it('a custom block read from a CRLF file is stored and rewritten as LF, not with stray CRs', () => {
    // The custom block is the one value this module copies straight back out. If
    // it were captured with the file's CRs still in it, saving would splice
    // \r-terminated lines into an otherwise-LF file - a def that looks fine in
    // the pane and is progressively harder to diff every time it is saved.
    const block = 'permission:\n  "*": deny\n  read: allow\n  webfetch: allow';
    const text = `---\ncollab: true\n${block}\n---\n\nYou are Owl.\n`;
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), text.replace(/\n/g, '\r\n'), 'utf8');

    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.preset).toBe('custom');
    expect(back.customPermission).toBe(block);
    writeCollabAgentDef(back, dir);
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).not.toMatch(/\r/);
  });

  it('a def with NO permission block does not GAIN one on save', () => {
    // The nastiest version of the custom rule. Such a def reads as `custom`, so
    // the pane tells the user its permissions are kept as written - and a save
    // that stamped the worker block on would hand it edit and bash while that
    // sentence was on screen. Absent stays absent until the user picks a preset.
    fs.writeFileSync(path.join(dir, 'collab-owl.md'), '---\ndescription: "x"\ncollab: true\n---\n\nYou are X.\n', 'utf8');
    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.preset).toBe('custom');

    writeCollabAgentDef(back, dir);
    const after = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(after).not.toMatch(/^permission:$/m);
    expect(after).not.toContain(WORKER_PERMISSION_BLOCK);
    // ...and picking a preset is how the user opts in, explicitly.
    writeCollabAgentDef({ ...back, preset: 'observer', steps: '' }, dir);
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).toContain(OBSERVER_PERMISSION_BLOCK);
  });

  it('a preset FLIP replaces the block and restamps the budget', () => {
    writeCollabAgentDef(def({ preset: 'observer' }), dir);
    expect(readCollabAgentDef('collab-owl', dir)!.preset).toBe('observer');

    // A flip is a change of TICKS since W6 — the checklist is the only
    // permission surface — and the budget follows the ticks rather than a
    // `preset` field that could disagree with them.
    writeCollabAgentDef({ ...readCollabAgentDef('collab-owl', dir)!, tools: [...WORKER_TOOLS], steps: '' }, dir);
    const after = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(after).toContain(toolBlockFor(WORKER_TOOLS));
    expect(after).not.toContain(toolBlockFor(OBSERVER_TOOLS));
    expect(after).toMatch(new RegExp(`^steps: ${WORKER_STEPS}$`, 'm'));
    expect(readCollabAgentDef('collab-owl', dir)!.preset).toBe('worker');
  });

  // W9: what "every tool ticked" IS ON DISK, through the real writer and the
  // real parser, in a real directory. The claim the owner asked for is a REPLAY
  // claim — reload must show the same ticks — and it cannot be made by the block
  // builder alone: the writer chooses between three ways of stating permissions
  // and the parser reads back through `toolsFromBlock`, so only the round trip
  // says whether the file the user reopens is the one they saved.
  it('an ALL-TICKED bot states every gate explicitly, and reopens on the same ticks', () => {
    const every = allToolKeys();
    expect(writeCollabAgentDef(def({ tools: every, steps: '' }), dir)).toBeNull();
    const file = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');

    // AN EXPLICIT BLOCK, not the ABSENCE of one. "No block" already means
    // something else here — the def never spoke and the engine's own defaults
    // stand — so writing all-allow as silence would collapse two different
    // answers into one, and a later engine adding a tool would hand it to a bot
    // nobody granted it to.
    expect(file).toContain('permission:');
    for (const key of every) expect(file, `${key} is not stated`).toMatch(new RegExp(`^  ${key}: allow$`, 'm'));
    // The deny-all base is the ONLY deny left, and it is what still closes a
    // tool a NEWER engine adds after this file was written.
    expect(file.split('\n').filter((l) => /^  \S+: deny$/.test(l))).toEqual(['  "*": deny']);

    // ...and the replay: reopen, and the checklist shows exactly what was saved.
    expect(readCollabAgentDef('collab-owl', dir)!.tools).toEqual([...every].sort());
    // Saving it again untouched changes nothing — no drift on a no-op edit.
    const reopened = readCollabAgentDef('collab-owl', dir)!;
    writeCollabAgentDef(reopened, dir);
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).toBe(file);
  });

  it('a def that states NO preset inherits the file\'s, rather than defaulting to worker', () => {
    // The pane's save crosses a message boundary that forwards only the text
    // fields. An observer coming back through it must not be widened silently.
    writeCollabAgentDef(def({ preset: 'observer' }), dir);
    expect(writeCollabAgentDef({ ...def(), preset: undefined, description: 'edited' }, dir)).toBeNull();

    const after = readCollabAgentDef('collab-owl', dir)!;
    expect(after.preset).toBe('observer');
    expect(after.description).toBe('edited');
    expect(after.steps).toBe(String(OBSERVER_STEPS));
  });

  it('...and a genuinely NEW def with no preset is a worker', () => {
    expect(writeCollabAgentDef({ ...def(), preset: undefined }, dir)).toBeNull();
    expect(readCollabAgentDef('collab-owl', dir)!.preset).toBe('worker');
  });

  it('reads a permission block that is not the LAST key in the frontmatter', () => {
    // Hand-written defs put the keys in any order; a scan that ran to the end of
    // the frontmatter would swallow `model:` into the block and call it custom.
    fs.writeFileSync(
      path.join(dir, 'collab-owl.md'),
      `---\ncollab: true\n${WORKER_PERMISSION_BLOCK}\nmodel: lmstudio/qwen3\nsteps: 40\n---\n\nYou are Owl.\n`,
      'utf8',
    );
    const back = readCollabAgentDef('collab-owl', dir)!;
    expect(back.preset).toBe('worker');
    expect(back.model).toBe('lmstudio/qwen3');
  });

  it('flags an untouched M1 seed so the pane can offer the reseed, and flags nothing else', () => {
    for (const seed of COLLAB_AGENTS) fs.writeFileSync(path.join(dir, seed.file), seed.content, 'utf8');
    writeCollabAgentDef(def(), dir);
    expect(listCollabAgentDefs(dir).filter((d) => d.legacySeed)).toEqual([]);

    fs.writeFileSync(path.join(dir, 'collab-crane.md'), COLLAB_AGENTS_V1[0].content, 'utf8');
    expect(listCollabAgentDefs(dir).filter((d) => d.legacySeed).map((d) => d.slug)).toEqual(['collab-crane']);
  });
});

describe('collabAgentCrud — listing only ever sees COLLAB agents', () => {
  it('a mode-frontmatter def without `collab: true` lists as an archetype ref, and junk md is skipped by both', () => {
    fs.writeFileSync(
      path.join(dir, 'architect.md'),
      '---\ndescription: "not a collab agent"\nmode: all\n---\n\nYou are the architect.\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'junk.md'), 'just some prose, no frontmatter\n', 'utf8');
    writeCollabAgentDef(def(), dir);

    expect(listCollabAgentDefs(dir).map((d) => d.slug)).toEqual(['collab-owl']);
    expect(listArchetypeRefs(dir)).toEqual([
      { slug: 'architect', description: 'not a collab agent', mode: 'all', managed: false, path: path.join(dir, 'architect.md') },
    ]);
  });

  it('a NESTED permission key cannot be mistaken for a top-level one', () => {
    // `read: allow` lives under `permission:`; a naive line scan would return
    // it for a top-level lookup and, worse, could match `collab:`-like keys.
    const text = serializeAgentDef(def({ model: '' }));
    expect(text).toMatch(/^ {2}read: allow$/m);
    const parsed = parseAgentDef('collab-owl', text)!;
    expect(parsed.model).toBe('');
    expect(parsed.description).toBe(def().description);
  });

  it('skips a file with no frontmatter, and a non-.md file, without failing the listing', () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'just some prose\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.txt'), 'collab: true\n', 'utf8');
    writeCollabAgentDef(def(), dir);
    expect(listCollabAgentDefs(dir).map((d) => d.slug)).toEqual(['collab-owl']);
  });

  it('an absent directory lists EMPTY — a fresh install is not a failure', () => {
    expect(listCollabAgentDefs(path.join(dir, 'nope'))).toEqual([]);
  });

  it('lists slug-sorted, so the pane does not reorder itself on a refresh', () => {
    for (const slug of ['collab-zebra', 'collab-alpha', 'collab-mid']) writeCollabAgentDef(def({ slug }), dir);
    expect(listCollabAgentDefs(dir).map((d) => d.slug)).toEqual(['collab-alpha', 'collab-mid', 'collab-zebra']);
  });
});

// t-kgtr6c — VISION PROFILES share this directory and this file format, and the
// ONE key that tells them apart is `vision-profile: true`. Everything below is
// about that key doing its job: a profile must not appear in the collab roster
// (it would be offered as a collab participant), a collab agent must not appear
// in the profile list (it would be sent a picture its model cannot read), and a
// profile must always carry `vision: true` — the only key the ENGINE reads, and
// the difference between being handed an image and being handed a note about one.
const visionDef = (over: Partial<CollabAgentDef> = {}): CollabAgentDef =>
  def({ slug: 'vision-eye', description: 'Reads screenshots.', model: 'lmstudio/qwen2-vl', preset: 'observer', vision: true, visionProfile: true, ...over });

describe('collabAgentCrud — vision profiles', () => {
  it('writes vision-profile: true INSTEAD of collab: true, so one file is in one list', () => {
    const text = serializeAgentDef(visionDef());
    expect(text).toMatch(/^vision-profile: true$/m);
    expect(text).not.toMatch(/^collab: true$/m);
  });

  it('always writes vision: true — the only key the engine reads', () => {
    // Even asked for with vision false: a profile that cannot be shown pixels
    // is the one def where the blind default is silently useless.
    expect(serializeAgentDef(visionDef({ vision: false }))).toMatch(/^vision: true$/m);
  });

  it('round-trips: a profile parses back as a profile that can see', () => {
    writeCollabAgentDef(visionDef(), dir);
    const back = readCollabAgentDef('vision-eye', dir)!;
    expect(back.visionProfile).toBe(true);
    expect(back.vision).toBe(true);
    expect(back.model).toBe('lmstudio/qwen2-vl');
  });

  it('the two lists never overlap', () => {
    writeCollabAgentDef(def(), dir);
    writeCollabAgentDef(visionDef(), dir);
    expect(listCollabAgentDefs(dir).map((d) => d.slug)).toEqual(['collab-owl']);
    expect(listVisionAgentDefs(dir).map((d) => d.slug)).toEqual(['vision-eye']);
  });

  it('a def carrying NEITHER key is still nobody’s — the archetype filter holds', () => {
    fs.writeFileSync(path.join(dir, 'architect.md'), '---\ndescription: "Plans"\nmode: subagent\n---\n\nYou are Architect.\n', 'utf8');
    expect(listCollabAgentDefs(dir)).toEqual([]);
    expect(listVisionAgentDefs(dir)).toEqual([]);
  });

  // The sharpest of the three "unstated means keep" rules: this one decides
  // which TAB the def lives under, so a save that forgot to mention it would
  // make a profile vanish from the pane the user was looking at.
  it('an UNSTATED visionProfile keeps the file’s own value rather than resetting it', () => {
    writeCollabAgentDef(visionDef(), dir);
    const { visionProfile: _dropped, ...withoutTheKey } = visionDef({ description: 'edited' });
    writeCollabAgentDef(withoutTheKey as CollabAgentDef, dir);

    const back = readCollabAgentDef('vision-eye', dir)!;
    expect(back.description).toBe('edited');
    expect(back.visionProfile).toBe(true);
    expect(listCollabAgentDefs(dir)).toEqual([]);
  });
});

describe('collabAgentCrud — delete refuses anything that is not a collab agent', () => {
  it('deletes a collab agent and leaves the directory otherwise untouched', () => {
    writeCollabAgentDef(def(), dir);
    writeCollabAgentDef(def({ slug: 'collab-keep' }), dir);
    expect(deleteCollabAgentDef('collab-owl', dir)).toBeNull();
    expect(listCollabAgentDefs(dir).map((d) => d.slug)).toEqual(['collab-keep']);
  });

  it('REFUSES to delete an archetype that happens to share the directory', () => {
    const archetype = path.join(dir, 'architect.md');
    fs.writeFileSync(archetype, '---\ndescription: "the architect"\nmode: all\n---\n\nprompt\n', 'utf8');
    expect(deleteCollabAgentDef('architect', dir)).toContain('No agent named');
    expect(fs.existsSync(archetype)).toBe(true);
  });

  it('reports an unknown slug rather than reporting a success it did not perform', () => {
    expect(deleteCollabAgentDef('collab-ghost', dir)).toContain('collab-ghost');
  });

  it('a malformed slug can never reach the filesystem', () => {
    fs.writeFileSync(path.join(dir, 'victim.md'), '---\ncollab: true\n---\n\nx\n', 'utf8');
    expect(deleteCollabAgentDef('../victim', dir)).toContain('No agent named');
    expect(readCollabAgentDef('../victim', dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'victim.md'))).toBe(true);
  });
});

// --- D7: archetype refs share the directory with collab defs (`mode:` set,
// no `collab: true`) — architect/ask/debug/orchestrator/scout/cartographer.
// Nothing here creates, edits or deletes one; setArchetypeModel's write is a
// byte-surgical `model:` line edit, never parseAgentDef/serializeAgentDef.
describe('collabAgentCrud — archetype refs', () => {
  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content, 'utf8');

  it('picks up the model when the file pins one', () => {
    write('debug.md', '---\ndescription: "Systematic diagnosis"\nmode: all\nmodel: lmstudio/qwen3\n---\n\nYou are Debug.\n');
    expect(parseArchetypeRef('debug', fs.readFileSync(path.join(dir, 'debug.md'), 'utf8'))).toEqual({
      slug: 'debug', description: 'Systematic diagnosis', model: 'lmstudio/qwen3', mode: 'all', managed: false,
    });
  });

  it('setArchetypeModel inserts a model: line after description, preserving every other byte', () => {
    const text = '---\ndescription: "Designs before code"\nmode: all\npermission:\n  "*": deny\n  read: allow\n---\n\nYou are the Architect.\nSecond line.\n';
    write('architect.md', text);
    expect(setArchetypeModel('architect', 'lmstudio/qwen3', dir)).toBeNull();
    const after = fs.readFileSync(path.join(dir, 'architect.md'), 'utf8');
    expect(after).toBe(text.replace('description: "Designs before code"\n', 'description: "Designs before code"\nmodel: lmstudio/qwen3\n'));
  });

  it('setArchetypeModel replaces an existing model: line in place, every other byte untouched', () => {
    const text = '---\ndescription: "Ask"\nmode: all\nmodel: lmstudio/old\npermission:\n  read: allow\n---\n\nYou are Ask.\n';
    write('ask.md', text);
    expect(setArchetypeModel('ask', 'lmstudio/new', dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'ask.md'), 'utf8')).toBe(text.replace('model: lmstudio/old', 'model: lmstudio/new'));
  });

  // UAT round 2 item 3: scout used to be refused outright. What actually makes
  // it security-load-bearing is its PERMISSION block — ask/architect delegate
  // to it by NAME for the S12 task-laundering fix — and a `model:` line cannot
  // re-grant a tool, so the block is what this asserts survives the write. The
  // honest caveat (archetypes.ts ships the file, an upgrade may reset it) is
  // the card's job now, not a refusal that also blocked the legitimate pin.
  it('pins scout\'s model like any other archetype, leaving its permission block byte-identical', () => {
    const text = '---\ndescription: "Read-only recon"\nmode: subagent\npermission:\n  "*": deny\n  read: allow\n---\n\nYou are Scout.\n';
    write('scout.md', text);
    expect(setArchetypeModel('scout', 'lmstudio/qwen3', dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'scout.md'), 'utf8')).toBe(
      text.replace('description: "Read-only recon"\n', 'description: "Read-only recon"\nmodel: lmstudio/qwen3\n'),
    );
  });

  it('refuses a slug that is not an archetype at all (e.g. a collab def)', () => {
    writeCollabAgentDef(def(), dir);
    const before = fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8');
    expect(setArchetypeModel('collab-owl', 'lmstudio/qwen3', dir)).toContain('No archetype');
    expect(fs.readFileSync(path.join(dir, 'collab-owl.md'), 'utf8')).toBe(before);
  });
});
