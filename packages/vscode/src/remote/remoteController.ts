// Origami Remote — the one object that owns a live remote session.
//
// It wires the leaves together and holds no protocol knowledge of its own:
// pairing.ts owns Ks, frame.ts sealing and replay, seqStore.ts the counters
// that outlive this window, chunk.ts splitting, transport.ts the socket,
// privilege.ts signed authority, remoteView.ts the DashboardPanel seam. With
// `origamicoder.remote.enabled` false, `restore()` returns before any of it is
// constructed — no PairingManager, no socket factory, no timer.

import type { WebviewHost } from '../dashboard/DashboardPanel';
import { DeviceStore, deviceView, type DeviceView } from './deviceAuth';
import { DeviceSession } from './deviceSession';
import type { FrameCodec } from './frameCodec';
import { HydrateGate } from './hydrateGate';
import { dispatchFromPhone, type InboundDeps } from './inbound';
import { PairingManager, PAIRING_WINDOW_MS, type PairingOffer, type SecretStore } from './pairing';
import { helloCaps, markCaps } from './phoneCaps';
import { DESK_NONCE, markSince } from './remoteDelta';
import { InboundPipe, OutboundPipe } from './pipes';
import { RemoteOutbound } from './remoteOutbound';
import { NEEDS_REPAIRING, PAIRING_WEDGED, PeerState, isHello } from './presence';
import { Privilege, type ModeRecord } from './privilege';
import { readCapability, type RemoteCapability } from './remoteVerbs';
import { RemoteView } from './remoteView';
import { desktopCodec, forgetSeq } from './seqStore';
import { SocketGreeting } from './socketGreeting';
import { RemoteTransport, type TransportDeps } from './transport';

export interface RemoteConfig {
  enabled: boolean;
  relayUrl: string;
  /** How far the desk lets the phone go (`remoteVerbs.ts`). */
  capability: RemoteCapability;
}

export interface RemoteControllerOptions {
  /** Read live, so toggling a setting needs no restart. */
  config: () => RemoteConfig;
  secrets: SecretStore;
  deps: TransportDeps;
  /** `DashboardPanel.current?.attachView(host, 'chat')`. Injected so a window
   *  with no panel yet simply does not hydrate rather than throwing. */
  attach: (host: WebviewHost) => void;
  /** Human-readable status for the pairing panel + the output channel. */
  onStatus?: (status: string) => void;
  /** OWNERSHIP, asked with the rid before ANY socket opens (`ownerLease.ts`).
   *  False means another window has it, so this one stays idle. */
  claim?: (rid: string) => Promise<boolean>;
  deviceName?: string;
  now?: () => number;
}

