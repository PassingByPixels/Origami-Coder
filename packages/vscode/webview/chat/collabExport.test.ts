// The one thing a collab export must not do is lose WHO said what.
//
// The chat's own renderSessionMarkdown was the obvious donor and is the wrong
// one: it prints a role, so three agents and a human come out of it as four
// blocks that all claim to be "Agent". These fixtures are therefore built for
// this renderer — a human plus TWO different agents in one stream — because a
// single-agent fixture would pass against a renderer that dropped attribution
// entirely.

import { describe, expect, it } from 'vitest';
import { renderCollabMarkdown, type CollabExportMessage } from './collabExport';

const NAMES = {
  'collab-crane': "Crane - the collab's builder: reviews every diff before it lands",
  'collab-heron': 'Heron - the planner',
};

const msg = (over: Partial<CollabExportMessage>): CollabExportMessage => ({
  authorId: 'collab-crane',
  authorKind: 'agent',
  text: 'text',
  createdAt: '2026-08-05T10:00:00.000Z',
  ...over,
});

const STREAM: CollabExportMessage[] = [
  msg({ authorId: 'user', authorKind: 'human', text: 'plan the storm work' }),
  msg({ authorId: 'collab-heron', text: 'Three steps, in this order.' }),
  msg({ authorId: 'collab-crane', text: 'Taking step one.' }),
];

describe('renderCollabMarkdown', () => {
  it('names the collab in its heading', () => {
    expect(renderCollabMarkdown('Storm plan', NAMES, STREAM).split('\n')[0]).toBe('# Origami collab — Storm plan');
  });

  it('attributes every line to ITS author — the human and the two agents stay apart', () => {
    const md = renderCollabMarkdown('Storm plan', NAMES, STREAM);
    // Order matters as much as the names: an export that attributed correctly
    // but shuffled the stream would still misreport the conversation.
    expect(md.match(/\*\*(.+?)\*\*/g)).toEqual(['**You**', '**Heron**', '**Crane**']);
    expect(md).toContain('plan the storm work');
    expect(md).toContain('Three steps, in this order.');
    expect(md).toContain('Taking step one.');
  });

  it('carries each message\'s own timestamp, not one for the file', () => {
    const md = renderCollabMarkdown('t', NAMES, [
      msg({ authorId: 'collab-heron', createdAt: '2026-08-05T09:00:00.000Z' }),
      msg({ authorId: 'collab-crane', createdAt: '2026-08-05T11:30:00.000Z' }),
    ]);
    expect(md).toContain('**Heron** · 2026-08-05T09:00:00.000Z');
    expect(md).toContain('**Crane** · 2026-08-05T11:30:00.000Z');
  });

  it('an agent the roster no longer knows is still named, never anonymous', () => {
    const md = renderCollabMarkdown('t', NAMES, [msg({ authorId: 'collab-ghost', text: 'still here' })]);
    expect(md).toContain('**Ghost**');
    expect(md).toContain('still here');
  });

  it('markdown a message contains is carried VERBATIM — the stream is the document', () => {
    const md = renderCollabMarkdown('t', NAMES, [msg({ text: '## Plan\n\n- one\n- two' })]);
    expect(md).toContain('## Plan\n\n- one\n- two');
  });

  it('an empty stream exports the heading alone rather than an empty file', () => {
    expect(renderCollabMarkdown('Storm plan', NAMES, [])).toBe('# Origami collab — Storm plan\n');
  });

  it('an untitled collab says so instead of trailing an empty heading', () => {
    expect(renderCollabMarkdown('   ', NAMES, [])).toBe('# Origami collab — untitled\n');
  });
});

// --- M4.1: the document tells the same PROTOCOL truth the stream does.
//
// Before this it printed ten kinds of message as one kind of paragraph, so an
// exported transcript read as prose where the room had run a protocol: an
// `ask` with an owner looked like a remark, a task ledger line looked like
// speech, and a twelve-tool turn looked like a turn that ran none.
//
// Every new field is OPTIONAL on the wire, so the compatibility floor is
// asserted first and VERBATIM — "renders as it always did" is only meaningful
// against the whole string.

const AT = '2026-08-05T10:00:00.000Z';
const one = (over: Partial<CollabExportMessage> = {}) => msg({ text: 'The parser is in.', createdAt: AT, ...over });

describe('renderCollabMarkdown — an older engine renders byte-for-byte as before', () => {
  it('a message with no kind, no mentions and no trace is name · time · text', () => {
    const out = renderCollabMarkdown('Ship it', NAMES, [
      msg({ authorId: 'user', authorKind: 'human', text: 'Start on the parser.', createdAt: AT }),
      one(),
    ]);
    expect(out).toBe(
      '# Origami collab — Ship it\n\n' +
      `**You** · ${AT}\n\nStart on the parser.\n\n` +
      `**Crane** · ${AT}\n\nThe parser is in.\n`,
    );
  });

  it('an explicit say is the same shape — no empty parenthetical creeps in', () => {
    expect(renderCollabMarkdown('t', NAMES, [one({ kind: 'say' })])).toContain(`**Crane** · ${AT}`);
    expect(renderCollabMarkdown('t', NAMES, [one({ kind: 'say' })])).not.toContain('(');
  });
});

