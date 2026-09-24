// The phone's frame sequence marks. Each of these is a way a REFRESH stops
// working: the reloaded shell's hello is dropped as a replay, or the relay
// replays its ring on top of the fresh hydration.
import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCK, SeqCounter, forgetSeq, localSeqStore } from './seq';

const RID = 'room-1';
const KEY = `origami-remote/seq/${RID}`;

beforeEach(() => window.localStorage.clear());

describe('localSeqStore — a page load claims a block', () => {
  it('the second load starts above everything the first could send', () => {
    const first = localSeqStore(RID);
    expect(first.startOut).toBe(0);
    const second = localSeqStore(RID);
    expect(second.startOut).toBe(BLOCK);
  });

  it('resumes the inbound mark, so a reload does not ask for the whole ring', () => {
    const first = localSeqStore(RID);
    first.noteIn(31);
    expect(localSeqStore(RID).startIn).toBe(31);
  });

  it('never lets the inbound mark go backwards', () => {
    const store = localSeqStore(RID);
    store.noteIn(31);
    store.noteIn(4);
    expect(localSeqStore(RID).startIn).toBe(31);
  });

  it('tops the reservation up when a long session runs past it', () => {
    const store = localSeqStore(RID);
    for (let seq = 1; seq <= BLOCK + 5; seq++) store.noteOut(seq);
    expect(localSeqStore(RID).startOut).toBeGreaterThan(BLOCK + 5);
  });

  it('is scoped per pairing', () => {
    localSeqStore(RID).noteIn(9);
    expect(localSeqStore('room-2').startIn).toBe(0);
  });
});

describe('storage that will not cooperate', () => {
  it('reads a corrupt record as absent instead of throwing', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(localSeqStore(RID).startOut).toBe(0);
  });

  it('reads a well-formed but wrong-shaped record as absent', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ out: 'many', in: 2 }));
    expect(localSeqStore(RID).startIn).toBe(0);
  });

  it('SAYS SO when a write is refused, instead of swallowing it', () => {
    // The swallowed setItem is how a phone gets wedged: the marks are gone on
    // the next load, the hello goes out at seq 1, and the desktop drops it.
    const reasons: string[] = [];
    const win = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
      },
    } as unknown as Window;
    const store = localSeqStore(RID, win, (why) => void reasons.push(why));
    expect(reasons).toEqual(['QuotaExceededError']);
    store.noteIn(4);
    expect(reasons).toHaveLength(2);
  });

  it('reports `fresh` for a device with no usable marks, and not for one with them', () => {
    expect(localSeqStore(RID).fresh).toBe(true);
    // The first load reserved a block, so the second is NOT starting at seq 1.
    expect(localSeqStore(RID).fresh).toBe(false);
    // A corrupt record is the same position as no record: this page sends 1.
    window.localStorage.setItem(KEY, '{not json');
    expect(localSeqStore(RID).fresh).toBe(true);
  });

  it('boots on a private-mode window where every write throws', () => {
    // Losing the marks costs one rejected handshake; a throw costs the shell.
    const win = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    } as unknown as Window;
    const store = localSeqStore(RID, win);
    expect(store.startOut).toBe(0);
    expect(() => store.noteOut(1)).not.toThrow();
    expect(() => forgetSeq(RID, win)).not.toThrow();
  });
});

describe('SeqCounter', () => {
  it('carries on from the store rather than from 1', () => {
    const counter = new SeqCounter({ startOut: 40, startIn: 12, fresh: false, noteOut: () => {}, noteIn: () => {} });
    expect(counter.next()).toBe(41);
    expect(counter.after).toBe(12);
    // The desktop's frame 12 has already been handled by an earlier page load.
    expect(counter.accept(12)).toBe(false);
    expect(counter.accept(13)).toBe(true);
    expect(counter.after).toBe(13);
  });

  it('starts at zero with no store, which is right for a NEW pairing only', () => {
    const counter = new SeqCounter();
    expect(counter.next()).toBe(1);
    expect(counter.accept(1)).toBe(true);
    expect(counter.accept(1)).toBe(false);
  });

  it('tells the store every outbound seq and every accepted inbound one', () => {
    const out: number[] = [];
    const seen: number[] = [];
    const counter = new SeqCounter({
      startOut: 0,
      startIn: 0,
      fresh: true,
      noteOut: (n) => void out.push(n),
      noteIn: (n) => void seen.push(n),
    });
    counter.next();
    counter.next();
    counter.accept(5);
    counter.accept(2); // replay — not recorded
    expect(out).toEqual([1, 2]);
    expect(seen).toEqual([5]);
  });
});

describe('forgetSeq', () => {
  it('drops the marks a revoked pairing left behind', () => {
    localSeqStore(RID).noteIn(9);
    forgetSeq(RID);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});
