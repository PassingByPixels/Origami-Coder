// The ownership rules behind the question modal, tested without a render.
//
// questionOwnership.test.ts drives the real ChatPane and covers what the owner
// sees on the tab strip. These cover the cases a two-tab render cannot reach:
// the GRID (every cell on screen at once), the host's REPLAY of a buffered ask,
// and the exact wire shape each outcome posts.

import { describe, it, expect } from 'vitest';
import {
  openAsk,
  closeAsk,
  visibleAsk,
  answerPost,
  cancelPost,
  type QuestionAsks,
} from '../panes/questionAsks';

const OPTIONS = [
  { optionId: '0', name: 'Rebuild', kind: 'allow_once' },
  { optionId: '1', name: 'Patch', kind: 'reject_once' },
];
const Q = (title: string) => ({ title, options: OPTIONS });

/** A store with A blocked on one question and B on two. */
function twoAsks(): QuestionAsks {
  return openAsk(openAsk({}, 'A', 'tc-a', [Q('A only')]), 'B', 'tc-b', [Q('B one'), Q('B two')]);
}

describe('openAsk / closeAsk — one batch per chat, and they never collide', () => {
  it('keeps both chats\' batches; the second asker does not overwrite the first', () => {
    const asks = twoAsks();
    expect(Object.keys(asks).sort()).toEqual(['A', 'B']);
    expect(asks.A.questions).toHaveLength(1);
    expect(asks.B.questions).toHaveLength(2);
  });

  it('a NEW ask on the same chat replaces the batch and starts the draft clean', () => {
    let asks = openAsk({}, 'A', 'tc-1', [Q('first')]);
    asks.A.currentIndex = 1;
    asks.A.answers = { 0: { optionId: '1', answerText: '' } };
    asks = openAsk(asks, 'A', 'tc-2', [Q('second')]);
    expect(asks.A.toolCallId).toBe('tc-2');
    expect(asks.A.currentIndex).toBe(0);
    expect(asks.A.answers).toEqual({});
  });

  it('a REPLAY of the same toolCallId RESUMES the draft (the host re-posts on mount / grid-on)', () => {
    let asks = openAsk({}, 'A', 'tc-1', [Q('first'), Q('second')]);
    asks.A.currentIndex = 1;
    asks.A.answers = { 0: { optionId: '1', answerText: 'typed' } };
    asks = openAsk(asks, 'A', 'tc-1', [Q('first'), Q('second')]);
    expect(asks.A.currentIndex).toBe(1);
    expect(asks.A.answers).toEqual({ 0: { optionId: '1', answerText: 'typed' } });
  });

  it('closeAsk removes only the named chat, and is a no-op for one with no batch', () => {
    const asks = twoAsks();
    expect(Object.keys(closeAsk(asks, 'B'))).toEqual(['A']);
    expect(closeAsk(asks, 'C')).toBe(asks);
  });
});

describe('visibleAsk — a batch shows only over its own chat', () => {
  it('is NULL when the asking chat is not on screen (the reported defect)', () => {
    expect(visibleAsk(twoAsks(), 'A', ['A'])).not.toBeNull();
    const asks = openAsk({}, 'B', 'tc-b', [Q('B one')]);
    expect(visibleAsk(asks, 'A', ['A'])).toBeNull();
  });

  it('returns the ACTIVE chat\'s batch when several chats are asking at once', () => {
    expect(visibleAsk(twoAsks(), 'B', ['B'])?.toolCallId).toBe('tc-b');
    expect(visibleAsk(twoAsks(), 'A', ['A'])?.toolCallId).toBe('tc-a');
  });

  it('in the GRID every cell is on screen, so the active cell wins but no batch is stranded', () => {
    // Active cell first...
    expect(visibleAsk(twoAsks(), 'B', ['A', 'B'])?.toolCallId).toBe('tc-b');
    // ...and when the active cell has nothing to ask, tab order decides, rather
    // than hiding a batch the engine is blocked on with no modal anywhere.
    const onlyB = openAsk({}, 'B', 'tc-b', [Q('B one')]);
    expect(visibleAsk(onlyB, 'A', ['A', 'B'])?.toolCallId).toBe('tc-b');
  });

  it('ignores an active id that is not on screen (a popped-out solo tab pins its own)', () => {
    const asks = twoAsks();
    expect(visibleAsk(asks, 'A', ['B'])?.toolCallId).toBe('tc-b');
  });

  it('is NULL with no batches, and with no cells on screen', () => {
    expect(visibleAsk({}, 'A', ['A'])).toBeNull();
    expect(visibleAsk(twoAsks(), null, [])).toBeNull();
  });
});

describe('answerPost / cancelPost — the wire shape, addressed to the ASKING chat', () => {
  const ask = twoAsks().B;

  it('a one-answer reply keeps the pre-batching single-question shape (no `answers` key)', () => {
    const single = twoAsks().A;
    expect(answerPost(single, [{ optionId: '1' }])).toEqual({
      type: 'permission', toolCallId: 'tc-a', sessionId: 'A', optionId: '1',
    });
  });

  it('a batch reply carries every answer positionally, head duplicated as optionId', () => {
    expect(answerPost(ask, [{ optionId: '1' }, { optionId: '0', answerText: 'staging' }])).toEqual({
      type: 'permission', toolCallId: 'tc-b', sessionId: 'B', optionId: '1',
      answers: [{ optionId: '1' }, { optionId: '0', answerText: 'staging' }],
    });
  });

  it('the head\'s typed text rides as answerText; an absent one adds no key', () => {
    expect(answerPost(ask, [{ optionId: '0', answerText: 'my own answer' }]).answerText).toBe('my own answer');
    expect('answerText' in answerPost(ask, [{ optionId: '0', answerText: '' }])).toBe(false);
  });

  it('cancel posts optionId null to the asking chat — the engine must hear it or the turn hangs', () => {
    expect(cancelPost(ask)).toEqual({
      type: 'permission', toolCallId: 'tc-b', sessionId: 'B', optionId: null,
    });
  });
});
