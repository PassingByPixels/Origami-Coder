// Origami Remote — the relay socket. Driven entirely by a SCRIPTED fake:
// no real WebSocket, no real clock, no network. The fake is the whole point —
// reconnect, `after=` resume and queue flush are timing behaviours, and a
// test that could only observe them through a real socket would be a flake.
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS,
  CLOSE_SUPERSEDED,
  RemoteTransport,
  socketUrl,
  type RemoteSocket,
  type TransportDeps,
  type TransportStatus,
} from '../../../src/remote/transport';

class FakeSocket implements RemoteSocket {
  public readonly sent: Uint8Array[] = [];
  public closed: { code?: number; reason?: string } | null = null;
  public binaryType = 'blob';
  public onopen: (() => void) | null = null;
  public onmessage: ((ev: { data: unknown }) => void) | null = null;
  public onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;

  constructor(public readonly url: string) {}

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  // --- what the RELAY does, in the test's hands ---
  public accept(): void {
    this.onopen?.();
  }

  public deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  public drop(code = 1006, reason?: string): void {
    this.onclose?.({ code, reason });
  }
}

interface Rig {
  deps: TransportDeps;
  sockets: FakeSocket[];
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  runTimers(): void;
}

function rig(opts: { failConnect?: number } = {}): Rig {
  const sockets: FakeSocket[] = [];
  const timers: Rig['timers'] = [];
  let connects = 0;
  return {
    sockets,
    timers,
    deps: {
      connect: (url) => {
        if (opts.failConnect && ++connects <= opts.failConnect) throw new Error('connect refused');
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clearTimer: (h) => {
        const t = timers[h as number];
        if (t) t.cleared = true;
      },
    },
    runTimers(): void {
      for (const t of timers) {
        if (!t.cleared) {
          t.cleared = true;
          t.fn();
        }
      }
    },
  };
}

function build(r: Rig, after: () => number = () => 0) {
  const frames: Uint8Array[] = [];
  const states: TransportStatus[] = [];
  const t = new RemoteTransport({
    relayUrl: 'wss://relay.example',
    rid: 'RID-1',
    afterSeq: after,
    deps: r.deps,
    onFrame: (f) => frames.push(f),
    onStatus: (s) => states.push(s),
  });
  return { t, frames, states };
}

describe('remote transport — the URL the spec routes on', () => {
  it('is /r/<rid>?role=desktop&after=<seq>', () => {
    expect(socketUrl('wss://relay.example', 'ABC-_1', 0)).toBe('wss://relay.example/r/ABC-_1?role=desktop&after=0');
  });

  it('tolerates a trailing slash on the configured relay url', () => {
    expect(socketUrl('wss://relay.example/', 'R', 7)).toBe('wss://relay.example/r/R?role=desktop&after=7');
  });
});

describe('remote transport — connect', () => {
  it('opens one socket at the after=0 the relay defaults to', () => {
    const r = rig();
    const { t, states } = build(r);
    t.start();
    expect(r.sockets).toHaveLength(1);
    expect(r.sockets[0]!.url).toContain('after=0');
    expect(states).toEqual(['connecting']);
    r.sockets[0]!.accept();
    expect(t.status).toBe('open');
  });

  it('asks for arraybuffer frames rather than blobs', () => {
    const r = rig();
    build(r).t.start();
    expect(r.sockets[0]!.binaryType).toBe('arraybuffer');
  });

  it('start() is idempotent — a second call opens no second socket', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    t.start();
    expect(r.sockets).toHaveLength(1);
  });

  it('normalises ArrayBuffer and Uint8Array deliveries, and drops text', () => {
    const r = rig();
    const { t, frames } = build(r);
    t.start();
    r.sockets[0]!.accept();
    r.sockets[0]!.deliver(new Uint8Array([1, 2]).buffer);
    r.sockets[0]!.deliver(new Uint8Array([3]));
    r.sockets[0]!.deliver('a text frame the relay never sends');
    expect(frames.map((f) => [...f])).toEqual([[1, 2], [3]]);
  });
});

