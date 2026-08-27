// collabKinds — the stream's protocol vocabulary.
//
// The case that matters most is the ABSENT one: an older engine sends no
// `kind` at all, and every rule here has to read that as an ordinary `say`
// rather than as an unknown state. The second is the system BREAK — a task
// line folded into an agent's speaking run would attribute bookkeeping to a
// sentence it never said.
import { describe, expect, it } from 'vitest';
import type { CollabMessage } from '../../src/acpExtTypes';
import { buildStreamRows, isSystemMessage, kindLabel, kindOf, kindTone } from './collabKinds';

const m = (seq: number, over: Partial<CollabMessage> = {}): CollabMessage => ({
  seq,
  authorId: 'collab-crane',
  authorKind: 'agent',
  text: `message ${seq}`,
  createdAt: '2026-08-05T10:00:00.000Z',
  ...over,
});

const shortName = (slug: string) => slug.replace('collab-', '');

describe('kindOf — the absent-kind fallback', () => {
  it("a message with no kind at all is a plain 'say'", () => {
    expect(kindOf(m(1))).toBe('say');
  });

  it('a stated kind is taken verbatim', () => {
    expect(kindOf(m(1, { kind: 'ask' }))).toBe('ask');
  });
});

describe('isSystemMessage — which kinds are one-line rows', () => {
  it('every task_* kind and system are rows', () => {
    for (const kind of ['task_open', 'task_claim', 'task_done', 'task_accept', 'task_reopen', 'system'] as const) {
      expect(isSystemMessage(m(1, { kind }))).toBe(true);
    }
  });

  it('say / ask / answer / handoff are bubbles, and so is an absent kind', () => {
    for (const kind of ['say', 'ask', 'answer', 'handoff'] as const) {
      expect(isSystemMessage(m(1, { kind }))).toBe(false);
    }
    expect(isSystemMessage(m(1))).toBe(false);
  });
});

describe('kindTone — only a DIRECTED message is tinted', () => {
  it('ask and handoff carry their own tone', () => {
    expect(kindTone(m(1, { kind: 'ask' }))).toBe('ask');
    expect(kindTone(m(1, { kind: 'handoff' }))).toBe('handoff');
  });

  it('everything else is untinted, absent kind included', () => {
    expect(kindTone(m(1, { kind: 'answer' }))).toBe('');
    expect(kindTone(m(1, { kind: 'say' }))).toBe('');
    expect(kindTone(m(1))).toBe('');
  });
});

describe('kindLabel', () => {
  it('names the target of an ask and of a handoff', () => {
    expect(kindLabel(m(1, { kind: 'ask', mentions: ['collab-heron'] }), shortName)).toBe('asked @heron');
    expect(kindLabel(m(1, { kind: 'handoff', mentions: ['collab-heron'] }), shortName)).toBe('handed to @heron');
  });

  it('a directed message with NO mention keeps its verb rather than dangling an empty @', () => {
    expect(kindLabel(m(1, { kind: 'ask' }), shortName)).toBe('asked');
    expect(kindLabel(m(1, { kind: 'handoff' }), shortName)).toBe('handed on');
  });

  it('each task kind states what happened', () => {
    expect(kindLabel(m(1, { kind: 'task_open' }), shortName)).toBe('opened a task');
    expect(kindLabel(m(1, { kind: 'task_claim' }), shortName)).toBe('claimed a task');
    expect(kindLabel(m(1, { kind: 'task_done' }), shortName)).toBe('finished a task');
    expect(kindLabel(m(1, { kind: 'task_accept' }), shortName)).toBe('accepted a task');
    expect(kindLabel(m(1, { kind: 'task_reopen' }), shortName)).toBe('reopened a task');
  });

  it('a plain say and a system line carry no label — their text IS the message', () => {
    expect(kindLabel(m(1, { kind: 'say' }), shortName)).toBe('');
    expect(kindLabel(m(1, { kind: 'system' }), shortName)).toBe('');
    expect(kindLabel(m(1), shortName)).toBe('');
  });
});

