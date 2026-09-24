// The phone's half of the signed privilege road, against the DESK'S OWN
// verifier. Nothing here re-describes a byte layout: every signature this file
// asserts on is handed to `src/remote/authority.ts` `verifyByEnrolled` — the
// same function the desktop runs — so a payload that drifted from the desk's
// would fail these tests rather than pass a copy of its own mistake.

import { afterEach, describe, expect, it } from 'vitest';
import { approvePayload, setModePayload, verifyByEnrolled } from '../../src/remote/authority';
import { b64urlEncode } from './crypto';
import type { OrigamiNative } from './native';
import { REPORTED } from './modeState';
import { PhonePrivilege, type Mode } from './privilege';

const SESSION = 'session-3';

interface Shell {
  pub: string;
  /** Every payload the page asked the enclave to sign, base64url, in order. */
  signed: string[];
  /** Set to make the next `signWithDevice` throw, as a refused Face ID does. */
  refuse: boolean;
  /** What `deviceInfo()` reports for the app's Face-ID-on-approvals toggle. */
  approvalsBiometric?: boolean;
  /** The `biometric` flag each sign request carried. */
  prompts: boolean[];
}

/** One real P-256 key behind the shell bridge, exactly as the app's Enclave is
 *  behind it. Nothing is faked but the transport into it. */
async function installShell(): Promise<Shell> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const state: Shell = { pub: b64urlEncode(raw), signed: [], refuse: false, prompts: [] };
  const shell: OrigamiNative = {
    platform: 'ios',
    appVersion: '1.0 (test)',
    getPairing: async () => null,
    forgetPairing: async () => true as const,
    deviceInfo: async () => ({ name: 'test phone', model: 'iPhone', system: 'iOS', ...(state.approvalsBiometric === undefined ? {} : { approvalsBiometric: state.approvalsBiometric }) }) as never,
    signWithDevice: async (req) => {
      if (state.refuse) throw new Error('the owner cancelled Face ID');
      state.signed.push(req.payload);
      state.prompts.push(req.biometric);
      const bytes = Uint8Array.from(atob(req.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes);
      return { sig: b64urlEncode(new Uint8Array(sig)), pub: state.pub };
    },
  };
  (globalThis as { __ORIGAMI_NATIVE__?: OrigamiNative }).__ORIGAMI_NATIVE__ = shell;
  return state;
}

function unplugShell(): void {
  delete (globalThis as { __ORIGAMI_NATIVE__?: unknown }).__ORIGAMI_NATIVE__;
}

/** 16 desk-chosen bytes, the width `APPROVAL_NONCE_BYTES` mints. */
function nonce(fill: number, len = 16): string {
  return b64urlEncode(new Uint8Array(len).fill(fill));
}

function ask(toolCallId: string, approvalNonce?: string): unknown {
  return {
    type: 'requestPermission',
    sessionId: SESSION,
    toolCallId,
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
    ...(approvalNonce === undefined ? {} : { approvalNonce }),
  };
}

/** A page, its raised control frames, and what the bundle's messages became. */
interface Hook { sessionId: string; mode: Mode; reason?: string }

function page(): { priv: PhonePrivilege; raised: unknown[]; wire: unknown[]; hooks: Hook[]; post: (m: unknown) => void } {
  const raised: unknown[] = [];
  const wire: unknown[] = [];
  const hooks: Hook[] = [];
  const priv = new PhonePrivilege({
    send: (m) => void raised.push(m),
    onModeChange: (sessionId, mode, reason) => void hooks.push({ sessionId, mode, reason }),
    fp: 'fp-of-this-phone',
  });
  return { priv, raised, wire, hooks, post: (m) => priv.outbound(m, (out) => void wire.push(out)) };
}

/** Wait for the signer, which is a real WebCrypto round trip. POLLED, not a
 *  tick count: `crypto.subtle.sign` is not resolved by one macrotask on a
 *  machine running the rest of the suite, and a test that guessed sent its
 *  NEXT message before the first had left — which reordered `wire` and failed
 *  on the wrong assertion. */
async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A bounded wait for a NEGATIVE claim: nothing may be raised, and "nothing"
 *  has to be given long enough to have happened. */
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

afterEach(() => unplugShell());

