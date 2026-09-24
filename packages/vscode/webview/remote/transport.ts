// Origami Remote — the phone's socket: seal out, open in, and survive the
// reconnect a phone guarantees (screen lock, backgrounding, a walk between two
// towers). ORDER is the load-bearing property in BOTH directions; the counters
// that carry it across a RELOAD live in `seq.ts`.

import { ChunkAssembler, splitMessage } from './chunk';
import { SeqCounter, type SeqStore } from './seq';
import { ROLE_DESKTOP, ROLE_PHONE } from './crypto';
import type { WireKeys } from './sessionKey';

/** Relay close for "a newer socket claimed this rid+role". Terminal on both
 *  ends, or two shells evict each other for ever. */
export const CLOSE_SUPERSEDED = 4001;

/** The slice of WebSocket this module uses, so a test can supply a fake. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface TransportOptions {
  keys: WireKeys; // this socket's K/K', the rid, and the version rules
  /** Called with `after` so the caller builds the ?after= URL. */
  url: (after: number) => string;
  onMessage: (msg: unknown) => void;
  /** After each successful (re)connect, so the owner can re-handshake. */
  onOpen?: () => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  /** A frame that failed to open, or replayed. Never fatal: the socket stays. */
  onReject?: (reason: string) => void;
  /** Persisted marks: omitted = start at 0, right only for a NEW pairing. */
  seq?: SeqStore;
  socketFactory?: SocketFactory;
  /** Reconnect delay ladder, ms. Overridden in tests to keep them instant. */
  backoff?: number[];
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export class RemoteTransport {
  private socket: SocketLike | undefined;
  /** Chunk-group ids. A SEPARATE counter: seq numbers FRAMES (the relay's ring
   *  and our `after` are both frame counts), so this must never consume one. */
  private groupId = 0;
  private readonly seq: SeqCounter;
  /** Frames ONE AT A TIME in BOTH directions, on tails kept RESOLVED. Seals and
   *  decrypts resolve out of order while seq is assigned and checked in CALL
   *  order, so unchained handlers put seq 2 on the wire before seq 1. */
  private recvTail: Promise<void> = Promise.resolve();
  private sendTail: Promise<void> = Promise.resolve();
  private attempt = 0;
  private closedByUs = false;
  private readonly assembler = new ChunkAssembler();
  private readonly backoff: number[];
  private readonly schedule: (fn: () => void, ms: number) => unknown;

  constructor(private readonly opts: TransportOptions) {
    this.seq = new SeqCounter(opts.seq);
    this.backoff = opts.backoff ?? [500, 1000, 2000, 5000, 10000];
    this.schedule = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** What the next reconnect asks the relay to replay after. */
  get after(): number { return this.seq.after; }

  connect(): void {
    this.closedByUs = false;
    this.opts.onStatus?.('connecting');
    const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const sock = factory(this.opts.url(this.seq.after));
    sock.binaryType = 'arraybuffer';
    this.socket = sock;
    // Handlers ask "am I still the live socket?": a replaced socket goes on
    // firing, so a late close would drop a healthy newer one. onmessage CHAINS.
    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.opts.keys.reset(); this.attempt = 0; // a new socket = a new K'
      this.opts.onStatus?.('open');
      this.opts.onOpen?.();
    };
    sock.onmessage = (ev) => { if (this.socket !== sock) return; this.recvTail = this.recvTail.then(() => this.receive(ev.data)).catch((e) => this.opts.onReject?.(String(e))); };
    sock.onclose = (ev) => { if (this.socket === sock) this.reconnect(ev?.code); };
    sock.onerror = () => {}; // onclose always follows; both would double the ladder
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
    this.socket = undefined;
    this.opts.onStatus?.('closed');
  }

  /** Seal and send one webview message, chunking it if it will not fit a frame.
   *  Serialised on `sendTail`, so the WIRE order is the CALL order. */
  send(message: unknown): Promise<void> {
    const done = this.sendTail.then(() => this.seal(message));
    this.sendTail = done.catch(() => {});
    return done;
  }

  private async seal(message: unknown): Promise<void> {
    const id = `c${++this.groupId}-${Date.now().toString(36)}`;
    for (const part of splitMessage(message, id)) {
      const frame = await this.opts.keys.seal(ROLE_PHONE, this.seq.next(), part);
      const sock = this.socket;
      if (!sock || sock.readyState !== 1) {
        this.opts.onReject?.('socket not open — message dropped');
        return;
      }
      sock.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
    }
  }

  private async receive(data: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else return this.opts.onReject?.('non-binary frame');

    let opened;
    try {
      opened = await this.opts.keys.open(bytes);
    } catch (err) {
      // A GCM failure, a wrong key, a wrong room and a tampered header all mean
      // the same thing here: not ours.
      return this.opts.onReject?.(`frame did not open: ${(err as Error).message}`);
    }
    if (opened.role !== ROLE_DESKTOP) return this.opts.onReject?.(`frame from role ${opened.role}, not the desktop`);
    // Replay: the relay's ring legitimately re-sends frames we already hold, so
    // this arm is a NORMAL path as well as the attack guard. Drop either way.
    if (!this.seq.accept(opened.seq)) return this.opts.onReject?.(`replayed seq ${opened.seq} <= ${this.seq.after}`);

    let msg: unknown;
    try {
      msg = this.assembler.accept(opened.message);
    } catch (err) {
      return this.opts.onReject?.(`chunk rejected: ${(err as Error).message}`);
    }
    if (msg !== undefined) this.opts.onMessage(msg);
  }

  private reconnect(code?: number): void {
    this.socket = undefined;
    if (this.closedByUs) return;
    this.opts.onStatus?.('closed');
    // 4001 = the relay gave this room to a NEWER socket for our role (a second
    // shell). Reconnecting would evict it right back, so last-connected wins.
    if (code === CLOSE_SUPERSEDED) {
      this.closedByUs = true;
      this.opts.onReject?.('another phone claimed this pairing');
      return;
    }
    const delay = this.backoff[Math.min(this.attempt++, this.backoff.length - 1)];
    this.schedule(() => this.connect(), delay);
  }
}
