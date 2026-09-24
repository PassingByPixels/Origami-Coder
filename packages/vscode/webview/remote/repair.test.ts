// WHAT THE PHONE SAYS WHEN IT CANNOT GET A FRAME PAST THE DESKTOP.
//
// The reported symptom was a blank page under a green `open` pill: the page's
// seq marks were gone, so its hello went out at seq 1 and the desktop's replay
// guard — correctly — threw it away, twice, silently. Every assertion below is
// on the SENTENCE the owner is shown, because the sentence is the whole fix;
// the guard itself is untouched (see remoteFrame.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { REPAIR_MS, REPAIR_TEXT, STORAGE_TEXT, isResetHello, openMarks, watchRepair } from './repair';
import { setNotice } from './ui';

const RID = 'room-1';

/** A device whose localStorage refuses every write, the shape private browsing
 *  and a full quota both take. */
function refusingDevice(): Window {
  return {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    },
  } as unknown as Window;
}

/** A scripted clock, so a five-second rule is asserted rather than waited for. */
function fakeTimers() {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  return {
    armed,
    setTimer: (fn: () => void, ms: number) => {
      armed.push({ fn, ms });
      return armed.length - 1;
    },
    clearTimer: (h: unknown) => void (armed[h as number] = { fn: () => {}, ms: 0 }),
    fire: () => armed.forEach((t) => t.fn()),
  };
}

function watch(opts: { pairingFresh: boolean; marksFresh: boolean }, timers = fakeTimers()) {
  const shown: string[] = [];
  const w = watchRepair({ ...opts, show: (t) => void shown.push(t), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { w, shown, timers };
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="remoteNotice"></div>';
});

describe('a pairing read out of storage whose marks are gone', () => {
  it('says so at once — before a socket is even opened', () => {
    // It does not have to wait: it KNOWS its next frame carries seq 1 and that
    // the desktop's guard is somewhere above that.
    const { shown } = watch({ pairingFresh: false, marksFresh: true });
    expect(shown).toEqual([REPAIR_TEXT]);
  });

  it('says nothing for a QR that was just scanned, which legitimately has none', () => {
    const { shown } = watch({ pairingFresh: true, marksFresh: true });
    expect(shown).toEqual([]);
  });

  it('says nothing for a page whose marks are intact', () => {
    const { shown } = watch({ pairingFresh: false, marksFresh: false });
    expect(shown).toEqual([]);
  });
});

describe('the five-second backstop', () => {
  it('speaks when the socket opened, nothing came back, and this page sends seq 1', () => {
    const { w, shown, timers } = watch({ pairingFresh: true, marksFresh: true });
    w.socketOpened();
    expect(timers.armed[0]?.ms).toBe(REPAIR_MS);
    expect(shown).toEqual([]);
    timers.fire();
    expect(shown).toEqual([REPAIR_TEXT]);
  });

  it('stays quiet once ANY message has come back', () => {
    const { w, shown, timers } = watch({ pairingFresh: true, marksFresh: true });
    w.socketOpened();
    w.messageSeen({ type: 'sessionCreated' });
    timers.fire();
    expect(shown).toEqual([]);
  });

  it('is not armed at all for a page whose marks are intact', () => {
    // Otherwise a healthy phone waiting on a desktop that is merely busy — or
    // not attached — would be told to re-pair, which is a wrong diagnosis.
    const { w, timers } = watch({ pairingFresh: false, marksFresh: false });
    w.socketOpened();
    expect(timers.armed).toEqual([]);
  });
});

describe("the desktop's `reset` hello", () => {
  it('is recognised, and a plain hello is not', () => {
    expect(isResetHello({ type: 'remote/hello', v: 1, device: 'Cortex', reset: true })).toBe(true);
    expect(isResetHello({ type: 'remote/hello', v: 1, device: 'Cortex' })).toBe(false);
    expect(isResetHello({ type: 'sessionCreated' })).toBe(false);
    expect(isResetHello(null)).toBe(false);
  });

  it('makes the phone say the same sentence, even though a message DID arrive', () => {
    const { w, shown } = watch({ pairingFresh: true, marksFresh: false });
    w.messageSeen({ type: 'remote/hello', v: 1, device: 'Cortex', reset: true });
    expect(shown).toEqual([REPAIR_TEXT]);
  });

  it('is said once, not once per reconnect', () => {
    const { w, shown } = watch({ pairingFresh: true, marksFresh: false });
    w.messageSeen({ type: 'remote/hello', reset: true });
    w.messageSeen({ type: 'remote/hello', reset: true });
    expect(shown).toEqual([REPAIR_TEXT]);
  });
});

describe('a device that cannot save its marks — the page shows the warning', () => {
  it('paints the storage warning into the real notice strip when setItem throws', () => {
    const { seq } = openMarks(RID, true, (text) => setNotice(document, text), refusingDevice());
    const el = document.getElementById('remoteNotice')!;
    expect(el.textContent).toBe(STORAGE_TEXT);
    expect(el.getAttribute('data-open')).toBe('true');
    // ...and the shell still booted: a page that refuses to start is worse.
    expect(seq.startOut).toBe(0);
  });

  it('reports a failure raised DURING construction, which is the one that matters', () => {
    // The first write happens inside localSeqStore, before the watch exists.
    // Buffering it is the difference between a warning and silence.
    const { repair } = openMarks(RID, true, () => {}, refusingDevice());
    expect(repair.shown).toEqual([STORAGE_TEXT]);
  });

  it('says nothing on a device that can save', () => {
    const { repair } = openMarks(RID, true, (text) => setNotice(document, text));
    expect(repair.shown).toEqual([]);
    expect(document.getElementById('remoteNotice')!.getAttribute('data-open')).toBeNull();
  });

  it('a stored pairing on a device with no marks gets the re-pair sentence, not the storage one', () => {
    const { repair } = openMarks(RID, false, (text) => setNotice(document, text));
    expect(repair.shown).toEqual([REPAIR_TEXT]);
    expect(document.getElementById('remoteNotice')!.textContent).toBe(REPAIR_TEXT);
  });
});
