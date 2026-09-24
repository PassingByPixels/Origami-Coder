// webview/remote/native.ts — the iOS shell bridge, and THE ONE CLAIM THAT
// MATTERS TO EVERY EXISTING USER: with `globalThis.__ORIGAMI_NATIVE__`
// undefined, the relay-served browser page behaves exactly as it did before.
//
// The shell branch is exercised too, against a fake bridge, because "inert in a
// browser" is only half the contract — a branch that never runs anywhere would
// pass the first half and ship nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode } from './crypto';
import { PAGE_CAPS, buildHello, deviceAuthPayload, native, signChallenge } from './native';
import { loadPairing, forgetPairing } from './pairing';
import { deviceName } from './bundle';

const KS = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const RID = 'rid-under-test';

function useShell(shell: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>)['__ORIGAMI_NATIVE__'] = shell;
}

function noShell(): void {
  delete (globalThis as Record<string, unknown>)['__ORIGAMI_NATIVE__'];
}

/** The minimal Window the pairing lane touches. */
function makeWindow(hash = '', seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const win = {
    location: { hash, pathname: '/app/', search: '', origin: 'https://relay.example' },
    history: {
      replaceState() {
        win.location.hash = '';
      },
    },
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return { win: win as unknown as Window, store };
}

afterEach(() => noShell());

describe('a plain browser — every native branch is inert', () => {
  it('native() is undefined, so there is no shell to ask', () => {
    expect(native()).toBeUndefined();
  });

  it('the hello carries NO deviceKey, no platform and no app — just this page’s caps', async () => {
    // `caps` is what makes the compressed replay safe: the desk sends the
    // envelope only to a page that named `restoreZ`, so a SHIPPED copy of this
    // file that predates the field declares nothing and keeps the plain tail.
    // `restoreDelta` is the same bargain for the DELTA replay (remoteDelta.ts).
    expect(await buildHello('iPhone')).toEqual({
      type: 'remote/hello', v: 1, device: 'iPhone', caps: ['restoreZ', 'restoreDelta'],
    });
    expect(PAGE_CAPS).toEqual(['restoreZ', 'restoreDelta']);
  });

  it('a challenge is never answered, so nothing new is ever put on the wire', async () => {
    const challenge = b64urlEncode(new Uint8Array(32));
    expect(await signChallenge({ type: 'remote/challenge', v: 1, challenge }, RID)).toBeUndefined();
  });

  it('loadPairing still reads the fragment and still scrubs it', async () => {
    const { win, store } = makeWindow(`#v1.${RID}.${b64urlEncode(KS)}`);
    const pairing = await loadPairing(win);
    expect(pairing).toMatchObject({ rid: RID, fresh: true });
    expect([...(pairing?.ks ?? [])]).toEqual([...KS]);
    expect(store.get('origami-remote/last-rid')).toBe(RID);
    expect(win.location.hash).toBe('');
  });

  it('loadPairing still resumes from localStorage with no fragment', async () => {
    const { win } = makeWindow('', {
      'origami-remote/last-rid': RID,
      [`origami-remote/ks/${RID}`]: b64urlEncode(KS),
    });
    expect(await loadPairing(win)).toMatchObject({ rid: RID, fresh: false });
  });

  it('forgetPairing still clears both keys and asks no shell', () => {
    const { win, store } = makeWindow('', {
      'origami-remote/last-rid': RID,
      [`origami-remote/ks/${RID}`]: b64urlEncode(KS),
    });
    forgetPairing(RID, win);
    expect(store.size).toBe(0);
  });

  it('deviceName still guesses from the user agent', async () => {
    await expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 26_5)')).resolves.toBe('iPhone');
    await expect(deviceName('Mozilla/5.0 (Linux; Android 15)')).resolves.toBe('Android phone');
  });
});

