// A RELAY YOU CAN HOLD IN ONE HAND.
//
// `remoteInterop.test.ts` spawns the real `origami relay` binary, which is the
// right test for the wire but needs bun and a port. The hydration tests need
// something else: the same THREE relay rules, driven synchronously so a test
// can say "now the phone reloads" or "now another window takes the pairing"
// and read the result on the next tick.
//
// The rules, from `remote_wire_spec_v1.md` §Relay — and they are the rules the
// bugs these tests cover hide behind, so they are implemented, not stubbed:
//
//   1. ONE socket per role per rid. A new one replaces the old, and the old
//      gets close code 4001.
//   2. Every frame is appended to a per-rid RING and forwarded to the other
//      role if it is connected.
//   3. On connect, a role is replayed the ring frames from the OTHER role
//      whose header seq is greater than `?after=`.
//   4. PRESENCE: a TEXT control frame tells each side whether the other is
//      attached, on every open and every genuine close. A socket that was
//      REPLACED says nothing — the newcomer already holds the slot, and an
//      "absent" for it would pause a desktop whose phone is right there.
//
// Nothing here opens a frame: the ring keys on the seq in the header (bytes
// 2..5, uint32 BE), which the relay can read and the payload it cannot.

export const ROLE_DESKTOP = 1;
export const ROLE_PHONE = 2;

/** The relay's presence control frames — `packages/engine/src/relay/server.ts`
 *  and `src/remote/presence.ts` are the two ends of these exact strings. */
export const PEER_PRESENT = 'peer:present';
export const PEER_ABSENT = 'peer:absent';

/** Both transports' socket interfaces at once — `RemoteSocket` (src) has no
 *  `readyState`, `SocketLike` (webview) requires one, and they otherwise
 *  agree, so one object satisfies both. */
export interface LoopbackSocket {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

function bytesOf(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** The frame header's seq — what `?after=` is compared against. */
function other(role: number): number {
  return role === ROLE_DESKTOP ? ROLE_PHONE : ROLE_DESKTOP;
}

function seqOf(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false);
}

export class LoopbackRelay {
  private readonly ring: Array<{ role: number; seq: number; data: Uint8Array }> = [];
  private readonly live = new Map<number, LoopbackSocket>();
  /** Every frame that ever crossed, for assertions about what a side was sent.
   *  `data` is the frame VERBATIM: wire v1.3's acceptance test is an
   *  impersonator holding Ks who has every byte the relay ever saw and must
   *  still open none of them, and it cannot be written without the bytes. */
  public readonly forwarded: Array<{ role: number; seq: number; data: Uint8Array }> = [];
  /** Every presence control frame, and who it went to. */
  public readonly controls: Array<{ role: number; text: string }> = [];

  /** `?role=&after=` on one URL, so a transport's own URL builder is exercised. */
  public connect(url: string): LoopbackSocket {
    const role = /role=desktop/.test(url) ? ROLE_DESKTOP : ROLE_PHONE;
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return this.open(role, after);
  }

  public open(role: number, after: number): LoopbackSocket {
    const sock: LoopbackSocket = {
      binaryType: 'arraybuffer',
      readyState: 1,
      send: (data) => this.deliver(role, bytesOf(data)),
      close: () => {
        sock.readyState = 3;
        if (this.live.get(role) !== sock) return;
        this.live.delete(role);
        this.tell(other(role), this.live.get(other(role)), PEER_ABSENT);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    // Rule 1: the incumbent is evicted with 4001 BEFORE the newcomer opens, so
    // a side that reacts to its own eviction cannot see the new socket first.
    const old = this.live.get(role);
    this.live.set(role, sock);
    if (old) {
      old.readyState = 3;
      old.onclose?.({ code: 4001 });
    }
    // A socket never opens in the same tick it is created.
    queueMicrotask(() => {
      if (this.live.get(role) !== sock) return;
      sock.onopen?.();
      // Rule 4, before the ring: the first thing a desktop needs to know is
      // whether anything is listening, and a ring replay can be long.
      const peer = this.live.get(other(role));
      this.tell(role, sock, peer ? PEER_PRESENT : PEER_ABSENT);
      this.tell(other(role), peer, PEER_PRESENT);
      // Rule 3: replay the OTHER role's ring above `after`.
      for (const f of this.ring) {
        if (f.role !== role && f.seq > after) sock.onmessage?.({ data: f.data });
      }
    });
    return sock;
  }

  /** A control frame. TEXT, so neither transport can mistake it for a frame. */
  private tell(role: number, sock: LoopbackSocket | undefined, text: string): void {
    if (!sock || sock.readyState !== 1) return;
    this.controls.push({ role, text });
    sock.onmessage?.({ data: text });
  }

  private deliver(role: number, data: Uint8Array): void {
    const seq = seqOf(data);
    this.ring.push({ role, seq, data });
    this.forwarded.push({ role, seq, data });
    const peer = this.live.get(role === ROLE_DESKTOP ? ROLE_PHONE : ROLE_DESKTOP);
    if (peer && peer.readyState === 1) peer.onmessage?.({ data });
  }

  /** Drop a side's socket without a 4001 — what a closing VS Code window does. */
  public dropDesktop(): void {
    this.drop(ROLE_DESKTOP);
  }

  /** The same for the phone: a backgrounded Safari tab, not a revoke. */
  public dropPhone(): void {
    this.drop(ROLE_PHONE);
  }

  private drop(role: number): void {
    const sock = this.live.get(role);
    if (!sock) return;
    this.live.delete(role);
    sock.readyState = 3;
    sock.onclose?.({ code: 1000 });
    this.tell(other(role), this.live.get(other(role)), PEER_ABSENT);
  }

  /** Frames the DESKTOP has put on the wire. The count that proves a paused
   *  fan-out: while the phone is absent this must not move. */
  public get desktopFrames(): number {
    return this.forwarded.filter((f) => f.role === ROLE_DESKTOP).length;
  }
}

/** Let every queued microtask AND the seal/open promise chains finish. Frames
 *  cross on a promise tail at both ends, so one tick is never enough. */
export async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
