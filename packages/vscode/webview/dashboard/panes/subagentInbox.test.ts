// The sub-agent side channel's landing rules (subagentInbox.ts) — the half of
// the drawer nobody can see: where a forwarded chunk goes, what caps it, and
// what a DROP is allowed to cost. Pure, so none of it needs a render.

import { describe, expect, it } from 'vitest';
import {
  cappedStream,
  cardForChild,
  childId,
  makeDropLog,
  DROP_LOG_EVERY,
  SUBAGENT_STREAM_CAP,
  type SubagentCard,
} from './subagentInbox';

const cards: SubagentCard[] = [
  { taskSessionId: 'ses_a', taskStream: 'a output' },
  { taskSessionId: 'ses_b' },
  {},
];

describe('subagentInbox — which card a side-channel event lands on', () => {
  it('finds the card that spawned the child', () => {
    expect(cardForChild(cards, 'ses_b')).toBe(cards[1]);
  });

  it('an untagged event lands nowhere rather than on the first card without an id', () => {
    // The card with no taskSessionId is a task whose child session does not
    // exist yet. Matching `undefined === ''` would park a stranger's output on
    // whichever spawn happened to still be anonymous.
    expect(childId(undefined)).toBe('');
    expect(cardForChild(cards, childId(undefined))).toBeUndefined();
    expect(cardForChild(cards, childId(42))).toBeUndefined();
  });

  it('a chunk for a child this chat never launched lands nowhere', () => {
    expect(cardForChild(cards, 'ses_someone_else')).toBeUndefined();
  });
});

describe('subagentInbox — the stream budget', () => {
  it('appends while under the cap', () => {
    expect(cappedStream('one\n', 'two\n')).toBe('one\ntwo\n');
    expect(cappedStream(undefined, 'first')).toBe('first');
  });

  it('keeps the TAIL once the cap is passed — what it is doing NOW', () => {
    const streamed = cappedStream('x'.repeat(SUBAGENT_STREAM_CAP), 'LATEST');
    expect(streamed.length).toBe(SUBAGENT_STREAM_CAP);
    expect(streamed.endsWith('LATEST')).toBe(true);
    expect(streamed.startsWith('x')).toBe(true);
  });
});

describe('subagentInbox — a drop is counted and said out loud', () => {
  it('reports the FIRST drop for a child, then only every DROP_LOG_EVERY-th', () => {
    const log = makeDropLog();
    const lines: string[] = [];
    for (let index = 0; index < DROP_LOG_EVERY; index++) {
      const line = log('chunk', 'ses_ghost');
      if (line) lines.push(line);
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('ses_ghost');
    expect(lines[0]).toContain('(1 so far)');
    expect(lines[1]).toContain(`(${DROP_LOG_EVERY} so far)`);
  });

  it('counts per kind and per child — a lost `done` marker never hides behind chunk noise', () => {
    // A dropped `done` is a drawer row that never retires, so it must not be
    // folded into a count some chatty child already ran up.
    const log = makeDropLog();
    log('chunk', 'ses_ghost');
    log('chunk', 'ses_ghost');
    expect(log('done', 'ses_ghost')).toContain('(1 so far)');
    expect(log('chunk', 'ses_other')).toContain('(1 so far)');
  });

  it('names an untagged event rather than printing an empty id', () => {
    expect(makeDropLog()('chunk', '')).toContain('(untagged)');
  });

  it('each pane counts its own drops — no module-level state to reset', () => {
    expect(makeDropLog()('chunk', 'ses_ghost')).toContain('(1 so far)');
    expect(makeDropLog()('chunk', 'ses_ghost')).toContain('(1 so far)');
  });
});