describe('ask mode — the approval the desk will act on', () => {
  it('signs an APPROVE over the desknonce, and the desk verifies it', async () => {
    const shell = await installShell();
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => wire.length === 1, 'the signed approval');

    const sent = wire[0] as { sig?: unknown; pub?: unknown; fp?: unknown; optionId?: unknown };
    expect(sent.fp).toBe('fp-of-this-phone');
    expect(sent.optionId).toBe('once');
    // THE ASSERTION THAT MATTERS: the desk's own verifier, over the desk's own
    // payload, built from the nonce the desk stamped on the ask.
    const verdict = await verifyByEnrolled({
      payload: approvePayload(new Uint8Array(16).fill(7), 'tc-1', 'once'),
      sig: sent.sig,
      pub: sent.pub,
      enrolledPub: shell.pub,
    });
    expect(verdict).toEqual({ ok: true, reason: 'verified' });
  });

  it('sends a DENY, and the null-optionId cancel, unsigned — refusing is free', async () => {
    const shell = await installShell();
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    priv.inbound(ask('tc-2', nonce(8)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'no', sessionId: SESSION });
    post({ type: 'permission', toolCallId: 'tc-2', optionId: null, sessionId: SESSION });
    await until(() => wire.length === 2, 'both refusals');

    expect(wire).toHaveLength(2);
    for (const m of wire) expect(m).not.toHaveProperty('sig');
    expect(shell.signed).toEqual([]);
  });

  it('a SECOND reply for the same ask is not signed again — one nonce, one grant', async () => {
    const shell = await installShell();
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => wire.length === 1, 'the signed approval');
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => wire.length === 2, 'the replay');

    expect(shell.signed).toHaveLength(1);
    expect(wire[1]).not.toHaveProperty('sig');
  });

  it('an ask with NO approvalNonce, and any other message, pass through untouched', async () => {
    await installShell();
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-old'));
    post({ type: 'permission', toolCallId: 'tc-old', optionId: 'once', sessionId: SESSION });
    post({ type: 'send', text: 'hello', sessionId: SESSION });
    await until(() => wire.length === 2, 'both messages');

    expect(wire.map((m) => (m as { type: string }).type)).toEqual(['permission', 'send']);
    for (const m of wire) expect(m).not.toHaveProperty('sig');
  });

  it('honours the shell Face-ID toggle on an approval, and never prompts for YOLO', async () => {
    const shell = await installShell();
    shell.approvalsBiometric = true;
    const { priv, post } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => shell.prompts.length === 1, 'the approval signature');
    priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => shell.prompts.length === 2, 'the set-mode signature');

    // The approval asked for the sheet; the escalation is one tap, by design.
    expect(shell.prompts).toEqual([true, false]);
  });

  it('a refused signature sends the reply UNSIGNED, so the desk drops it rather than the socket', async () => {
    const shell = await installShell();
    shell.refuse = true;
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => wire.length === 1, 'the unsigned reply');

    expect(wire).toHaveLength(1);
    expect(wire[0]).not.toHaveProperty('sig');
  });

  it('a page with NO shell signs nothing and still answers — today behaviour, unchanged', async () => {
    const { priv, post, wire } = page();
    priv.inbound(ask('tc-1', nonce(7)));
    post({ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION });
    await until(() => wire.length === 1, 'the reply');

    expect(wire).toEqual([{ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: SESSION }]);
  });
});