describe('buildStreamRows', () => {
  it('collapses a run of one author into ONE group', () => {
    const rows = buildStreamRows([m(1), m(2), m(3)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toBe('group');
    expect(rows[0].row === 'group' && rows[0].msgs.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('splits on author id AND on author kind', () => {
    const rows = buildStreamRows([
      m(1),
      m(2, { authorId: 'collab-heron' }),
      m(3, { authorId: 'collab-heron', authorKind: 'human' }),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('a system row BREAKS the run instead of joining it', () => {
    const rows = buildStreamRows([m(1), m(2, { kind: 'task_done' }), m(3)]);
    expect(rows.map((r) => r.row)).toEqual(['group', 'system', 'group']);
    // ...and the two speaking runs stay one message each, not one group of two.
    expect(rows[0].row === 'group' && rows[0].msgs).toHaveLength(1);
    expect(rows[2].row === 'group' && rows[2].msgs).toHaveLength(1);
  });

  it('keys on the seq of the row it opens, so no two rows share a key', () => {
    const rows = buildStreamRows([m(1), m(2, { authorId: 'collab-heron' }), m(5, { kind: 'system' })]);
    expect(rows.map((r) => r.key)).toEqual([1, 2, 5]);
  });

  it('an empty stream is an empty list, not a group of nothing', () => {
    expect(buildStreamRows([])).toEqual([]);
  });
});

// ── W2 (report 2.3): the A → B flow rail ─────────────────────────────────────
//
// A room's protocol was already typed and already stored per message — an `ask`
// names its target, a `handoff` names who is taking over — and the stream threw
// all of it away except a verb. "asked @heron" says a question happened; it does
// not say WHO is now blocked on WHOM, which is the one thing a supervisor needs
// to read off a four-agent room at a glance.
//
// The direction is only ever drawn from the data. A directed kind with no target
// keeps its bare verb rather than inventing a partner for the arrow.
describe('kindLabel — the directional rail', () => {
  it('an ask reads as A → B once the author is known', () => {
    const label = kindLabel(m(1, { kind: 'ask', mentions: ['collab-heron'] }), shortName, 'crane');
    expect(label).toBe('crane → heron · asked');
  });

  it('a handoff reads the same way — it is the same fact about direction', () => {
    const label = kindLabel(m(1, { kind: 'handoff', mentions: ['collab-heron'] }), shortName, 'crane');
    expect(label).toBe('crane → heron · handed on');
  });

  // A finished task goes to the BOARD, where a human accepts or sends it back.
  // That is a real destination in the room, not an invented one.
  it('a task_done points at the board, which is where it is now waiting', () => {
    expect(kindLabel(m(1, { kind: 'task_done' }), shortName, 'crane')).toBe('crane → board · finished a task');
  });

  it('the other task_* rows keep their plain verb — nothing is waiting on anyone', () => {
    expect(kindLabel(m(1, { kind: 'task_claim' }), shortName, 'crane')).toBe('claimed a task');
    expect(kindLabel(m(1, { kind: 'task_accept' }), shortName, 'crane')).toBe('accepted a task');
  });

  it('a directed kind with NO target keeps its bare verb — no half-drawn arrow', () => {
    expect(kindLabel(m(1, { kind: 'ask' }), shortName, 'crane')).toBe('asked');
    expect(kindLabel(m(1, { kind: 'handoff' }), shortName, 'crane')).toBe('handed on');
  });

  // collabExport.ts calls this with two arguments and renders a markdown
  // transcript from it; the rail must not rewrite a file that already shipped.
  it('an author-less caller gets exactly the old label back', () => {
    expect(kindLabel(m(1, { kind: 'ask', mentions: ['collab-heron'] }), shortName)).toBe('asked @heron');
    expect(kindLabel(m(1, { kind: 'handoff', mentions: ['collab-heron'] }), shortName)).toBe('handed to @heron');
    expect(kindLabel(m(1, { kind: 'task_done' }), shortName)).toBe('finished a task');
  });
});