describe('inside the shell — the branch the app runs', () => {
  const KEY = { alg: 'ES256' as const, pub: 'PUB', fp: 'FP', backend: 'secure-enclave' as const };

  function shell(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      platform: 'ios',
      appVersion: '1.0 (1)',
      getPairing: () => Promise.resolve({ rid: RID, ks: b64urlEncode(KS), relayUrl: 'wss://r', fresh: true, deviceKey: KEY }),
      forgetPairing: () => Promise.resolve(true),
      deviceInfo: () => Promise.resolve({ name: "Sam's iPhone", model: 'iPhone17,1', system: 'iOS 26.5' }),
      signWithDevice: vi.fn(() => Promise.resolve({ sig: 'SIG', pub: 'PUB' })),
      ...over,
    };
  }

  it('the pairing comes from the Keychain, and NEITHER localStorage nor the fragment is read', async () => {
    useShell(shell());
    const { win, store } = makeWindow(`#v1.other-rid.${b64urlEncode(KS)}`);
    const pairing = await loadPairing(win);
    expect(pairing).toMatchObject({ rid: RID, fresh: true });
    // The fragment named a DIFFERENT rid and was ignored; nothing was written.
    expect(store.size).toBe(0);
    expect(win.location.hash).not.toBe('');
  });

  it('a shell with no pairing is "not paired", not a fallback to web storage', async () => {
    useShell(shell({ getPairing: () => Promise.resolve(null) }));
    const { win } = makeWindow('', {
      'origami-remote/last-rid': RID,
      [`origami-remote/ks/${RID}`]: b64urlEncode(KS),
    });
    expect(await loadPairing(win)).toBeUndefined();
  });

  it('a Ks of the wrong length is refused rather than derived from', async () => {
    useShell(shell({ getPairing: () => Promise.resolve({ rid: RID, ks: b64urlEncode(new Uint8Array(16)), relayUrl: '', fresh: true, deviceKey: KEY }) }));
    expect(await loadPairing(makeWindow().win)).toBeUndefined();
  });

  it('the hello carries platform, app and the device key', async () => {
    useShell(shell());
    expect(await buildHello("Sam's iPhone")).toEqual({
      type: 'remote/hello',
      v: 1,
      device: "Sam's iPhone",
      caps: ['restoreZ', 'restoreDelta'],
      platform: 'ios',
      app: '1.0 (1)',
      deviceKey: KEY,
    });
  });

  it('deviceName prefers the name the shell knows', async () => {
    useShell(shell());
    await expect(deviceName('Mozilla/5.0 (iPhone)')).resolves.toBe("Sam's iPhone");
  });

  it('signs the domain-separated bytes and nothing else', async () => {
    const bridge = shell();
    useShell(bridge);
    const challenge = new Uint8Array(32).map((_, i) => i);
    const res = await signChallenge({ type: 'remote/challenge', v: 1, challenge: b64urlEncode(challenge) }, RID, 'FP');
    expect(res).toEqual({ type: 'remote/challenge-response', v: 1, sig: 'SIG', pub: 'PUB', fp: 'FP' });

    const req = (bridge['signWithDevice'] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { payload: string; biometric: boolean };
    expect([...b64urlDecode(req.payload)]).toEqual([...deviceAuthPayload(challenge, RID)]);
    expect(new TextDecoder().decode(b64urlDecode(req.payload).slice(0, 29))).toBe('origami-remote/v1/device-auth');
    // No Face ID sheet per reconnect: session binding is not a permission.
    expect(req.biometric).toBe(false);
  });

  it('refuses to sign a challenge that is not 32 bytes — a broken desktop is not a weaker binding', async () => {
    const bridge = shell();
    useShell(bridge);
    const short = b64urlEncode(new Uint8Array(16));
    expect(await signChallenge({ type: 'remote/challenge', v: 1, challenge: short }, RID)).toBeUndefined();
    expect(await signChallenge({ type: 'remote/challenge', v: 1, challenge: 'not!base64url' }, RID)).toBeUndefined();
    expect(await signChallenge({ type: 'remote/challenge', v: 1 }, RID)).toBeUndefined();
    expect((bridge['signWithDevice'] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('a shell that refuses to sign loses the answer, not the socket', async () => {
    useShell(shell({ signWithDevice: () => Promise.reject(new Error('denied')) }));
    await expect(
      signChallenge({ type: 'remote/challenge', v: 1, challenge: b64urlEncode(new Uint8Array(32)) }, RID),
    ).resolves.toBeUndefined();
  });
});

// The domain prefix is 29 bytes; the slice above is a sanity check on the
// payload's SHAPE, so pin the arithmetic rather than let a silent off-by-one
// make that assertion vacuous.
describe('deviceAuthPayload', () => {
  it('is the domain, then the 32 challenge bytes, then the rid — and nothing else', () => {
    const challenge = new Uint8Array(32).fill(0xab);
    const out = deviceAuthPayload(challenge, RID);
    const domain = new TextEncoder().encode('origami-remote/v1/device-auth');
    expect(out).toHaveLength(domain.length + 32 + RID.length);
    expect([...out.slice(0, domain.length)]).toEqual([...domain]);
    expect([...out.slice(domain.length, domain.length + 32)]).toEqual([...challenge]);
    expect(new TextDecoder().decode(out.slice(domain.length + 32))).toBe(RID);
  });
});
