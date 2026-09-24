// The phone's sequence numbers survive a reload.
//
// Same rule as the desktop's `src/remote/seqStore.ts`, other end: `seq` is
// per sender per pairing, not per tab. A refresh starts a new transport at
// seq 1, so the desktop's replay guard — still at the old count — would
// drop the reloaded shell's `remote/hello` and `remote/snapshot`.
// `?after=` stops the relay replaying its whole ring on top of the fresh
// hydration. Stored in localStorage, keyed by rid, beside the pairing
// secret: per device, per pairing, and must outlive `Ks`.

const SEQ_PREFIX = 'origami-remote/seq/';

export interface SeqMarks {
  out: number;
  in: number;
}

/** Frames claimed per page load. A reload takes the whole block whether
 *  used or not: a gap is legal, a repeat is what the guard rejects. */
export const BLOCK = 512;

export interface SeqStore {
  /** The seq to carry on FROM: the first frame sent is this plus one. */
  readonly startOut: number;
  /** The highest seq accepted from the desktop by any earlier page load. */
  readonly startIn: number;
/** True when this device has no usable marks for the rid (fresh start at
 *  seq 1). Normal after a QR scan; from stored state it means marks were lost. */
  readonly fresh: boolean;
  noteOut(seq: number): void;
  noteIn(seq: number): void;
}

function read(win: Window, key: string): SeqMarks {
  try {
    const raw = win.localStorage.getItem(key);
    if (!raw) return { out: 0, in: 0 };
    const parsed = JSON.parse(raw) as Partial<SeqMarks> | null;
    // A malformed record is ABSENT, not repaired — see the desktop's note.
    if (!parsed || typeof parsed.out !== 'number' || typeof parsed.in !== 'number') return { out: 0, in: 0 };
    if (parsed.out < 0 || parsed.in < 0) return { out: 0, in: 0 };
    return { out: parsed.out, in: parsed.in };
  } catch {
    return { out: 0, in: 0 };
  }
}

/** Say so: a swallowed `setItem` wedges the phone silently on both ends.
 *  The shell still boots, but the failure is now reported. */
function write(win: Window, key: string, marks: SeqMarks, onFail?: (why: string) => void): void {
  try {
    win.localStorage.setItem(key, JSON.stringify(marks));
  } catch (e) {
    onFail?.((e as Error)?.message || 'localStorage refused the write');
  }
}

/** Marks for one pairing, reserved at construction so a page that
 *  crashes between reserving and sending still can't reuse a number. */
export function localSeqStore(rid: string, win: Window = window, onFail?: (why: string) => void): SeqStore {
  const key = SEQ_PREFIX + rid;
  const marks = read(win, key);
  const startOut = marks.out;
  let reserved = startOut + BLOCK;
  let lastIn = marks.in;
  write(win, key, { out: reserved, in: lastIn }, onFail);
  return {
    startOut,
    startIn: marks.in,
    // No record, an unreadable one and a malformed one all put this page at
    // seq 1, which is the only thing the caller has to act on.
    fresh: startOut === 0 && marks.in === 0,
    noteOut(seq) {
      if (seq < reserved) return;
      reserved = seq + BLOCK;
      write(win, key, { out: reserved, in: lastIn }, onFail);
    },
    // Written on every accepted frame: a lagging inbound mark makes the
    // next load replay frames it already had, landing deltas in front of
    // fresh hydration — a ~40-byte write is cheaper than that redecode.
    noteIn(seq) {
      if (seq <= lastIn) return;
      lastIn = seq;
      write(win, key, { out: reserved, in: lastIn }, onFail);
    },
  };
}

/** Revoke rotates the pairing, so its marks go with it. */
export function forgetSeq(rid: string, win: Window = window): void {
  try {
    win.localStorage.removeItem(SEQ_PREFIX + rid);
  } catch {
    /* nothing to forget is the outcome we wanted */
  }
}

/** Both counters for one live socket, so "resume, and persist as you go"
 *  is stated once rather than split across two numbers. */
export class SeqCounter {
  private out: number;
  private highWater: number;

  constructor(private readonly store?: SeqStore) {
    this.out = store?.startOut ?? 0;
    this.highWater = store?.startIn ?? 0;
  }

  /** The next outbound seq. */
  public next(): number {
    this.out += 1;
    this.store?.noteOut(this.out);
    return this.out;
  }

  /** True when `seq` is genuinely new. A repeat is a relay ring replay as
   *  often as it is an attack, and both are dropped. */
  public accept(seq: number): boolean {
    if (seq <= this.highWater) return false;
    this.highWater = seq;
    this.store?.noteIn(seq);
    return true;
  }

  /** The relay's `?after=` value. */
  public get after(): number {
    return this.highWater;
  }
}
