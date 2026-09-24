// ONE SEALED LINK between this desk and one other endpoint in the group.
//
// It is the phone lane's three leaves wired for a peer that is a DESK: the
// transport (socket, backoff, resume), the codec (seal, replay guard, seq) and
// the presence control channel. What it does NOT have is the phone lane's
// device-key exchange: both ends already hold Kg from the OS keychain. Kg
// crosses the wire once, sealed inside the join welcome after the owner
// accepts (t-sj32zl), and never on a pairwise link.
//
// It carries JSON objects and knows nothing about what they mean. The roster,
// the mother-base flag and the hello are groupController.ts's business; a link
// that understood them could not be reused for the join rendezvous, which is
// the same socket rules with a different rid.
//
// The seq counter persists per RID in seqStore.ts, exactly as the phone's does:
// the relay's ring replays what a reconnecting socket missed, and a counter
// that restarted at 1 would have every one of those frames rejected as a replay.

import type { RemoteKey } from './crypto';
import { FrameError, type Role } from './frame';
import type { FrameCodec } from './frameCodec';
import { roleQuery } from './groupCrypto';
import { PeerState, type PeerEdge, type Presence } from './presence';
import { linkCodec, noteIn } from './seqStore';
import { RemoteTransport, type TransportDeps, type TransportStatus } from './transport';

export interface GroupLinkOptions {
  relayUrl: string;
  rid: string;
  key: RemoteKey;
  role: Role;
  deps: TransportDeps;
  /** A decoded, replay-checked message from the peer. */
  onMessage: (msg: Record<string, unknown>) => void;
  /** Every presence edge, so the owner can say hello on `arrived`. */
  onPresence?: (presence: Presence, edge: PeerEdge) => void;
  onStatus?: (text: string) => void;
}

export class GroupLink {
  private readonly codec: FrameCodec;
  private readonly transport: RemoteTransport;
  private readonly peer = new PeerState();
  /** Decrypts resolve OUT OF ORDER under load while seq is checked in CALL
   *  order, so inbound is serialised on a tail — the phone lane's rule. */
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly opts: GroupLinkOptions) {
    this.codec = linkCodec(opts.key, opts.rid, opts.role);
    this.transport = new RemoteTransport({
      relayUrl: opts.relayUrl,
      rid: opts.rid,
      role: roleQuery(opts.role),
      afterSeq: () => this.codec.afterSeq,
      deps: opts.deps,
      onFrame: (frame) => this.receive(frame),
      onControl: (text) => this.control(text),
      onStatus: (status, detail) => this.status(status, detail),
    });
  }

  public get rid(): string {
    return this.opts.rid;
  }

  public get connected(): boolean {
    return this.transport.status === 'open';
  }

  /** What the relay says about the other socket. `unknown` is NOT absent. */
  public get presence(): Presence {
    return this.peer.presence;
  }

  public start(): void {
    this.transport.start();
  }

  public stop(reason?: string): void {
    this.stopped = true;
    this.transport.stop(undefined, reason);
  }

  /** Seal and send. Nothing is sent while the relay says the peer is gone: the
   *  ring would hold it for 90 s and the seq would burn either way. */
  public send(msg: Record<string, unknown>): Promise<void> {
    if (this.stopped || this.peer.paused) return Promise.resolve();
    return this.codec
      .encode(JSON.stringify(msg))
      .then((frame) => this.transport.send(frame))
      .catch((e) => this.opts.onStatus?.(`group: could not seal a frame — ${message(e)}`));
  }

  private control(text: string): void {
    const edge = this.peer.note(text);
    this.opts.onPresence?.(this.peer.presence, edge);
  }

  private status(status: TransportStatus, detail?: string): void {
    if (status === 'open') this.peer.reset();
    this.opts.onStatus?.(`group ${short(this.opts.rid)}: ${status}${detail ? ` (${detail})` : ''}`);
  }

  private receive(frame: Uint8Array): void {
    this.tail = this.tail.then(async () => {
      try {
        const decoded = await this.codec.decode(frame);
        noteIn(this.opts.rid, decoded.seq);
        const msg = JSON.parse(decoded.json) as Record<string, unknown>;
        this.opts.onMessage(msg);
      } catch (e) {
        // A rejected frame is NAMED, never guessed at: "replay" and "gcm" are
        // different faults and only one of them means a desk needs re-pairing.
        const reason = e instanceof FrameError ? e.reason : 'parse';
        this.opts.onStatus?.(`group ${short(this.opts.rid)}: rejected a frame (${reason})`);
      }
    });
  }
}

function short(rid: string): string {
  return rid.slice(0, 6);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
