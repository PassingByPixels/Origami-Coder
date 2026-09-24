// The desktop's frame sequence marks. The defect surface is small and each of
// these is a way the phone goes blank if it is wrong:
//   - two windows must never hand the phone the same seq twice,
//   - a mark from a build that wrote something else must not be trusted,
//   - a window with no globalState must still be able to send.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCK,
  SEQ_KEY,
  desktopCodec,
  forgetSeq,
  marksFor,
  noteIn,
  noteOut,
  registerRemoteSeq,
  reserveOut,
  resetRemoteSeq,
  type SeqMemento,
} from '../../../src/remote/seqStore';

const RID = 'room-1';

function machine(): { memento: SeqMemento; raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    memento: {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key, value) => Promise.resolve(void raw.set(key, value)),
    },
  };
}

afterEach(resetRemoteSeq);

describe('reserveOut — one block per window open', () => {
  it('hands the second window a base above everything the first can send', () => {
    registerRemoteSeq(machine().memento);
    const first = reserveOut(RID);
    const second = reserveOut(RID);
    expect(first).toBe(0);
    // The first window can send BLOCK frames (1..BLOCK) before it writes again;
    // the second starts where that ends. Overlap here is the blank phone.
    expect(second).toBe(BLOCK);
    expect(second).toBeGreaterThanOrEqual(first + BLOCK);
  });

  it('writes rarely: one Memento write per block, not per frame', () => {
    const m = machine();
    let writes = 0;
    registerRemoteSeq({
      get: m.memento.get,
      update: (k, v) => {
        writes++;
        return m.memento.update(k, v);
      },
    });
    const base = reserveOut(RID);
    writes = 0;
    for (let seq = base + 1; seq <= base + BLOCK - 1; seq++) noteOut(RID, seq);
    expect(writes).toBe(0);
    noteOut(RID, base + BLOCK);
    expect(writes).toBe(1);
    // ...and the next window still starts above what this one reached.
    expect(reserveOut(RID)).toBeGreaterThan(base + BLOCK);
  });
});

describe('noteIn — the peer high-water mark', () => {
  it('advances, and never goes backwards', () => {
    registerRemoteSeq(machine().memento);
    noteIn(RID, 7);
    expect(marksFor(RID).in).toBe(7);
    noteIn(RID, 3);
    expect(marksFor(RID).in).toBe(7);
  });

  it('is what stops a new window re-running the phone messages in the ring', () => {
    // `?after=` comes from the codec's inbound guard, which is seeded from
    // here. Seeded with 0, the relay replays every prompt the phone sent in
    // the last ten minutes and the window obeys them all again.
    registerRemoteSeq(machine().memento);
    noteIn(RID, 42);
    const codec = desktopCodec({} as never, RID);
    expect(codec.afterSeq).toBe(42);
  });
});

describe('a store that cannot be trusted', () => {
  it('treats a malformed record as absent rather than repairing it', () => {
    const m = machine();
    m.raw.set(SEQ_KEY, { [RID]: { out: 'lots', in: null }, other: 5 });
    registerRemoteSeq(m.memento);
    expect(marksFor(RID)).toEqual({ out: 0, in: 0 });
  });

  it('ignores a negative mark, which no writer of ours produces', () => {
    const m = machine();
    m.raw.set(SEQ_KEY, { [RID]: { out: -1, in: -9 } });
    registerRemoteSeq(m.memento);
    expect(marksFor(RID)).toEqual({ out: 0, in: 0 });
  });

  it('FAILS OPEN with no store at all: a window with no globalState can send', () => {
    // Refusing here would leave Remote dead in every window on the machine.
    // The cost is the pre-lease behaviour: a hand-over the phone cannot follow.
    expect(marksFor(RID)).toEqual({ out: 0, in: 0 });
    expect(reserveOut(RID)).toBe(0);
    expect(() => noteOut(RID, 1)).not.toThrow();
  });
});

describe('forgetSeq', () => {
  it('drops the marks for a revoked pairing and leaves the others alone', () => {
    registerRemoteSeq(machine().memento);
    reserveOut(RID);
    noteIn('room-2', 5);
    forgetSeq(RID);
    expect(marksFor(RID)).toEqual({ out: 0, in: 0 });
    expect(marksFor('room-2').in).toBe(5);
  });

  it('is a no-op for a null rid, which is what an unpaired window has', () => {
    registerRemoteSeq(machine().memento);
    expect(() => forgetSeq(null)).not.toThrow();
  });
});