describe('yolo — the bundle setApproveMode becomes the signed handshake', () => {
  it('bypass raises the REQUEST and nothing else; the raw verb never goes out', async () => {
    await installShell();
    const { priv, raised, wire } = page();
    const handled = priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');

    expect(handled).toBe(true);
    expect(wire).toEqual([]);
    expect(raised).toEqual([{ type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId: SESSION }]);
    expect(priv.mode(SESSION)).toBe('pending');
  });

  it('signs the challenge and the desk verifies the set-mode', async () => {
    const shell = await installShell();
    const { priv, raised } = page();
    priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => raised.length === 2, 'the signed set-mode');

    const sent = raised[1] as { type?: string; mode?: string; sig?: unknown; pub?: unknown };
    expect(sent.type).toBe('remote/set-mode');
    expect(sent.mode).toBe('yolo');
    const verdict = await verifyByEnrolled({
      payload: setModePayload(new Uint8Array(32).fill(9), SESSION, 'yolo'),
      sig: sent.sig,
      pub: sent.pub,
      enrolledPub: shell.pub,
    });
    expect(verdict).toEqual({ ok: true, reason: 'verified' });
    expect(priv.mode(SESSION)).toBe('yolo');
  });

  it('is IDEMPOTENT while pending and once in yolo — no second challenge is opened', async () => {
    await installShell();
    const { priv, raised } = page();
    const bypass = { type: 'setApproveMode', mode: 'bypass', sessionId: SESSION };
    priv.handleSetApproveMode(bypass, '');
    priv.handleSetApproveMode(bypass, '');
    expect(raised).toHaveLength(1);

    priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => raised.length === 2, 'the signed set-mode');
    priv.handleSetApproveMode(bypass, '');
    expect(raised.filter((m) => (m as { type: string }).type === 'remote/set-mode-request')).toHaveLength(1);
  });

  it('default reverts UNSIGNED once escalated, and says nothing when already in Ask', async () => {
    await installShell();
    const { priv, raised } = page();
    const toAsk = { type: 'setApproveMode', mode: 'default', sessionId: SESSION };
    expect(priv.handleSetApproveMode(toAsk, '')).toBe(true);
    expect(raised).toEqual([]); // already Ask: the bundle posts this on its own paths

    priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => raised.length === 2, 'the signed set-mode');
    priv.handleSetApproveMode(toAsk, '');

    expect(raised.at(-1)).toEqual({ type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: SESSION });
    expect(raised.at(-1)).not.toHaveProperty('sig');
    expect(priv.mode(SESSION)).toBe('ask');
  });

  it('falls back to the strip active chat, and drops a mode with no signed road', async () => {
    await installShell();
    const { priv, raised } = page();
    priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass' }, SESSION);
    expect(raised).toEqual([{ type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId: SESSION }]);

    // No session anywhere, and a mode the desk has no signed road for: both are
    // handled (never forwarded) and both are dropped.
    expect(priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass' }, '')).toBe(true);
    expect(priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'auto', sessionId: 'other' }, '')).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it('a KEYLESS page raises no set-mode frame at all', () => {
    const { priv, raised, wire } = page();
    expect(priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '')).toBe(true);
    expect(raised).toEqual([]);
    expect(wire).toEqual([]);
    expect(priv.mode(SESSION)).toBe('ask');
  });

  it('ignores a challenge nobody asked for, and a malformed one leaves the chat in Ask', async () => {
    await installShell();
    const { priv, raised } = page();
    // Unsolicited: this key must not sign bytes no one on this page chose.
    expect(priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION })).toBe(true);
    await quiet();
    expect(raised).toEqual([]);

    priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: '!!not base64url!!', sessionId: SESSION });
    await quiet();
    expect(raised).toHaveLength(1); // the request only
    expect(priv.mode(SESSION)).toBe('ask');
  });

  it('keeps the mode-challenge OFF the webview bus and lets everything else through', () => {
    const { priv } = page();
    // TRUE = consumed here. It is consumed even when unsolicited: the bundle has
    // no arm for it either way, and a stray one on the bus is a stray one.
    expect(priv.inbound({ type: 'remote/mode-challenge', v: 1, sessionId: SESSION })).toBe(true);
    // FALSE = flows on to the bundle, which is what draws the ask card.
    expect(priv.inbound(ask('tc-1', nonce(7)))).toBe(false);
    expect(priv.inbound({ type: 'restoreMessages', sessionId: SESSION })).toBe(false);
  });
});

// --------------------------------------------------------- the desk's word --

/** The page's notice strip, by the id `index.html` declares. Without it in the
 *  DOM `setNotice` is a no-op, and a test that asserted on the reason would be
 *  asserting on nothing. */
function noticeStrip(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'remoteNotice';
  document.body.appendChild(el);
  return el;
}

/** The full YOLO handshake, on a real key. Returns with the chat in yolo. */
async function escalate(p: ReturnType<typeof page>, sessionId = SESSION): Promise<void> {
  p.priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId }, '');
  p.priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId });
  await until(() => p.priv.mode(sessionId) === 'yolo', 'the handshake to finish');
}

describe('the mode map has ONE writer, and it tells', () => {
  it('fires the hook once per write, on every road there is', async () => {
    await installShell();
    const p = page();
    await escalate(p);
    p.priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'default', sessionId: SESSION }, '');

    // pending on the tap, yolo when the signature lands, ask on the revert —
    // three writes, three calls, in that order and no others.
    expect(p.hooks).toEqual([
      { sessionId: SESSION, mode: 'pending', reason: undefined },
      { sessionId: SESSION, mode: 'yolo', reason: undefined },
      { sessionId: SESSION, mode: 'ask', reason: undefined },
    ]);
  });

  it('says WHY when the switch could not be signed', async () => {
    const shell = await installShell();
    const p = page();
    shell.refuse = true;
    p.priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    p.priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => p.priv.mode(SESSION) === 'ask', 'the chat to fall back to Ask');
    expect(p.hooks.at(-1)?.reason).toBe('the switch to YOLO could not be signed');
  });
});

