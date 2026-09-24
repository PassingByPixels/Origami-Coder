// Origami Remote — THE PHONE SAYS WHAT WENT WRONG.
//
// Three ways one pairing ends up wedged. All three had the same symptom — a
// blank page under a green `open` pill — and none of them said anything:
//
//   1. the device cannot PERSIST its seq marks (private browsing, a full quota,
//      a Safari ITP eviction between two loads), so the next load starts at 1;
//   2. the device has a stored pairing but NO usable marks for it, so THIS load
//      starts at 1 and the desktop's replay guard drops every frame it sends;
//   3. the desktop saw (1) or (2) first and answered with a hello carrying
//      `reset: true`.
//
// A page that has just scanned a QR is NOT case 2 — a new pairing legitimately
// has no marks — which is why this takes `pairingFresh` rather than guessing.
//
// The backstop is a TIMER: the socket is up, hello and snapshot went out, and
// nothing at all came back inside REPAIR_MS. It is armed ONLY when this page
// starts at seq 1, so a healthy phone waiting on a slow desktop is never told
// to re-pair. The recovery is the same in every case, so there is one sentence.

export const REPAIR_TEXT = 'This phone lost its pairing state — scan the QR code again.';
export const STORAGE_TEXT =
  'This phone cannot save its pairing state. Private browsing or a full disk will lose the chat after a reload.';
/** The ticket's own number: the owner must not sit in front of a blank page
 *  for longer than this without being told what to do. */
export const REPAIR_MS = 5_000;

/** The desktop's half of case 3. `reset` is a field an older phone page simply
 *  does not read, which is what makes it safe to add to `remote/hello`. */
export function isResetHello(msg: unknown): boolean {
  const m = msg as { type?: unknown; reset?: unknown } | null;
  return !!m && m.type === 'remote/hello' && m.reset === true;
}

import { localSeqStore, type SeqStore } from './seq';

export interface RepairWatchOptions {
  /** True when the pairing arrived in the URL fragment on THIS load. */
  pairingFresh: boolean;
  /** True when the device holds no usable seq marks — this page sends seq 1. */
  marksFresh: boolean;
  /** Paint one sentence. Called with the same text at most once. */
  show: (text: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  ms?: number;
}

export interface RepairWatch {
  /** Every open of the socket: (re)arms the backstop. */
  socketOpened(): void;
  /** Every message the transport accepted. Disarms the backstop, and carries
   *  case 3 — the desktop's `reset` hello. */
  messageSeen(msg: unknown): void;
  /** A `localStorage` write the device refused. */
  storageFailed(why: string): void;
  /** What has been shown, in order. The page's own record, and what the tests
   *  assert on rather than the DOM they do not own. */
  readonly shown: readonly string[];
}

export function watchRepair(opts: RepairWatchOptions): RepairWatch {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ms = opts.ms ?? REPAIR_MS;
  const shown: string[] = [];
  let timer: unknown = null;
  let answered = false;

  const say = (text: string): void => {
    if (shown.includes(text)) return;
    shown.push(text);
    opts.show(text);
  };
  const disarm = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  // CASE 2, and it needs no wire at all: a pairing read out of storage whose
  // marks are gone cannot get a frame past the desktop, and the page knows that
  // before it opens a socket. Saying so at once is the difference between five
  // seconds of confusion and none.
  if (!opts.pairingFresh && opts.marksFresh) say(REPAIR_TEXT);

  return {
    shown,
    socketOpened() {
      if (!opts.marksFresh || answered) return;
      disarm();
      timer = setTimer(() => {
        timer = null;
        if (!answered) say(REPAIR_TEXT);
      }, ms);
    },
    messageSeen(msg) {
      answered = true;
      disarm();
      if (isResetHello(msg)) say(REPAIR_TEXT);
    },
    storageFailed(why) {
      console.warn('[remote] could not persist the pairing marks:', why);
      say(STORAGE_TEXT);
    },
  };
}

export interface RepairSetup {
  seq: SeqStore;
  repair: RepairWatch;
}

/**
 * The page's seq store AND the watch over it, built together because the two
 * are circular: whether the store found any marks is what the watch is built
 * from, and the store's persist failures are what the watch reports. A failure
 * during construction — the first write, and the one that matters most — is
 * buffered rather than lost to the ordering.
 */
export function openMarks(
  rid: string,
  pairingFresh: boolean,
  show: (text: string) => void,
  win: Window = window,
): RepairSetup {
  const early: string[] = [];
  let sink = (why: string): void => void early.push(why);
  const seq = localSeqStore(rid, win, (why) => sink(why));
  const repair = watchRepair({ pairingFresh, marksFresh: seq.fresh, show });
  sink = (why) => repair.storageFailed(why);
  for (const why of early) repair.storageFailed(why);
  return { seq, repair };
}
