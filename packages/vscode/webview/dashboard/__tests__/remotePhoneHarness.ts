// THE PHONE, for real: the shell's own transport, its own MountGate, and the
// untouched chat bundle mounted from source.
//
// The point of mounting `ChatView.svelte` rather than asserting on the message
// list is that every rule that decides whether the owner SEES his transcript
// lives in the bundle, not in the shell: `visibleCells` filters to the solo
// session, `acceptsReplayedLog` drops a log replayed under existing rows, and
// `hasConversation` decides the empty-state crane. A test that stops at "the
// phone received restoreMessages" would have passed on every one of the four
// snags the owner reported.

import { mount, unmount } from 'svelte';
import ChatView from '../../chat/ChatView.svelte';
import { TranscriptCache } from '../../remote/cache';
import { b64urlDecode, b64urlEncode, deriveKey } from '../../remote/crypto';
import { expandRestore } from '../../remote/inflate';
import { buildHello, type OrigamiNative } from '../../remote/native';
import { PhonePrivilege, type Mode } from '../../remote/privilege';
import { WireKeys, deviceAuthPayloadV2, handleChallenge } from '../../remote/sessionKey';
import { localSeqStore } from '../../remote/seq';
import { installSessionBar, repin } from '../../remote/sessionBar';
import { MountGate, dispatchToWebview, installShim } from '../../remote/shim';
import { RemoteTransport } from '../../remote/transport';
import type { LoopbackRelay } from './remoteLoopback';

/** The shim is a module-level singleton inside the bundle (`vscodeApi.ts`
 *  caches the first `acquireVsCodeApi()`), so a test file installs ONE and
 *  re-points it at whichever phone is live. */
let currentSend: (msg: unknown) => void = () => {};

export interface Phone {
  transport: RemoteTransport;
  /** The page's own transcript cache — what a kill-and-reopen keeps. */
  cache: TranscriptCache;
  /** This socket's keys — `keys.sessionOn` is "sealing with K'". */
  keys: WireKeys;
  gate: MountGate;
  /** The DOM this phone painted. A reload builds a new one. */
  root: HTMLElement;
  /** The session id the shell pinned `__ORIGAMI_SOLO_SESSION__` to. */
  readonly pinned: string;
  /** Every message the shell ACCEPTED, in order. A frame the replay guard
   *  threw away never reaches here — which is the whole of snag 4. */
  received: unknown[];
  /** Every reason the transport gave for dropping a frame. */
  rejects: string[];
  /** Every message that reached the CHAT BUNDLE own message bus. A control
   *  frame the shell answers itself must never appear here. */
  dispatched: unknown[];
  /** The chat strip's chips, in order. */
  chips(): string[];
  /** Tap a chip. */
  tap(selector: string): void;
  /** Click something the CHAT BUNDLE painted — an ask card's button. Returns
   *  false when the selector matched nothing, so a test cannot pass by missing
   *  the control it meant to press. */
  press(selector: string): boolean;
  /** This page's own view of a chat's privilege mode (`privilege.ts`). */
  mode(sessionId: string): Mode;
  rows(): string[];
  hasEmptyState(): boolean;
  cells(): number;
  close(): void;
}

export interface PhoneOptions {
  relay: LoopbackRelay;
  ks: Uint8Array;
  rid: string;
  /** ms the MountGate waits for the hydration burst to go quiet. Defaults to
   *  the PRODUCTION value: a harness that shortened it to 30 ms was testing a
   *  configuration that does not ship, and lost the race under suite load —
   *  the gate mounted the oldest chat and the assertions about the ACTIVE one
   *  failed, a different one each run (t-w4w7ih). */
  graceMs?: number;
  /** Enrol a device key, as the iOS app does. A phone that enrols nothing is a
   *  BROWSER PAGE, and since 2026-09-06 the desktop clamps one of those to the
   *  `watch` envelope — it may read and cancel, and nothing else. So a test
   *  about the phone DRIVING the desktop (the chat strip's + and x) has to boot
   *  a keyed phone or it is testing the wrong client.
   *
   *  Nothing here fakes the crypto: a real P-256 key is generated, installed as
   *  `window.__ORIGAMI_NATIVE__`, and the shell's own `buildHello` and
   *  `signChallenge` do the work the app does. */
  enrolKey?: boolean;
  /** An app that predates wire v1.3: it enrols a key and signs the v1 shape,
   *  but has no `deviceAuth` bridge, so the socket must stay on v1 frames. */
  oldApp?: boolean;
  /** A DIFFERENT device. Without it a phone booted twice is the same phone,
   *  which is what a kill-and-reopen is. */
  freshKey?: boolean;
}

