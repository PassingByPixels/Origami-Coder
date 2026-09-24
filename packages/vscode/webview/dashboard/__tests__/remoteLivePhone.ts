// A SCRIPTED PHONE THAT IS THE REAL PHONE LANE.
//
// `remoteRelayLive.test.ts` originally drove its phone with the DESKTOP's
// `FrameCodec` in the phone role. That proves the crypto and the relay, but it
// cannot prove either of the two failures the owner reported, because both of
// them live in the phone lane's OWN state:
//
//   - the seq marks in `webview/remote/seq.ts` (localStorage, per rid), which
//     decide what `?after=` a reopened page asks for and what seq its hello
//     carries;
//   - the reconnect ladder and the hello-on-every-open in
//     `webview/remote/transport.ts`.
//
// So this harness wires the production phone modules to a real WebSocket and a
// Map-backed localStorage. The Map is the DEVICE: hand the same one to a second
// `openPhonePage` and you have modelled closing the tab and reopening it, which
// is exactly the case in symptom (2).
//
// SEPARATE from `remotePhoneHarness.ts`, which mounts the real ChatView over a
// LOOPBACK relay and therefore needs jsdom and Svelte. This one runs in the node
// environment `remoteRelayLive.test.ts` declares, against a real socket, and
// stops at the message list — the two answer different questions.
//
// Nothing here re-implements framing, sequencing or chunking — those come from
// `webview/remote/*` or the test proves nothing.

import { deriveKey } from '../../remote/crypto';
import { deviceAuthPayload } from '../../../src/remote/deviceAuth';
import { openMarks } from '../../remote/repair';
import { WireKeys } from '../../remote/sessionKey';
import { RemoteTransport, type SocketLike } from '../../remote/transport';

/** base64url in, bytes out. The phone lane's own decoder, so the harness reads
 *  a challenge exactly as `webview/remote/native.ts` does. */
function b64urlDecodeLocal(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** The slice of `Window` the phone lane touches: localStorage, nothing else. */
export function fakeDevice(): Window {
  const store = new Map<string, string>();
  return {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  } as unknown as Window;
}

export interface PhonePage {
  readonly messages: Array<{ type?: string }>;
  readonly statuses: string[];
  readonly rejects: string[];
  readonly urls: string[];
  /** Every sentence the page put on screen — `repair.ts`, the same wiring
   *  `main.ts` uses. This harness has no DOM, so the notice IS the assertion. */
  readonly notices: string[];
  /** How many times the socket has been handed to the factory. */
  readonly opens: number;
  /** Every `remote/challenge` this page answered, newest last. Kept apart from
   *  `messages` for the same reason main.ts keeps it off the webview bus: the
   *  chat bundle has no arm for it. */
  readonly challenges: string[];
  send(msg: unknown): Promise<void>;
  /** Close the underlying socket WITHOUT telling the transport we meant it —
   *  a backgrounded Safari tab, not a revoke. */
  dropSocket(): void;
  close(): void;
}

export interface PhonePageOptions {
  relay: string;
  rid: string;
  ks: Uint8Array;
  device?: Window;
  deviceName?: string;
  /** True when this load carries a QR fragment. A page resumed from STORAGE
   *  with no seq marks is the wedged case — see `repair.ts`. */
  pairingFresh?: boolean;
  /** Tight by default so a reconnect inside a 5 s assertion is real. */
  backoff?: number[];
  /** The Secure-Enclave-shaped identity of a phone running the iOS app. With
   *  it the hello carries `deviceKey` and every challenge is answered with a
   *  real ECDSA P-256 signature; without it this is the relay-served browser
   *  page, which has no key and answers nothing. */
  deviceKey?: {
    block: Record<string, string>;
    sign(payload: Uint8Array): Promise<string>;
  };
}

/**
 * One page load of the phone shell: derive the key from Ks, resume the seq
 * marks the device already holds, connect, and re-handshake on every open the
 * way `webview/remote/main.ts` does.
 */
export async function openPhonePage(opts: PhonePageOptions): Promise<PhonePage> {
  const keys = new WireKeys(await deriveKey(opts.ks), opts.rid);
  const messages: Array<{ type?: string }> = [];
  const statuses: string[] = [];
  const rejects: string[] = [];
  const urls: string[] = [];
  const notices: string[] = [];
  const challenges: string[] = [];
  const { seq, repair } = openMarks(
    opts.rid,
    opts.pairingFresh ?? true,
    (text) => void notices.push(text),
    opts.device ?? fakeDevice(),
  );
  let live: WebSocket | undefined;
  let opens = 0;

  const transport = new RemoteTransport({
    keys,
    seq,
    url: (after) => `${opts.relay}/r/${encodeURIComponent(opts.rid)}?role=phone&after=${after}`,
    backoff: opts.backoff ?? [200, 400, 800],
    onStatus: (s) => void statuses.push(s),
    onReject: (r) => void rejects.push(r),
    // main.ts sends BOTH on every open: the hello is the handshake, the
    // snapshot is "hydrate me". A reopened page depends on this.
    onOpen: () => {
      repair.socketOpened();
      const hello: Record<string, unknown> = { type: 'remote/hello', v: 1, device: opts.deviceName ?? 'e2e-phone' };
      if (opts.deviceKey) {
        hello['platform'] = 'ios';
        hello['app'] = '1.0 (1)';
        hello['deviceKey'] = opts.deviceKey.block;
      }
      void transport.send(hello);
      void transport.send({ type: 'remote/snapshot' });
    },
    onMessage: (m) => {
      repair.messageSeen(m);
      // The session-binding challenge stays OFF the message list, exactly as
      // `main.ts` keeps it off the webview bus. Answer it when this page has a
      // key, and never WAIT for one.
      const msg = m as { type?: string; challenge?: string };
      if (msg?.type === 'remote/challenge') {
        const key = opts.deviceKey;
        const raw = msg.challenge;
        if (!key || typeof raw !== 'string') return;
        challenges.push(raw);
        void (async () => {
          const sig = await key.sign(deviceAuthPayload(b64urlDecodeLocal(raw), opts.rid));
          await transport.send({ type: 'remote/challenge-response', v: 1, sig, pub: key.block['pub'], fp: key.block['fp'] });
        })();
        return;
      }
      messages.push(m as { type?: string });
    },
    socketFactory: (url) => {
      urls.push(url);
      opens++;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      live = ws;
      return ws as unknown as SocketLike;
    },
  });
  transport.connect();

  return {
    messages,
    challenges,
    statuses,
    rejects,
    urls,
    notices,
    get opens() {
      return opens;
    },
    send: (msg) => transport.send(msg),
    dropSocket: () => live?.close(),
    close: () => transport.close(),
  };
}
