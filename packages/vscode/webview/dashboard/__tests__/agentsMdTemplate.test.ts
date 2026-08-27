// The scaffolded AGENTS.md has to teach the agent to READ the workspace loop,
// not only to write it.
//
// /firstfold seeds a HANDOFF.md and a wiki/, and the template spends most of its
// length on how to WRITE both. Until t-ra4pm8 it never said to read either, so a
// resuming session opened neither file and re-derived what was already recorded
// — the scaffold paid for a loop it only half-closed.
//
// Asserted through `agentsMdTemplate`, the single producer behind all three
// paths that emit this file (/firstfold, the Instructions pane's "+ New file"
// card, and "Restore default"), so one check covers all three and they cannot
// drift apart.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { agentsMdTemplate } from '../../../src/dashboard/firstFold';

let dir: string;
let md: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-agentsmd-'));
  md = agentsMdTemplate(dir);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the scaffolded AGENTS.md read reflexes', () => {
  it('tells a resuming session to read HANDOFF.md', () => {
    // The instruction must be about READING it. Every pre-existing HANDOFF
    // mention in this template is a write rule ("update the handoff", "move the
    // oldest into HANDOFF_archive.md"), and those would satisfy a bare
    // filename check, so match the reflex itself.
    expect(md).toMatch(/Resuming work\?\*\* Read `HANDOFF\.md` first/);
  });

  it('tells a session picking up a task to search the wiki before re-deriving', () => {
    expect(md).toMatch(/Search `wiki\/pages\/` for the topic before you re-derive/);
  });

  it('tells a session to read the cartographer map before exploring the code', () => {
    // The third read reflex, and the same half-closed loop one level down: the
    // cartographer WRITES .origami/map/map.json for agents to read, and until
    // this line the scaffold never mentioned it existed — so every session that
    // opened an unfamiliar repo re-derived the architecture the last map run had
    // already written down. Matched on the reflex, not on the filename alone,
    // because a bare path could be satisfied by any passing mention.
    expect(md).toMatch(/`\.origami\/map\/map\.json` exists.*architecture map/);
    expect(md).toMatch(/read it before you go file by file/);
  });

  it('puts the read reflexes ABOVE the write sections', () => {
    // Ordering is the point, not decoration: a model reading top-down must meet
    // "read the handoff" before it meets "how to write the handoff".
    const read = md.indexOf('## Before you start');
    const write = md.indexOf('## Session continuity');
    const wiki = md.indexOf('## Wiki');

    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(read);
    expect(wiki).toBeGreaterThan(read);
  });

  it('keeps the reflex block short enough to stay in every turn', () => {
    // This file is injected on EVERY turn, so the block is a per-turn cost.
    const block = md.slice(md.indexOf('## Before you start'), md.indexOf('## Session continuity'));
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThan(600);
  });
});
