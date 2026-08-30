// focusGaps.test.ts — the fold and the wording, with no DOM around them.
//
// Everything that can be WRONG about a gap counter is here: which family a row
// lands in, whether the numbers add up, and what the divider ends up saying.
// The render is plumbing that either calls this or does not, and it is asserted
// separately in ChatTranscript.test.ts.
//
// THE TOOL NAMES ARE NOT INVENTED. The mapping table below is checked against
// ToolCard.svelte's own TOOLCARD_REGISTRY and KIND_REGISTRY by reading that
// file — the drift guard the house rule asks of a mirror — so a card added
// there for a tool nobody classified here fails this suite instead of shipping
// as an unexplained "tool". The names that have no card of their own
// (apply_patch, shell, execute) come from the engine tool ids mirrored in
// src/dashboard/botTools.ts (TOOL_IDS) and docs/TOOL_CARD_CONTRACT.md, read on
// 2026-08-29.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { foldForFocus, isFocusGap, type FocusGap, type GapCategory } from './focusGaps';
import type { Message } from '../panes/chatMessage';

const here = path.dirname(fileURLToPath(import.meta.url));

function msg(id: number, kind: Message['kind'], extra: Partial<Message> = {}): Message {
  return { id, kind, label: '', text: '', ...extra };
}
function tool(id: number, toolName: string, toolKind = 'other'): Message {
  return msg(id, 'tool', { toolName, toolKind, toolStatus: 'completed' });
}
function gaps(rows: ReturnType<typeof foldForFocus>): FocusGap[] {
  return rows.filter(isFocusGap);
}
function total(gap: FocusGap): number {
  return Object.values(gap.counts).reduce((a, b) => a + b, 0);
}

const USER = msg(1, 'user', { label: 'You', text: 'ship it' });
const AGENT = msg(2, 'agent', { label: 'Tsuru', text: 'shipped' });

