// Origami Remote — phone shell boot.
//
// Order matters and is the whole file: install the shim, connect, handshake,
// buffer, then load the real chat bundle once the desktop has named a session.
// See `shim.ts` for why the bundle cannot be loaded any earlier.

import './remote.css';
import { deviceName, loadChatBundle } from './bundle';
import { TranscriptCache } from './cache';
import { deriveKey } from './crypto';
import { buildHello } from './native';
import { WireKeys, handleChallenge } from './sessionKey';
import { forgetPairing, loadPairing, socketUrl } from './pairing';
import { PhonePrivilege } from './privilege';
import { openMarks } from './repair';
import { expandRestore } from './inflate';
import { forgetSeq } from './seq';
import { installSessionBar, repin } from './sessionBar';
import { MountGate, dispatchToWebview, installShim } from './shim';
import { RemoteTransport } from './transport';
import { isRefusedWhenKeyless, setFatal, setNotice, setStatus, setWatchOnly } from './ui';

async function boot(): Promise<void> {
  const pairing = await loadPairing();
  if (!pairing) {
    setStatus(document, 'not paired');
    setFatal(document, 'Not paired. Scan the QR code shown by Origami Coder on your desktop.');
    return;
  }
  // K, and this socket's version state. K' joins it when the challenge is
  // answered the v2 way (`sessionKey.ts`); until then everything is v1.
  const keys = new WireKeys(await deriveKey(pairing.ks), pairing.rid);
  // Built once, sent on every socket open: `deviceInfo()` and the device key
  // are native round trips, and `onOpen` cannot await.
  const hello = await buildHello(await deviceName());
  // The signed grants (`privilege.ts`). Its `send` closes over `transport`.
  const priv = new PhonePrivilege({ send: (m) => void transport.send(m), fp: hello.deviceKey?.fp });
  const gate = new MountGate(loadChatBundle);
  // The transcript this device already holds; `onOpen` tells the desk (cache.ts).
  const cache = new TranscriptCache(pairing.rid, (m) => void gate.accept(m));
  // WHY THE PAGE CAN SAY WHAT WENT WRONG. A page whose seq marks are gone has
  // every frame it sends rejected as a replay, and said nothing about it — a
  // blank page under a green pill. See `repair.ts` for the three cases.
  const { seq, repair } = openMarks(pairing.rid, pairing.fresh, (text) => setNotice(document, text));
  // A page with NO device key is watch-only on the desktop, whatever this desk
  // allows (src/remote/inbound.ts). That is a plain browser on the relay's
  // /app: `buildHello` puts a key in the hello only when the native shell is
  // there to sign with one.
  const keyless = !hello.deviceKey;

  const transport = new RemoteTransport({
    keys,
    // The counters belong to the PAIRING, not to this page load: a refresh that
    // started them again at 1 had its hello and its snapshot thrown away by the
    // desktop's replay guard, and asked the relay to replay its whole ring on
    // top of the hydration. See `seq.ts`.
    seq,
    url: (after) => socketUrl('', pairing.rid, after),
    onStatus: (s) => setStatus(document, s),
    onReject: (why) => {
      // Not fatal: the relay's ring legitimately replays frames we already
      // have, and that lands here too. Surfacing it beats a silent drop.
      console.warn('[remote]', why);
    },
    onOpen: () => {
      repair.socketOpened();
      void transport.send({ ...hello, ...cache.cursors() });
      void transport.send(cache.snapshot());
    },
    onMessage: (msg) => {
      repair.messageSeen(msg);
      bar.note(msg);
      // The per-ask nonce, and the YOLO challenge the bundle has no arm for.
      if (priv.inbound(msg)) return;
      const m = msg as { type?: unknown };
      if (m && m.type === 'remote/revoked') {
        forgetPairing(pairing.rid);
        forgetSeq(pairing.rid);
        cache.forget();
        setFatal(document, 'The desktop revoked this pairing. Scan a new QR code to reconnect.');
        transport.close();
        return;
      }
      // `remote/hello` is the desktop's half of the handshake; the chat bundle
      // has no arm for it, so keep it off the webview's message bus.
      if (m && m.type === 'remote/hello') return void cache.note(msg);
      // Nor does it have an arm for the session-binding challenge. Answer it
      // when the shell can sign, and never WAIT for one: a desktop that sends
      // no challenge is today's desktop, which must keep working unchanged.
      if (m && m.type === 'remote/challenge') {
        void handleChallenge(msg, { keys, ks: pairing.ks, fp: hello.deviceKey?.fp, send: (x) => transport.send(x) });
        return;
      }
      // Transcripts arrive DEFLATED, and inflating is async — so every message
      // rides one tail, or a big replay would be overtaken by the small ones
      // behind it and the pane would paint out of order.
      tail = tail.then(() => expandRestore(msg)).then((m) => gate.accept(cache.note(m))).catch(() => undefined);
    },
  });
  let tail: Promise<unknown> = Promise.resolve();

  // The chat strip: the phone's tab bar. Same messages the pane reads.
  const bar = installSessionBar(document, { post: cache.speak((m) => void transport.send(m)), show: repin });

  // The message is SENT either way: the desktop is the one authority on what it
  // will act on, and a page that refused locally would be a second, drifting
  // copy of that rule. This only says so on screen.
  installShim(cache.speak((msg) => {
    if (keyless && isRefusedWhenKeyless(msg)) setWatchOnly(document);
    // The bundle's YOLO button and Actions row post `setApproveMode`, the road to
    // bypass the desk refuses unsigned. Put it on the signed one instead.
    if (priv.handleSetApproveMode(msg, bar.activeId())) return;
    priv.outbound(msg, (out) => void transport.send(out));
  }), pairing.rid);
  cache.paint();
  transport.connect();
}

// Exposed for the Playwright harness, which drives a fake relay: it needs to
// know the shell finished booting before it starts replaying a hydration.
(window as unknown as { __ORIGAMI_REMOTE_READY__?: Promise<void> }).__ORIGAMI_REMOTE_READY__ =
  boot().catch((err: unknown) => {
    console.error('[remote] boot failed', err);
    setFatal(document, `Could not start: ${(err as Error).message}`);
  });

// Re-exported so the phone shell's own tests can drive the same entry points
// the boot path uses, rather than a parallel copy of them.
export { dispatchToWebview };
