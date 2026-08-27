// collabWaiting — what the room is still BLOCKED on (report 2.3).
//
// An `ask` that nobody has answered is the room waiting, and until now the only
// trace of it was a bubble scrolled off the top of a long transcript. The typed
// kinds and the mentions were already stored per message; this reads the pairing
// back out of them, with no state and no guesswork.
import { describe, expect, it } from 'vitest';
import type { CollabMessage } from '../../src/acpExtTypes';
import { openAsks } from './collabWaiting';

const m = (seq: number, over: Partial<CollabMessage> = {}): CollabMessage => ({
  seq,
  authorId: 'collab-crane',
  authorKind: 'agent',
  text: `message ${seq}`,
  createdAt: '2026-08-05T10:00:00.000Z',
  ...over,
});

// The standing "waiting on…" line. An ask that nobody has answered is the room
// being BLOCKED, and until now the only trace of it was a bubble scrolled off
// the top of the transcript.
describe('openAsks — who the room is still waiting on', () => {
  it('an ask with no answer yet is open', () => {
    expect(openAsks([m(1, { kind: 'ask', mentions: ['collab-heron'] })]))
      .toEqual([{ seq: 1, from: 'collab-crane', to: 'collab-heron' }]);
  });

  it('the target ANSWERING closes it', () => {
    const msgs = [
      m(1, { kind: 'ask', mentions: ['collab-heron'] }),
      m(2, { kind: 'answer', authorId: 'collab-heron' }),
    ];
    expect(openAsks(msgs)).toEqual([]);
  });

  // Somebody else answering is not the answer that was asked for.
  it('an answer from a THIRD agent leaves the ask open', () => {
    const msgs = [
      m(1, { kind: 'ask', mentions: ['collab-heron'] }),
      m(2, { kind: 'answer', authorId: 'collab-fox' }),
    ];
    expect(openAsks(msgs)).toHaveLength(1);
  });

  // Order matters: an answer that came BEFORE the question answered a different one.
  it('an earlier answer does not close a later ask', () => {
    const msgs = [
      m(1, { kind: 'answer', authorId: 'collab-heron' }),
      m(2, { kind: 'ask', mentions: ['collab-heron'] }),
    ];
    expect(openAsks(msgs)).toEqual([{ seq: 2, from: 'collab-crane', to: 'collab-heron' }]);
  });

  it('nested asks are all reported, oldest first — that IS the chain', () => {
    const msgs = [
      m(1, { kind: 'ask', mentions: ['collab-heron'] }),
      m(2, { kind: 'ask', authorId: 'collab-heron', mentions: ['collab-fox'] }),
    ];
    expect(openAsks(msgs).map((a) => a.to)).toEqual(['collab-heron', 'collab-fox']);
  });

  it('an ask with no target is not a wait — nobody was named', () => {
    expect(openAsks([m(1, { kind: 'ask' })])).toEqual([]);
  });

  it('a stream with no asks at all waits on nobody', () => {
    expect(openAsks([m(1), m(2, { kind: 'task_done' })])).toEqual([]);
  });
});