describe('renderCollabMarkdown — the header carries the kind', () => {
  it('an ask names who was asked', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'ask', mentions: ['collab-heron'], text: 'Which one?' })]);
    expect(out).toContain('**Crane** (asked @Heron) · ');
  });

  it('a handoff says where it went', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'handoff', mentions: ['collab-heron'] })]);
    expect(out).toContain('**Crane** (handed to @Heron) · ');
  });

  it('a directed kind with NO target still gets its verb, never a dangling @', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'ask', text: 'Anyone?' })]);
    expect(out).toContain('**Crane** (asked) · ');
    expect(out).not.toContain('@');
  });
});

describe('renderCollabMarkdown — bookkeeping is a ledger line, not a speech', () => {
  it('a task_* row is ONE italic line naming who did what', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'task_claim', text: 'Write the parser', taskId: 't1' })]);
    expect(out).toContain(`_Crane — claimed a task — Write the parser · ${AT}_`);
    // Not a bubble: a ledger row gets no bold author header.
    expect(out).not.toContain('**Crane**');
  });

  it('a system line is its own text — the room talking, with no author verb', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'system', text: 'The loop breaker tripped.' })]);
    expect(out).toContain(`_The loop breaker tripped. · ${AT}_`);
    expect(out).not.toContain('Crane');
  });

  it('a multi-line note is flattened — markdown italics do not survive a newline', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'task_reopen', text: 'needs tests\nand a changelog' })]);
    expect(out).toContain('_Crane — reopened a task — needs tests and a changelog · ');
    expect(out).not.toContain('needs tests\nand');
  });
});

describe('renderCollabMarkdown — a turn that ran tools says so', () => {
  it('appends one summary line carrying both counts', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ trace: [{ status: 'ok' }, { status: 'error' }, { status: 'ok' }] })]);
    expect(out).toContain('_3 tools ran, 1 failed_');
  });

  it('states 0 failed on a clean run rather than staying silent about failures', () => {
    expect(renderCollabMarkdown('t', NAMES, [one({ trace: [{ status: 'ok' }] })])).toContain('_1 tool ran, 0 failed_');
  });

  it('a bookkeeping row carries its trace too — tools are a fact about the TURN', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ kind: 'task_done', text: 'done', trace: [{ status: 'ok' }, { status: 'ok' }] })]);
    expect(out).toContain('_2 tools ran, 0 failed_');
  });

  it('NO trace and an empty trace both print nothing — a missing record is not a zero', () => {
    expect(renderCollabMarkdown('t', NAMES, [one({ trace: null }), one()])).not.toContain('tools ran');
    expect(renderCollabMarkdown('t', NAMES, [one({ trace: [] })])).not.toContain('tools ran');
  });
});

describe('renderCollabMarkdown — the Board goes with the talking', () => {
  const BOARD = {
    tasks: [
      { title: 'Write the parser', owner: 'collab-crane', state: 'accepted' as const },
      { title: 'Design the grammar', owner: null, state: 'open' as const },
    ],
    costTotals: [
      { agentSlug: 'collab-crane', cost: 0.125, tokensInput: 1000, tokensOutput: 500 },
      { agentSlug: 'collab-heron', cost: 0.0625, tokensInput: 400, tokensOutput: 100 },
    ],
  };

  it('prints state, owner and title per task, plus the summed spend', () => {
    const out = renderCollabMarkdown('t', NAMES, [one()], BOARD);
    expect(out).toContain('## Board');
    expect(out).toContain('- **accepted** · Crane · Write the parser');
    // An unclaimed task says so rather than leaving the column blank.
    expect(out).toContain('- **open** · unowned · Design the grammar');
    expect(out).toContain('Totals: 2 agents · 2,000 tokens · $0.1875');
  });

  it('lands at the END, after the last message, and the file still ends in a newline', () => {
    const out = renderCollabMarkdown('t', NAMES, [one({ text: 'last word' })], BOARD);
    expect(out.indexOf('## Board')).toBeGreaterThan(out.indexOf('last word'));
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is ABSENT on an engine with no board — an empty heading would be a claim', () => {
    expect(renderCollabMarkdown('t', NAMES, [one()])).not.toContain('## Board');
    expect(renderCollabMarkdown('t', NAMES, [one()], {})).not.toContain('## Board');
    expect(renderCollabMarkdown('t', NAMES, [one()], { tasks: [], costTotals: [] })).not.toContain('## Board');
  });

  it('tasks with no ledger print the tasks and no totals line', () => {
    const out = renderCollabMarkdown('t', NAMES, [one()], { tasks: BOARD.tasks });
    expect(out).toContain('## Board');
    expect(out).not.toContain('Totals:');
  });
});
