import { beforeEach, describe, expect, it } from 'vitest';
import { b64urlEncode, deriveRid } from './crypto';
import { forgetPairing, loadPairing, parseFragment, scrubFragment, socketUrl } from './pairing';

const KS = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);
const KS_B64 = b64urlEncode(KS);

/** A minimal Window stand-in: jsdom cannot navigate, so the fragment and the
 *  replaceState call are modelled directly rather than faked through history. */
function makeWindow(hash: string, path = '/app/', search = '') {
  const store = new Map<string, string>();
  const replaced: string[] = [];
  const win = {
    location: { hash, pathname: path, search, origin: 'https://relay.example' },
    history: {
      replaceState(_s: unknown, _t: string, url: string) {
        replaced.push(url);
        win.location.hash = '';
      },
    },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return { win: win as unknown as Window, store, replaced };
}

let RID = '';
beforeEach(async () => {
  RID = await deriveRid(KS);
});

describe('parseFragment', () => {
  it('parses the v1 fragment the QR encodes', () => {
    const got = parseFragment(`#v1.${RID}.${KS_B64}`);
    expect(got?.rid).toBe(RID);
    expect([...(got?.ks ?? [])]).toEqual([...KS]);
    expect(got?.lanUrl).toBeUndefined();
  });

  it('parses the optional LAN url the spec reserves', () => {
    const lan = b64urlEncode(new TextEncoder().encode('https://192.168.1.9:8443'));
    expect(parseFragment(`#v1.${RID}.${KS_B64}.${lan}`)?.lanUrl).toBe('https://192.168.1.9:8443');
  });

  it('accepts a fragment with no leading hash (the value history gives back)', () => {
    expect(parseFragment(`v1.${RID}.${KS_B64}`)?.rid).toBe(RID);
  });

  it.each([
    ['empty', ''],
    ['bare hash', '#'],
    ['a router hash', '#/chat/1'],
    ['a future version', `#v2.${RID}.${KS_B64}`],
    ['too few parts', `#v1.${RID}`],
    ['too many parts', `#v1.${RID}.${KS_B64}.a.b`],
    ['an empty rid', `#v1..${KS_B64}`],
    ['a truncated secret', `#v1.${'r'.repeat(22)}.${b64urlEncode(new Uint8Array(16))}`],
    ['an oversized secret', `#v1.${'r'.repeat(22)}.${b64urlEncode(new Uint8Array(64))}`],
  ])('returns undefined for %s', (_label, hash) => {
    expect(parseFragment(hash)).toBeUndefined();
  });

  it('returns undefined rather than throwing on undecodable base64', () => {
    expect(parseFragment('#v1.rid.!!!!not base64!!!!')).toBeUndefined();
  });
});

describe('loadPairing', () => {
  it('stores Ks keyed by rid and scrubs the fragment out of the URL', async () => {
    const { win, store, replaced } = makeWindow(`#v1.${RID}.${KS_B64}`, '/app/');
    const p = await loadPairing(win);
    expect(p?.rid).toBe(RID);
    expect(p?.fresh).toBe(true);
    expect(store.get(`origami-remote/ks/${RID}`)).toBe(KS_B64);
    expect(store.get('origami-remote/last-rid')).toBe(RID);
    // The secret must survive exactly one trip through the address bar.
    expect(replaced).toEqual(['/app/']);
    expect(win.location.hash).toBe('');
  });

  it('keeps the query string when it scrubs the fragment', async () => {
    const { win, replaced } = makeWindow(`#v1.${RID}.${KS_B64}`, '/app/', '?debug=1');
    await loadPairing(win);
    expect(replaced).toEqual(['/app/?debug=1']);
  });

  it('resumes from storage on a reload with no fragment', async () => {
    const { win, store } = makeWindow('');
    store.set(`origami-remote/ks/${RID}`, KS_B64);
    store.set('origami-remote/last-rid', RID);
    const p = await loadPairing(win);
    expect(p?.rid).toBe(RID);
    expect(p?.fresh).toBe(false);
    expect([...(p?.ks ?? [])]).toEqual([...KS]);
  });

  it('returns undefined when nothing is stored and nothing is in the URL', async () => {
    expect(await loadPairing(makeWindow('').win)).toBeUndefined();
  });

  it('returns undefined when the pointer survives but the secret does not', async () => {
    const { win, store } = makeWindow('');
    store.set('origami-remote/last-rid', RID);
    expect(await loadPairing(win)).toBeUndefined();
  });

  it('returns undefined for a stored secret of the wrong length', async () => {
    const { win, store } = makeWindow('');
    store.set(`origami-remote/ks/${RID}`, b64urlEncode(new Uint8Array(8)));
    store.set('origami-remote/last-rid', RID);
    expect(await loadPairing(win)).toBeUndefined();
  });

  it('trusts the QR rid over the derived one, but still pairs', async () => {
    // The rid the desktop PUT in the QR is the room the relay knows. Deriving
    // is only a cross-check; a mismatch must warn, not refuse to pair.
    const { win } = makeWindow(`#v1.notTheDerivedRid.${KS_B64}`);
    expect((await loadPairing(win))?.rid).toBe('notTheDerivedRid');
  });
});

describe('forgetPairing', () => {
  it('drops both the secret and the pointer', async () => {
    const { win, store } = makeWindow('');
    store.set(`origami-remote/ks/${RID}`, KS_B64);
    store.set('origami-remote/last-rid', RID);
    forgetPairing(RID, win);
    expect(store.size).toBe(0);
    expect(await loadPairing(win)).toBeUndefined();
  });

  it('leaves another room’s pointer alone', () => {
    const { win, store } = makeWindow('');
    store.set(`origami-remote/ks/${RID}`, KS_B64);
    store.set('origami-remote/last-rid', 'other');
    forgetPairing(RID, win);
    expect(store.get('origami-remote/last-rid')).toBe('other');
  });
});

describe('scrubFragment', () => {
  it('replaces rather than pushes, so Back cannot restore the secret', () => {
    const { win, replaced } = makeWindow('#v1.a.b', '/app/');
    scrubFragment(win);
    expect(replaced).toEqual(['/app/']);
  });
});

describe('socketUrl', () => {
  it('upgrades the page origin to wss and carries role + after', () => {
    expect(socketUrl('https://relay.example', 'r1', 0)).toBe('wss://relay.example/r/r1?role=phone&after=0');
  });

  it('upgrades a plain-http origin to ws (the LAN case)', () => {
    expect(socketUrl('http://192.168.1.9:8443/', 'r1', 12)).toBe('ws://192.168.1.9:8443/r/r1?role=phone&after=12');
  });

  it('escapes a rid so base64url stays intact in the path', () => {
    expect(socketUrl('https://x', 'a-b_c', 3)).toBe('wss://x/r/a-b_c?role=phone&after=3');
  });

  // A native shell has no `location.origin` worth trusting and can set this
  // global before the bundle runs; a plain browser never defines it.
  it('falls back to globalThis.__ORIGAMI_RELAY__ when no base is given', () => {
    (globalThis as { __ORIGAMI_RELAY__?: string }).__ORIGAMI_RELAY__ = 'https://relay.example';
    try {
      expect(socketUrl('', 'r1', 0)).toBe('wss://relay.example/r/r1?role=phone&after=0');
    } finally {
      delete (globalThis as { __ORIGAMI_RELAY__?: string }).__ORIGAMI_RELAY__;
    }
  });

  it('falls back to location.origin when neither base nor the global is set (unchanged browser behaviour)', () => {
    expect((globalThis as { __ORIGAMI_RELAY__?: string }).__ORIGAMI_RELAY__).toBeUndefined();
    const want = location.origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    expect(socketUrl('', 'r1', 0)).toBe(`${want}/r/r1?role=phone&after=0`);
  });
});