/** The iOS shell, near enough: one real Secure-Enclave-shaped key and the two
 *  calls `native.ts` makes of it. Installed globally because that is where
 *  `native()` looks; removed again by `close()`. */
/** ONE IDENTITY PER PROCESS. A phone that is closed and reopened is the SAME
 *  phone: its Secure Enclave key survives, and first-enrolment-wins means a
 *  reopened page that minted a fresh key would be refused by the desktop as a
 *  foreign device — which is correct behaviour and the wrong test. Minting is
 *  the slow part of booting a phone here, so caching also pays for itself. */
let enclave: Promise<CryptoKeyPair> | null = null;

async function installFakeShell(v13: boolean): Promise<void> {
  // EXTRACTABLE, unlike the Enclave's, for one test-only reason: WebCrypto ties
  // a CryptoKey to ONE algorithm, so the same private key has to be imported a
  // second time as ECDH to do what the Enclave does natively (it signs AND
  // agrees with the one key — verified on the app owner's Mac, spec §0).
  enclave ??= crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  const pair = await enclave;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const ecdh = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, alg: undefined, key_ops: ['deriveBits'] },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pub = b64urlEncode(raw);
  const fp = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
  const deviceKey = { alg: 'ES256' as const, pub, fp, backend: 'secure-enclave' as const };
  const shell: OrigamiNative = {
    platform: 'ios',
    appVersion: '1.0 (harness)',
    getPairing: async () => ({ rid: '', ks: '', relayUrl: '', fresh: false, deviceKey }),
    forgetPairing: async () => true as const,
    deviceInfo: async () => ({ name: 'harness phone', model: 'iPhone', system: 'iOS' }),
    signWithDevice: async (req) => {
      const payload = Uint8Array.from(atob(req.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      );
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, payload);
      return { sig: b64urlEncode(new Uint8Array(sig)), pub };
    },
    // Wire v1.3, native bridge §6: the v2 signature and the ECDH in ONE call.
    // ABSENT on an `appVersion: 'old'` phone, which is how §8.4 gets a client
    // that answers the v1 shape and must be kept on v1 frames.
    ...(v13
      ? {
          deviceAuth: async (req: { challenge: string; rid: string; ephPub: string }) => {
            const challenge = b64urlDecode(req.challenge);
            const ephPub = b64urlDecode(req.ephPub);
            const sig = await crypto.subtle.sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              pair.privateKey,
              deviceAuthPayloadV2(challenge, req.rid, ephPub),
            );
            const peer = await crypto.subtle.importKey(
              'raw',
              ephPub.slice().buffer as ArrayBuffer,
              { name: 'ECDH', namedCurve: 'P-256' },
              false,
              [],
            );
            const z = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ecdh, 256);
            return { sig: b64urlEncode(new Uint8Array(sig)), pub, z: b64urlEncode(new Uint8Array(z)) };
          },
        }
      : {}),
  };
  (globalThis as { __ORIGAMI_NATIVE__?: OrigamiNative }).__ORIGAMI_NATIVE__ = shell;
}

