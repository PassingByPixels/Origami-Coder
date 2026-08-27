// The rewind walk-back, extracted from ChatPane so it can be asserted without a
// render. The bug this rule exists to prevent is a transcript that disagrees
// with the engine: `revert` resolves to the last USER message, so cutting from
// the agent row the button sits on would leave the question stranded above a
// turn the engine has already deleted.

import { describe, it, expect } from 'vitest';
import { rewindSlice } from './rewindSlice';

const transcript = [
  { kind: 'system', engineMsgId: undefined },
  { kind: 'user', engineMsgId: undefined },
  { kind: 'tool', engineMsgId: undefined },
  { kind: 'agent', engineMsgId: 'm1' },
  { kind: 'user', engineMsgId: undefined },
  { kind: 'thought', engineMsgId: undefined },
  { kind: 'agent', engineMsgId: 'm2' },
];

describe('rewindSlice', () => {
  it('cuts from the user message that OPENED the named turn, not from the agent row', () => {
    const cut = rewindSlice(transcript, 'm2')!;
    expect(cut.keep.map((m) => m.kind)).toEqual(['system', 'user', 'tool', 'agent']);
    expect(cut.removed.map((m) => m.kind)).toEqual(['user', 'thought', 'agent']);
  });

  it('rewinding to an EARLIER turn drops that turn and everything after it', () => {
    const cut = rewindSlice(transcript, 'm1')!;
    expect(cut.keep.map((m) => m.kind), 'only the scaffolding before it survives').toEqual(['system']);
    // Its own tool call goes, and so does the whole later turn — the engine
    // reverts to a point in time, not to one exchange.
    expect(cut.removed.map((m) => m.kind)).toEqual(['user', 'tool', 'agent', 'user', 'thought', 'agent']);
  });

  it('is a no-op for an id no agent row carries — never an empty-slice wipe', () => {
    expect(rewindSlice(transcript, 'nope')).toBeNull();
    expect(rewindSlice([], 'm1')).toBeNull();
  });

  it('will not rewind to a NON-agent row that happens to share the id', () => {
    expect(rewindSlice([{ kind: 'user', engineMsgId: 'm1' }], 'm1')).toBeNull();
  });

  it('keeps nothing when the turn opens the transcript', () => {
    const cut = rewindSlice([{ kind: 'user', engineMsgId: undefined }, { kind: 'agent', engineMsgId: 'm1' }], 'm1')!;
    expect(cut.keep).toEqual([]);
    expect(cut.removed).toHaveLength(2);
  });
});