export class RemoteController {
  private readonly pairing: PairingManager;
  /** Device identity, per socket. The rules are in deviceSession.ts. */
  private readonly auth: DeviceSession;
  /** Signed authority, per privilege.ts: approval nonces and session modes. */
  private readonly privilege: Privilege;
  private inbound: InboundDeps | null = null;
  /** THIS socket's codec, so a verified device key can switch it to K'. */
  private codec: FrameCodec | null = null;
  private pipe: InboundPipe | null = null;
  private out: OutboundPipe | null = null;
  /** Coalesces the per-token deltas and scopes the fan-out (`remoteOutbound.ts`). */
  private shaper: RemoteOutbound | null = null;
  /** Whether the relay says a phone is attached. Unknown is NOT absent (`presence.ts`). */
  private readonly peer = new PeerState();
  /** ONE HYDRATION PER SOCKET: announce(), hello and snapshot all ask on the same open; hydrateGate.ts serves the first. */
  private readonly gate = new HydrateGate();
  /** What is said on a socket: hello, challenge, presence edge — `socketGreeting.ts`. */
  private readonly greeter: SocketGreeting;
  private transport: RemoteTransport | null = null;
  private view: RemoteView | null = null;
  private expiryTimer: unknown = null;
  /** Decrypts resolve OUT OF ORDER under load while seq is checked in CALL
   *  order, so inbound is serialised on a tail. Outbound half is in `pipes.ts`. */
  private recvTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RemoteControllerOptions) {
    this.pairing = new PairingManager(opts.secrets, opts.now);
    // Wire v1.3: the verdict on the device key also produces K'. The exchange
    // needs Ks and the codec is where K' lands; this object sees both.
    this.auth = new DeviceSession(new DeviceStore(opts.secrets), {
      ks: () => this.pairing.active?.ks ?? null,
      onSessionKey: (key) => this.codec?.useSessionKey(key),
    });
    this.privilege = new Privilege({
      enrolled: () => this.auth.device,
      send: (msg) => this.sendToPhone(msg),
      deliver: (msg) => this.view?.deliver(msg),
      status: (text) => this.status(text),
      now: opts.now,
    });
    this.greeter = new SocketGreeting({
      peer: this.peer, gate: this.gate, auth: this.auth,
      deviceName: opts.deviceName ?? 'Origami Code',
      send: (msg) => this.sendToPhone(msg),
      status: (text) => this.status(text),
      hydrate: () => this.hydrate(),
      confirmedAt: () => this.pairing.confirmedAt,
    });
  }

  public get connected(): boolean { return this.transport?.status === 'open'; }

  public get rid(): string | null { return this.pairing.active?.rid ?? null; }

  /** Epoch ms of the PHONE's hello — the only honest "is a phone paired".
   *  `connected` reports the desktop's own socket, which opens in milliseconds. */
  public get confirmedAt(): number | null { return this.pairing.confirmedAt; }

  /** The enrolled phone, for the pane. Never carries the public key itself. */
  public get device(): DeviceView | null { return deviceView(this.auth.device, this.auth.sessionState); }

  /** The sessions the phone escalated to YOLO, and who. For the pane. */
  public get modes(): ModeRecord[] { return this.privilege.modes; }

  /** Bring a stored pairing back up. The ONE gate on `enabled`. */
  public async restore(): Promise<void> {
    if (!this.opts.config().enabled) return;
    const active = await this.pairing.load();
    if (!active) return;
    await this.auth.load();
    if (this.opts.claim && !(await this.opts.claim(active.rid))) {
      this.status('remote: this pairing is active in another window');
      return;
    }
    // Take over calls restore() on a window that may ALREADY hold a socket;
    // without this the two evict each other on the relay's one-socket rule.
    this.teardown();
    this.open();
  }

  /** Start a new pairing and return what the QR must show. */
  public async pair(lanUrl?: string): Promise<PairingOffer> {
    const config = this.opts.config();
    if (!config.enabled) throw new Error('origami remote: enable origamicoder.remote.enabled first');
    this.teardown();
    // The old phone's key goes with the old Ks: first-enrolment-wins must not refuse the new phone.
    await this.auth.forget();
    const offer = await this.pairing.begin(config.relayUrl, lanUrl);
    // Pressing Pair decides which window owns the phone; the rid is freshly derived.
    await this.opts.claim?.(offer.rid);
    this.open();
    // The 60-second window is enforced by a timer as well as by confirm()'s own
    // clock check: a phone that never arrives must leave nothing behind.
    this.expiryTimer = this.opts.deps.setTimer(() => {
      this.expiryTimer = null;
      if (this.pairing.pending) void this.revoke('pairing window expired');
    }, PAIRING_WINDOW_MS);
    return offer;
  }

  /** Forget the pairing, drop the socket, detach the phone's view. */
  public async revoke(reason = 'revoked'): Promise<void> {
    this.teardown();
    forgetSeq(this.rid);
    await this.auth.forget();
    await this.pairing.revoke();
    this.status(`remote: ${reason}`);
  }

  public dispose(): void { this.teardown(); }

  // ------------------------------------------------------------- internals --

  private open(): void {
    const active = this.pairing.active;
    if (!active) return;
    const codec = desktopCodec(active.key, active.rid);
    this.codec = codec;
    const view = new RemoteView({ send: (msg) => this.sendToPhone(msg) });
    const transport = new RemoteTransport({
      relayUrl: this.opts.config().relayUrl,
      rid: active.rid,
      afterSeq: () => codec.afterSeq,
      deps: this.opts.deps,
      onFrame: (frame) => { this.recvTail = this.recvTail.then(() => this.onFrame(frame)).catch(() => {}); },
      onControl: (text) => this.greeter.onControl(text),
      onStatus: (s, detail) => this.greeter.onTransportStatus(s, detail),
    });
    this.pipe = new InboundPipe(codec);
    const out = new OutboundPipe(codec, transport, (text) => this.status(`remote: ${text}`));
    this.out = out;
    this.shaper = new RemoteOutbound({ clock: this.opts.deps, send: (m) => out.send(this.privilege.outbound(m)) });
    this.view = view; this.transport = transport;
    this.peer.reset();
    this.greeter.reset();
    // No auth.reset() here: start() drives the transport to `connecting`.
    transport.start();
  }

  private teardown(): void {
    if (this.expiryTimer !== null) {
      this.opts.deps.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
    // Buffered words belong to THIS socket: flush before it stops.
    void this.shaper?.flushAll();
    this.transport?.stop();
    // BEFORE the view is disposed: the ONE revert path for a transport that stopped.
    this.privilege.revertAll();
    this.view?.dispose();
    this.transport = null;
    this.view = null;
    this.codec = null;
    this.pipe = null;
    this.out = null;
    this.shaper = null;
    this.peer.reset(); this.auth.reset(); this.gate.reset();
    this.greeter.reset();
  }

  /** Host -> phone. The promise lets revoke flush `remote/revoked` first. */
  private sendToPhone(msg: unknown): Promise<void> {
    const out = this.out;
    // Nothing is listening; `present` replays a whole hydration, so nothing is lost.
    if (!out || this.peer.paused) return Promise.resolve();
    // THE SHAPER, not the pipe: it coalesces deltas and calls back into
    // `out.send(privilege.outbound(...))`, so the approval nonce is still stamped.
    return this.shaper ? this.shaper.send(msg) : out.send(this.privilege.outbound(msg));
  }

  private async onFrame(frame: Uint8Array): Promise<void> {
    const pipe = this.pipe;
    if (!pipe) return;
    const result = await pipe.accept(frame);
    if (result.ok === 'partial') return;
    if (result.ok) {
      await this.dispatch(result.msg);
      return;
    }
    // A rejected frame is dropped, never acted on, and logged by REASON.
    this.status(`remote: rejected a frame (${result.reason})`);
    // ...but a REPLAYED hello is the phone that lost its seq marks. The guard
    // stays; answer once with `reset: true` (an old page ignores it).
    if (!isHello(result.replayed) || !this.peer.claimRepairNotice()) return;
    // On an UNCONFIRMED pairing this is the seq trap: an impersonator connected
    // first and advanced the mark, so only a new QR recovers it.
    this.status(this.pairing.confirmedAt === null ? PAIRING_WEDGED : NEEDS_REPAIRING);
    const device = this.opts.deviceName ?? 'Origami Code';
    void this.sendToPhone({ type: 'remote/hello', v: 1, device, reset: true, desk: DESK_NONCE });
  }

  /** The table is `inbound.ts`; what stays here is the wiring, built once. */
  private dispatch(msg: unknown): Promise<void> {
    const type = (msg as { type?: unknown } | null)?.type;
    // Only the phone knows what it still HOLDS. Only a SNAPSHOT may re-open the
    // gate, though — a flap must not cash in a hydration (hydrateGate.ts).
    if (type === 'remote/snapshot' || type === 'remote/cursors') markSince(this.view?.webview, msg);
    if (type === 'remote/snapshot') this.gate.asked();
    // ...and only the phone knows which restore envelope it can open. The hello's
    // road out reaches hydrate() a frame ahead of the snapshot (`phoneCaps.ts`).
    if (type === 'remote/hello') { markCaps(this.view?.webview, helloCaps(msg)); markSince(this.view?.webview, msg); }
    this.inbound ??= {
      auth: this.auth, privilege: this.privilege, pairing: this.pairing,
      capability: () => readCapability(this.opts.config().capability), rid: () => this.rid,
      // deliver: read for the phone's CHAT (remoteOutbound.notePhone), then passed on unchanged.
      send: (m) => this.sendToPhone(m), deliver: (m) => { this.shaper?.notePhone(m); this.view?.deliver(m); },
      // The phone's own chat strip: read for the fan-out's focus, NOT delivered.
      focus: (m) => this.shaper?.notePhone(m),
      hydrate: () => this.hydrate(), revoke: (r) => this.revoke(r), status: (t) => this.status(t),
    };
    return dispatchFromPhone(msg, this.inbound);
  }

  /** The phone's `remote/snapshot`, the first hello and a socket opening on a
   *  confirmed pairing all mean "give me what a freshly attached view gets".
   *  rewireView drops the previous wiring first, so nothing doubles. */
  private hydrate(): void {
    // NOT while away: sendToPhone drops the posts and the hydration is wasted.
    if (!this.view || this.peer.paused || !this.gate.take()) return;
    this.shaper?.forget();
    this.opts.attach(this.view.host);
    void this.privilege.sendModeState(); // the mode report, behind that same burst
  }

  private status(text: string): void { this.opts.onStatus?.(text); }
}