export async function bootPhone(opts: PhoneOptions): Promise<Phone> {
  if (opts.freshKey) enclave = null;
  if (opts.enrolKey) await installFakeShell(opts.oldApp !== true);
  const keys = new WireKeys(await deriveKey(opts.ks), opts.rid);
  // Built ONCE and sent on every socket open, exactly as main.ts does it.
  const hello = await buildHello('harness phone');
  const priv = new PhonePrivilege({ send: (m) => void transport.send(m), fp: hello.deviceKey?.fp });
  const root = document.createElement('div');
  // The shell's own chrome, by the ids index.html declares. The strip has to be
  // in the DOM before the bar is installed, exactly as it is on the phone.
  const strip = document.createElement('div');
  strip.id = 'remoteSessions';
  strip.setAttribute('data-open', 'false');
  document.body.appendChild(strip);
  document.body.appendChild(root);
  let app: Record<string, unknown> | undefined;
  let pinned = '';

  const received: unknown[] = [];
  const rejects: string[] = [];
  /** A CLOSED page paints nothing. `transport.close()` stops the socket, but a
   *  frame already on the decrypt tail still resolves — and dispatching it
   *  reached `window` after vitest had torn the environment down, as an
   *  unhandled rejection in whatever file was running next. */
  let closed = false;

  const dispatched: unknown[] = [];
  const gate = new MountGate(
    async (sessionId) => {
      pinned = sessionId;
      const win = window as unknown as Record<string, unknown>;
      win['__ORIGAMI_SOLO_SESSION__'] = sessionId;
      win['__ORIGAMI_MEMORY__'] = false;
      win['__ORIGAMI_BOARD__'] = false;
      win['__ORIGAMI_RACE_COMPARE__'] = null;
      win['__ORIGAMI_REPO_MAP__'] = null;
      win['__ORIGAMI_COLLAB__'] = null;
      app = mount(ChatView, { target: root }) as Record<string, unknown>;
    },
    (m) => {
      dispatched.push(m);
      dispatchToWebview(m);
    },
    (fn, ms) => setTimeout(fn, ms),
    opts.graceMs ?? 300,
  );

  // main.ts's own cache: the transcript that survives this page, the cursors
  // the snapshot carries, and the instant paint below `transport.connect()`.
  const cache = new TranscriptCache(opts.rid, (m) => void gate.accept(m));

  const transport = new RemoteTransport({
    keys,
    url: (after) => `wss://loopback/r/${opts.rid}?role=phone&after=${after}`,
    seq: localSeqStore(opts.rid),
    socketFactory: (url) => opts.relay.connect(url) as never,
    backoff: [1],
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    onOpen: () => {
      void transport.send({ ...hello, ...cache.cursors() });
      void transport.send(cache.snapshot());
    },
    onReject: (why) => void rejects.push(why),
    onMessage: (msg) => {
      if (closed) return;
      received.push(msg);
      bar.note(msg);
      // The per-ask nonce, and the YOLO challenge the bundle has no arm for.
      if (priv.inbound(msg)) return;
      const type = (msg as { type?: unknown } | null)?.type;
      // The same three `main.ts` keeps off the webview bus. A keyless page
      // answers no challenge, but it must not push 32 random bytes into the
      // mount gate either way.
      if (type === 'remote/challenge') {
        void handleChallenge(msg, { keys, ks: opts.ks, fp: hello.deviceKey?.fp, send: (m) => transport.send(m) });
        return;
      }
      if (type === 'remote/hello') return void cache.note(msg);
      if (type === 'remote/revoked') return;
      // main.ts's own seam: transcripts arrive deflated, inflating is async, so
      // one tail keeps arrival order. Copied here because THIS is the phone.
      tail = tail.then(() => expandRestore(msg)).then((m) => gate.accept(cache.note(m))).catch(() => undefined);
    },
  });

  let tail: Promise<unknown> = Promise.resolve();
  const bar = installSessionBar(document, { post: cache.speak((m) => void transport.send(m)), show: repin });
  // main.ts's outbound seam, INSIDE the latch: the bundle's own `setApproveMode`
  // goes on the signed set-mode road and its approvals leave here signed.
  currentSend = cache.speak((msg) => {
    if (priv.handleSetApproveMode(msg, bar.activeId())) return;
    priv.outbound(msg, (out) => void transport.send(out));
  });
  installShim((msg) => currentSend(msg), opts.rid);
  cache.paint();
  transport.connect();

  return {
    transport,
    cache,
    keys,
    gate,
    root,
    received,
    rejects,
    dispatched,
    get pinned() {
      return pinned;
    },
    chips: () => [...strip.querySelectorAll('.remote-chip')].map((e) => e.textContent ?? ''),
    tap: (selector) => (strip.querySelector(selector) as HTMLButtonElement | null)?.click(),
    press: (selector) => {
      const el = root.querySelector(selector) as HTMLButtonElement | null;
      el?.click();
      return el !== null;
    },
    mode: (sessionId) => priv.mode(sessionId),
    rows: () => [...root.querySelectorAll('.row')].map((e) => e.className.split(' ').slice(0, 2).join(' ')),
    // ChatEmptyState is mounted only while ChatPane's `hasConversation` gate is
    // false — the crane the owner saw over a chat that had a transcript.
    hasEmptyState: () => root.querySelector('.chat-empty') !== null,
    cells: () => root.querySelectorAll('.chat-cell').length,
    // IDEMPOTENT: a test that closes a page itself, and an afterEach that
    // sweeps every page, both call this — and Svelte's second unmount of the
    // same component is a warning on every run that hides the real ones.
    close: () => {
      if (closed) return;
      closed = true;
      transport.close();
      if (app) unmount(app as never);
      root.remove();
      strip.remove();
      // The fake shell is a GLOBAL. A page that left it installed would make
      // the next keyless phone in this file answer a challenge it should not.
      if (opts.enrolKey) delete (globalThis as { __ORIGAMI_NATIVE__?: unknown }).__ORIGAMI_NATIVE__;
    },
  };
}
