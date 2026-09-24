// Origami Remote — the desktop's socket to the relay (wire spec v1, "Relay").
//
// Connects to `<relayUrl>/r/<rid>?role=desktop&after=<seq>` and does three jobs:
// reconnect with backoff, resume with `after` so the relay replays only the
// frames we missed, and hold outbound frames while the wire is down. It never
// opens, seals or inspects a frame. Both the socket and the timers are INJECTED,
// so tests drive a full disconnect/backoff/resume cycle with no clock.

export interface RemoteSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RemoteSocket;

export interface TransportDeps {
  connect: SocketFactory;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

/** Backoff schedule; the last entry repeats for ever. */
export const BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

/** The relay hands an old socket 4001 when a NEW one claims the same rid+role.
 *  Terminal: reconnecting would make two desktops evict each other in a loop. */
export const CLOSE_SUPERSEDED = 4001;

/** The stop reason a 4001 produces. `control.ts` matches on it to render "this
 *  pairing is active in another window". */
export const SUPERSEDED_REASON = 'another desktop claimed this pairing';

export interface TransportOptions {
  relayUrl: string;
  rid: string;
  /** Last seq accepted from the phone — the `?after=` value. Read at CONNECT
   *  time, so a reconnect resumes from where the codec actually got to. */
  afterSeq: () => number;
  deps: TransportDeps;
  /** Which of the relay's two roles this socket claims. The phone lane is
   *  always the desktop; a device-group link takes the role its device id order
   *  gives it (`groupCrypto.pairRole`), because the relay knows no third role. */
  role?: 'desktop' | 'phone';
  onFrame: (frame: Uint8Array) => void;
  onStatus?: (status: TransportStatus, detail?: string) => void;
  /** A relay TEXT frame: the presence control channel — see `presence.ts`. */
  onControl?: (text: string) => void;
  /** Frames held while disconnected. Bounded, so a dead phone cannot grow the heap. */
  queueLimit?: number;
  backoff?: readonly number[];
}

/** `wss://host` + rid + role -> the exact URL the relay routes on. Exported so a
 *  test can assert the query string the spec dictates. */
export function socketUrl(relayUrl: string, rid: string, after: number, role: 'desktop' | 'phone' = 'desktop'): string {
  const base = relayUrl.replace(/\/+$/, '');
  return `${base}/r/${encodeURIComponent(rid)}?role=${role}&after=${after}`;
}

export class RemoteTransport {
  private socket: RemoteSocket | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private stopped = false;
  private state: TransportStatus = 'idle';
  private readonly queue: Uint8Array[] = [];
  private readonly backoff: readonly number[];
  private readonly queueLimit: number;

  constructor(private readonly opts: TransportOptions) {
    this.backoff = opts.backoff ?? BACKOFF_MS;
    this.queueLimit = opts.queueLimit ?? 64;
  }

  public get status(): TransportStatus {
    return this.state;
  }

  public get queued(): number {
    return this.queue.length;
  }

  public start(): void {
    if (this.stopped || this.socket || this.timer) return;
    this.connect();
  }

  /** Send now if the wire is up, else queue, so a replay racing a reconnect is not lost. */
  public send(frame: Uint8Array): void {
    if (this.stopped) return;
    if (this.state === 'open' && this.socket) {
      this.socket.send(frame);
      return;
    }
    this.queue.push(frame);
    while (this.queue.length > this.queueLimit) this.queue.shift();
  }

  /** Terminal. A stopped transport never reconnects and leaves no timer armed. */
  public stop(code?: number, reason?: string): void {
    this.stopped = true;
    this.clearTimer();
    this.queue.length = 0;
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(code, reason);
      } catch {
        // A socket that is already dead is exactly what we wanted.
      }
    }
    this.setState('stopped', reason);
  }

  private connect(): void {
    this.clearTimer();
    this.setState('connecting');
    const url = socketUrl(this.opts.relayUrl, this.opts.rid, this.opts.afterSeq(), this.opts.role ?? 'desktop');
    let sock: RemoteSocket;
    try {
      sock = this.opts.deps.connect(url);
    } catch (e) {
      this.scheduleReconnect(e instanceof Error ? e.message : String(e));
      return;
    }
    this.socket = sock;
    // Node's and the browser's WebSocket default to Blob frames; we want the
    // bytes synchronously in onmessage, so ask for ArrayBuffer where supported.
    try {
      sock.binaryType = 'arraybuffer';
    } catch {
      // Read-only on some implementations — onmessage normalises anyway.
    }
    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.attempt = 0;
      this.setState('open');
      this.flush();
    };
    sock.onmessage = (ev) => {
      if (this.socket !== sock) return;
      if (typeof ev.data === 'string') return void this.opts.onControl?.(ev.data);
      const bytes = toBytes(ev.data);
      if (bytes) this.opts.onFrame(bytes);
    };
    sock.onerror = () => {
      // Every implementation follows an error with a close; reacting here would double it.
    };
    sock.onclose = (ev) => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (ev?.code === CLOSE_SUPERSEDED) {
        this.stop(undefined, SUPERSEDED_REASON);
        return;
      }
      // `||`, not `??`: a handshake the relay REFUSED (503) closes with code 1006
      // and an EMPTY reason, and `??` kept it, so the status line lost the code.
      this.scheduleReconnect(ev?.reason || (ev?.code !== undefined ? `close ${ev.code}` : undefined));
    };
  }

  private flush(): void {
    const sock = this.socket;
    if (!sock) return;
    // Splice the queue out BEFORE sending: a throwing send must not replay the backlog.
    const pending = this.queue.splice(0, this.queue.length);
    for (const frame of pending) sock.send(frame);
  }

  private scheduleReconnect(detail?: string): void {
    if (this.stopped) return;
    const wait = this.backoff[Math.min(this.attempt, this.backoff.length - 1)]!;
    this.attempt++;
    this.setState('waiting', detail);
    this.timer = this.opts.deps.setTimer(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.opts.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setState(next: TransportStatus, detail?: string): void {
    this.state = next;
    this.opts.onStatus?.(next, detail);
  }
}

/** Normalise whatever the socket hands us into bytes; anything else is dropped. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