describe('an inbound set-mode — the desk reverting a chat it could not switch', () => {
  it('honours mode: ask, says the reason on the strip, and keeps it off the bus', async () => {
    await installShell();
    const strip = noticeStrip();
    const p = page();
    await escalate(p);
    p.hooks.length = 0;

    // The exact frame `src/dashboard/approveModeFailure.ts` posts.
    const consumed = p.priv.inbound({
      type: 'remote/set-mode',
      v: 1,
      mode: 'ask',
      sessionId: SESSION,
      reason: 'the desktop could not write the bypass',
    });

    expect(consumed).toBe(true); // TRUE = the chat bundle never sees it.
    expect(p.priv.mode(SESSION)).toBe('ask');
    expect(p.hooks).toEqual([
      { sessionId: SESSION, mode: 'ask', reason: 'the desktop could not write the bypass' },
    ]);
    expect(strip.textContent).toContain('the desktop could not write the bypass');
    expect(strip.getAttribute('data-open')).toBe('true');
    strip.remove();
  });

  it('REFUSES an unsigned yolo, however well formed, and leaves the chat alone', async () => {
    await installShell();
    const p = page();

    // Everything the signed road carries, minus the one thing that matters:
    // this desk never minted a challenge for it and this page never signed one.
    const consumed = p.priv.inbound({
      type: 'remote/set-mode',
      v: 1,
      mode: 'yolo',
      sessionId: SESSION,
      sig: 'looks-like-a-signature',
      pub: 'looks-like-a-key',
      fp: 'fp-of-this-phone',
    });

    expect(consumed).toBe(true);
    expect(p.priv.mode(SESSION)).toBe('ask');
    expect(p.hooks).toEqual([]);
    expect(p.raised).toEqual([]);
  });

  it('refuses a revert that names no chat, and one that names a number', () => {
    const p = page();
    expect(p.priv.inbound({ type: 'remote/set-mode', v: 1, mode: 'ask' })).toBe(true);
    expect(p.priv.inbound({ type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: 7 })).toBe(true);
    expect(p.hooks).toEqual([]);
  });
});

describe('the mode report — the one place a yolo may be learned from the desk', () => {
  it('is adopted whole, and fires the hook only for what CHANGED', () => {
    const p = page();
    const consumed = p.priv.inbound({
      type: 'remote/mode-state',
      v: 1,
      modes: { [SESSION]: 'yolo', 'chat-quiet': 'ask', 'chat-never-seen': 'yolo' },
    });

    expect(consumed).toBe(true);
    expect(p.priv.mode(SESSION)).toBe('yolo');
    // A chat this page has never drawn is adopted too: the desk knows the
    // window's chats before the strip does.
    expect(p.priv.mode('chat-never-seen')).toBe('yolo');
    expect(p.priv.mode('chat-quiet')).toBe('ask');
    // `chat-quiet` was already Ask, so it is not a write and not a call.
    expect(p.hooks).toEqual([
      { sessionId: SESSION, mode: 'yolo', reason: REPORTED },
      { sessionId: 'chat-never-seen', mode: 'yolo', reason: REPORTED },
    ]);
  });

  it('DROPS a yolo the report does not name — the desk is the authority', async () => {
    await installShell();
    const p = page();
    await escalate(p);
    p.hooks.length = 0;

    p.priv.inbound({ type: 'remote/mode-state', v: 1, modes: { 'other-chat': 'ask' } });

    expect(p.priv.mode(SESSION)).toBe('ask');
    expect(p.hooks).toEqual([{ sessionId: SESSION, mode: 'ask', reason: REPORTED }]);
  });

  it('leaves a handshake in FLIGHT alone — it is newer than the report', async () => {
    await installShell();
    const p = page();
    p.priv.handleSetApproveMode({ type: 'setApproveMode', mode: 'bypass', sessionId: SESSION }, '');
    expect(p.priv.mode(SESSION)).toBe('pending');

    p.priv.inbound({ type: 'remote/mode-state', v: 1, modes: {} });
    expect(p.priv.mode(SESSION)).toBe('pending');

    // ...and the challenge it was waiting for still completes.
    p.priv.inbound({ type: 'remote/mode-challenge', v: 1, nonce: nonce(9, 32), sessionId: SESSION });
    await until(() => p.priv.mode(SESSION) === 'yolo', 'the pending handshake to finish');
  });

  it('consumes a malformed report and changes nothing', () => {
    const p = page();
    expect(p.priv.inbound({ type: 'remote/mode-state', v: 1 })).toBe(true);
    expect(p.priv.inbound({ type: 'remote/mode-state', v: 1, modes: ['yolo'] })).toBe(true);
    expect(p.priv.inbound({ type: 'remote/mode-state', v: 1, modes: { [SESSION]: 'bypass' } })).toBe(true);
    expect(p.priv.mode(SESSION)).toBe('ask');
    expect(p.hooks).toEqual([]);
  });
});