describe('remote transport — the outbound queue', () => {
  it('holds frames while disconnected and flushes them IN ORDER on open', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    t.send(new Uint8Array([1]));
    t.send(new Uint8Array([2]));
    expect(t.queued).toBe(2);
    expect(r.sockets[0]!.sent).toHaveLength(0);
    r.sockets[0]!.accept();
    expect(r.sockets[0]!.sent.map((f) => [...f])).toEqual([[1], [2]]);
    expect(t.queued).toBe(0);
  });

  it('sends straight through once open', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    r.sockets[0]!.accept();
    t.send(new Uint8Array([9]));
    expect(r.sockets[0]!.sent.map((f) => [...f])).toEqual([[9]]);
  });

  it('drops the OLDEST frames rather than growing without limit', () => {
    const r = rig();
    const t = new RemoteTransport({
      relayUrl: 'wss://relay.example',
      rid: 'R',
      afterSeq: () => 0,
      deps: r.deps,
      onFrame: () => {},
      queueLimit: 3,
    });
    t.start();
    for (let i = 1; i <= 5; i++) t.send(new Uint8Array([i]));
    r.sockets[0]!.accept();
    expect(r.sockets[0]!.sent.map((f) => [...f])).toEqual([[3], [4], [5]]);
  });
});

describe('remote transport — reconnect and resume', () => {
  it('backs off after a drop, then reconnects with the CURRENT after= seq', () => {
    const r = rig();
    let peerSeq = 0;
    const { t, states } = build(r, () => peerSeq);
    t.start();
    r.sockets[0]!.accept();
    peerSeq = 12; // the codec accepted twelve frames from the phone
    r.sockets[0]!.drop();
    expect(t.status).toBe('waiting');
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]!.ms).toBe(BACKOFF_MS[0]);
    r.runTimers();
    expect(r.sockets).toHaveLength(2);
    expect(r.sockets[1]!.url).toContain('after=12');
    expect(states).toContain('waiting');
  });

  it('lengthens the backoff while it keeps failing, then resets after a success', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    for (let i = 0; i < 3; i++) {
      r.sockets.at(-1)!.drop();
      r.runTimers();
    }
    expect(r.timers.map((x) => x.ms)).toEqual([BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2]]);
    r.sockets.at(-1)!.accept();
    r.sockets.at(-1)!.drop();
    r.runTimers();
    expect(r.timers.at(-1)!.ms).toBe(BACKOFF_MS[0]);
  });

  it('backs off when the socket factory itself throws', () => {
    const r = rig({ failConnect: 1 });
    const { t } = build(r);
    t.start();
    expect(t.status).toBe('waiting');
    r.runTimers();
    expect(r.sockets).toHaveLength(1);
  });

  it('does NOT reconnect after close 4001 — another desktop claimed the pairing', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    r.sockets[0]!.accept();
    r.sockets[0]!.drop(CLOSE_SUPERSEDED);
    expect(t.status).toBe('stopped');
    r.runTimers();
    expect(r.sockets).toHaveLength(1);
  });

  // A REFUSAL THE OWNER CAN SEE.
  //
  // The relay answers 503 to a new rid when its daily budget is spent (and to
  // any socket past --max-connections). A refused UPGRADE reaches a WebSocket
  // client as code 1006 with an EMPTY reason — no status, no text. The status
  // line built that detail with `??`, and '' is not nullish, so the code was
  // thrown away and the pane said "remote: waiting" with nothing to search
  // for. That is the whole diagnosis the owner had for an afternoon.
  it('names the close CODE when the relay refuses with an empty reason', () => {
    const r = rig();
    const details: Array<string | undefined> = [];
    const t = new RemoteTransport({
      relayUrl: 'wss://relay.example',
      rid: 'RID-1',
      afterSeq: () => 0,
      deps: r.deps,
      onFrame: () => {},
      onStatus: (_s, detail) => details.push(detail),
    });
    t.start();
    r.sockets[0]!.drop(1006, '');
    expect(details).toContain('close 1006');
  });

  it('ignores events from a socket it has already replaced', () => {
    const r = rig();
    const { t, frames } = build(r);
    t.start();
    const stale = r.sockets[0]!;
    stale.drop();
    r.runTimers();
    stale.deliver(new Uint8Array([7]));
    stale.accept();
    expect(frames).toHaveLength(0);
    expect(t.status).not.toBe('open');
  });
});

describe('remote transport — stop', () => {
  it('closes the socket, clears the queue and arms no further timer', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    r.sockets[0]!.accept();
    t.send(new Uint8Array([1]));
    t.stop();
    expect(r.sockets[0]!.closed).not.toBeNull();
    expect(t.status).toBe('stopped');
    t.send(new Uint8Array([2]));
    expect(t.queued).toBe(0);
    r.runTimers();
    expect(r.sockets).toHaveLength(1);
  });

  it('cancels a pending reconnect timer', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    r.sockets[0]!.drop();
    expect(r.timers[0]!.cleared).toBe(false);
    t.stop();
    expect(r.timers[0]!.cleared).toBe(true);
  });

  it('a stopped transport cannot be restarted by start()', () => {
    const r = rig();
    const { t } = build(r);
    t.start();
    t.stop();
    t.start();
    expect(r.sockets).toHaveLength(1);
  });
});