describe('foldForFocus — where the gaps land', () => {
  it('returns nothing for an empty transcript', () => {
    expect(foldForFocus([])).toEqual([]);
  });

  it('passes a conversation with no hidden rows through BY IDENTITY', () => {
    // Identity, not equality: the transcript keys its {#each} on `msg.id` and
    // the pane still owns these objects, so a fold that rebuilt them would
    // remount every row on each render.
    const rows = foldForFocus([USER, AGENT]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(USER);
    expect(rows[1]).toBe(AGENT);
  });

  it('folds a run at the START of the transcript', () => {
    const rows = foldForFocus([tool(10, 'read'), tool(11, 'read'), USER]);
    expect(rows).toHaveLength(2);
    expect(isFocusGap(rows[0])).toBe(true);
    expect(rows[1]).toBe(USER);
  });

  it('folds a run in the MIDDLE, between two kept rows', () => {
    const rows = foldForFocus([USER, tool(10, 'bash'), AGENT]);
    expect(rows.map((r) => (isFocusGap(r) ? 'gap' : r.kind))).toEqual(['user', 'gap', 'agent']);
  });

  it('folds a run at the END, after the last kept row', () => {
    const rows = foldForFocus([USER, AGENT, tool(10, 'grep'), msg(11, 'verdict')]);
    expect(rows.map((r) => (isFocusGap(r) ? 'gap' : r.kind))).toEqual(['user', 'agent', 'gap']);
  });

  it('folds a run of ONE — a lone hidden row is still a hidden row', () => {
    // The case a "only bother when there are several" rule would drop. A view
    // that marks some gaps and not others is worse than one that marks none:
    // the reader cannot tell an unmarked gap from no gap at all.
    const rows = foldForFocus([USER, msg(10, 'thought', { text: 'hm' }), AGENT]);
    expect(gaps(rows)).toHaveLength(1);
    expect(gaps(rows)[0].label).toBe('1 thought');
  });

  it('folds an ENTIRELY hidden transcript into exactly one gap', () => {
    const rows = foldForFocus([tool(10, 'read'), msg(11, 'thought'), tool(12, 'bash')]);
    expect(rows).toHaveLength(1);
    expect(gaps(rows)[0].label).toBe('1 file read · 1 command · 1 thought');
  });

  it('keeps two runs SEPARATE when one kept row sits between them', () => {
    // The owner's shape: message, counter, message, counter, message. Merging
    // the runs would report work that happened after an answer as if it had
    // happened before it.
    const rows = foldForFocus([USER, tool(10, 'read'), AGENT, tool(11, 'read'), tool(12, 'read'), msg(13, 'user')]);
    const found = gaps(rows);
    expect(found).toHaveLength(2);
    expect(found.map((g) => g.label)).toEqual(['1 file read', '2 file reads']);
  });

  it('never swallows a kind chatFocus has not heard of', () => {
    // chatFocus.ts fails open on purpose. A row of a kind added next year must
    // arrive as a ROW, not be counted into a divider nobody can expand.
    const future = { id: 10, kind: 'handoff', label: '', text: 'from another session' } as unknown as Message;
    const rows = foldForFocus([USER, future, AGENT]);
    expect(gaps(rows)).toHaveLength(0);
    expect(rows[1]).toBe(future);
  });
});

describe('foldForFocus — keys', () => {
  it('keys a gap on the FIRST hidden row of its run', () => {
    const rows = foldForFocus([USER, tool(40, 'read'), tool(41, 'read'), AGENT]);
    expect(gaps(rows)[0].key).toBe('gap-40');
  });

  it('gives two runs two distinct keys, and none collides with a message id', () => {
    // The {#each} key expression is `isFocusGap(msg) ? msg.key : msg.id`, so a
    // gap key that could equal a message id would remount the wrong row.
    const rows = foldForFocus([tool(1, 'read'), USER, tool(2, 'read'), AGENT]);
    const keys = gaps(rows).map((g) => g.key);
    expect(keys).toEqual(['gap-1', 'gap-2']);
    expect(new Set(keys).size).toBe(2);
    expect(keys.some((k) => k === String(USER.id) || k === String(AGENT.id))).toBe(false);
  });

  it('keeps a run’s key stable while the run GROWS', () => {
    // A live turn appends hidden rows one at a time. Keying on the run's head
    // is what stops the divider being destroyed and rebuilt on every delta.
    const head = tool(40, 'read');
    const first = gaps(foldForFocus([USER, head]))[0];
    const later = gaps(foldForFocus([USER, head, tool(41, 'bash'), tool(42, 'grep')]))[0];
    expect(later.key).toBe(first.key);
    expect(later.label).not.toBe(first.label);
  });
});

// THE FAMILY TABLE. One entry per tool name ToolCard dispatches on, plus the
// engine names that share a card. Asserted against ToolCard.svelte below, so
// this list cannot quietly fall behind the cards it mirrors.
const NAME_FAMILY: Record<string, GapCategory> = {
  edit: 'edits',
  multi_edit: 'edits',
  write: 'edits',
  write_file: 'edits',
  read: 'reads',
  read_file: 'reads',
  grep: 'searches',
  glob: 'searches',
  list_dir: 'searches',
  bash: 'commands',
  run: 'commands',
  // Delegation is not one of the four families: a `task` call is an agent, not
  // a file touched or a command run, and it is loud enough that lumping it in
  // with reads would misreport what the run actually did.
  task: 'tools',
  task_parallel: 'tools',
};

/** The keys of ToolCard.svelte's own registries, parsed out of the source. */
function registryNames(constName: string): string[] {
  const src = readFileSync(path.join(here, 'ToolCard.svelte'), 'utf8');
  const block = src.match(new RegExp(`const ${constName}[^{]*\\{([\\s\\S]*?)\\n  \\};`));
  expect(block, `${constName} must still be a literal object in ToolCard.svelte`).not.toBeNull();
  return [...block![1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
}

function familyOf(row: Message): GapCategory {
  const gap = gaps(foldForFocus([row]))[0];
  const named = (Object.keys(gap.counts) as GapCategory[]).filter((k) => gap.counts[k] > 0);
  expect(named, 'a single hidden row lands in exactly one family').toHaveLength(1);
  return named[0];
}

describe('focusGaps — the families mirror the cards that already exist', () => {
  it('dispositions every tool name ToolCard dispatches on — no more, no fewer', () => {
    // The drift guard. Adding a card here without a decision about how its
    // calls are COUNTED is how "38 tools" quietly starts meaning something
    // else, so the new name fails this test until somebody classifies it.
    expect(new Set(registryNames('TOOLCARD_REGISTRY'))).toEqual(new Set(Object.keys(NAME_FAMILY)));
  });

  it('dispositions every ACP kind ToolCard dispatches on', () => {
    // Same guard on the fallback path: these are the kinds that arrive when a
    // row carries no tool name at all.
    expect(new Set(registryNames('KIND_REGISTRY'))).toEqual(new Set(['edit', 'read', 'search', 'execute']));
  });

  for (const [name, family] of Object.entries(NAME_FAMILY)) {
    it(`counts \`${name}\` as ${family}`, () => {
      expect(familyOf(tool(1, name))).toBe(family);
    });
  }

  it('counts the edit tools with no card of their own — apply_patch, shell, execute', () => {
    // Engine tool ids from botTools.ts's TOOL_IDS mirror. apply_patch shares
    // the `edit` permission gate AND the EditCard; shell/execute are the two
    // other spellings of a command that ToolCard's isShell already folds in.
    expect(familyOf(tool(1, 'apply_patch', 'edit'))).toBe('edits');
    expect(familyOf(tool(2, 'shell', 'execute'))).toBe('commands');
    expect(familyOf(tool(3, 'execute', 'execute'))).toBe('commands');
  });

  it('leaves an unrecognised tool as a plain "tool" rather than guessing', () => {
    // Under-described, never miscounted. browser/chart/webfetch/todowrite are
    // real TOOL_IDS with no family of their own; `sed_edit` is not a tool at
    // all, and both must behave the same way.
    for (const name of ['browser', 'chart', 'webfetch', 'todowrite', 'board_tickets', 'sed_edit']) {
      expect(familyOf(tool(1, name)), name).toBe('tools');
    }
  });

  it('falls back to the ACP kind when the row carries no tool name', () => {
    // Not decoration: `toolName` is optional on the row (pre-Pillar-2 sessions
    // and non-Origami ACP servers omit it), and without this every one of
    // those rows would read as a plain "tool".
    expect(familyOf(msg(1, 'tool', { toolKind: 'read' }))).toBe('reads');
    expect(familyOf(msg(2, 'tool', { toolKind: 'edit' }))).toBe('edits');
    expect(familyOf(msg(3, 'tool', { toolKind: 'search' }))).toBe('searches');
    expect(familyOf(msg(4, 'tool', { toolKind: 'execute' }))).toBe('commands');
    expect(familyOf(msg(5, 'tool', { toolKind: 'bash' }))).toBe('commands');
    expect(familyOf(msg(6, 'tool', { toolKind: 'fetch' }))).toBe('tools');
    expect(familyOf(msg(7, 'tool'))).toBe('tools');
    // An EMPTY name, not just a missing one: ChatTranscript already normalises
    // `msg.toolName || ''` on its way into ToolCard, so '' is a shape that
    // really reaches a row — and it must take the same fallback as undefined
    // rather than being looked up as a key.
    expect(familyOf(msg(8, 'tool', { toolName: '', toolKind: 'read' }))).toBe('reads');
    expect(familyOf(msg(9, 'tool', { toolName: '', toolKind: '' }))).toBe('tools');
  });

  it('prefers the NAME over the kind, exactly as ToolCard’s dispatch does', () => {
    // `chart`'s ACP kind is the catch-all `other`, and `browser`'s is `fetch` —
    // ToolCard dispatches both by name for that reason. A row whose name is
    // known must not be re-classified by a kind that disagrees.
    expect(familyOf(tool(1, 'bash', 'read'))).toBe('commands');
    expect(familyOf(tool(2, 'read_file', 'execute'))).toBe('reads');
  });

  it('counts thoughts on their own, and the turn bookkeeping as steps', () => {
    // A verdict, a todo snapshot and a compaction marker are bookkeeping ABOUT
    // a turn, not calls the agent made — folding them into "tools" would
    // inflate the one number a reader takes as work done.
    expect(familyOf(msg(1, 'thought', { text: 'weighing it' }))).toBe('thoughts');
    expect(familyOf(msg(2, 'verdict', { verdict: { kind: 'done', reason: 'ok' } }))).toBe('steps');
    expect(familyOf(msg(3, 'todoSummary', { summaryTodos: [] }))).toBe('steps');
    expect(familyOf(msg(4, 'compacted', { compacting: false }))).toBe('steps');
  });
});

describe('focusGaps — the counts add up', () => {
  it('sums to the length of the run it replaced, for every gap', () => {
    // The invariant the whole divider rests on. If the families ever overlap
    // or a row falls through them, the numbers stop describing the transcript
    // and there is no other place that would notice.
    const run1 = [tool(10, 'read'), tool(11, 'grep'), msg(12, 'thought')];
    const run2 = [tool(20, 'bash'), tool(21, 'edit'), tool(22, 'browser'), msg(23, 'verdict'), msg(24, 'compacted')];
    const found = gaps(foldForFocus([USER, ...run1, AGENT, ...run2]));
    expect(found).toHaveLength(2);
    expect(total(found[0])).toBe(run1.length);
    expect(total(found[1])).toBe(run2.length);
  });

  it('sums correctly when one family holds the whole run', () => {
    const run = Array.from({ length: 38 }, (_, i) => tool(100 + i, 'task'));
    const gap = gaps(foldForFocus([USER, ...run]))[0];
    expect(total(gap)).toBe(38);
    expect(gap.counts.tools).toBe(38);
  });
});

describe('focusGaps — the wording', () => {
  it('reads the way the owner asked for it', () => {
    // The ask, verbatim: "insert the count of hidden actions between the
    // visible messages" — 38 tool calls and 2 file reads between two answers.
    const run = [
      ...Array.from({ length: 38 }, (_, i) => tool(100 + i, 'task')),
      tool(200, 'read'),
      tool(201, 'read_file'),
    ];
    expect(gaps(foldForFocus([USER, ...run, AGENT]))[0].label).toBe('38 tools · 2 file reads');
  });

  it('names every family in ONE fixed order, whatever order the rows arrived in', () => {
    // Rows deliberately shuffled: the label is a reading of the run, not a
    // replay of it, so two runs with the same counts must read identically.
    const shuffled = [
      msg(1, 'verdict'), tool(2, 'grep'), msg(3, 'thought'), tool(4, 'bash'),
      tool(5, 'edit'), tool(6, 'read'), tool(7, 'read_file'), tool(8, 'task'),
    ];
    expect(gaps(foldForFocus(shuffled))[0].label)
      .toBe('1 tool · 2 file reads · 1 edit · 1 command · 1 search · 1 thought · 1 step');
  });

  it('says "1 file read" and "2 file reads" — every family pluralises', () => {
    const one = [tool(1, 'task'), tool(2, 'read'), tool(3, 'edit'), tool(4, 'bash'), tool(5, 'grep'), msg(6, 'thought'), msg(7, 'verdict')];
    expect(gaps(foldForFocus(one))[0].label)
      .toBe('1 tool · 1 file read · 1 edit · 1 command · 1 search · 1 thought · 1 step');
    const two = [...one, ...one.map((m, i) => ({ ...m, id: m.id + 100 }))];
    expect(gaps(foldForFocus(two))[0].label)
      .toBe('2 tools · 2 file reads · 2 edits · 2 commands · 2 searches · 2 thoughts · 2 steps');
  });

  it('omits a family with nothing in it rather than printing a zero', () => {
    const gap = gaps(foldForFocus([tool(1, 'read'), tool(2, 'read'), tool(3, 'read')]))[0];
    expect(gap.label).toBe('3 file reads');
    expect(gap.label).not.toMatch(/\b0 /);
    expect(gap.counts.tools, 'the zero is still IN the counts, just not in the words').toBe(0);
  });
});
