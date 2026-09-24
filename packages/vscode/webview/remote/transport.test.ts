// Transport tests against a FAKE RELAY that speaks the real wire format: it
// opens what the phone sealed and seals what it replies with, using the same
// Ks. Nothing here inspects the transport's internals; a frame the fake cannot
// open is a failure, which is the only property the desktop lane will care
// about when the two halves finally meet.
import { describe, expect, it, vi } from 'vitest';
import { ROLE_DESKTOP, ROLE_PHONE, deriveKey, deriveRid, openFrame, sealFrame } from './crypto';
import { MAX_MESSAGE_BYTES } from './chunk';
import { WireKeys } from './sessionKey';
import { RemoteTransport, type SocketLike } from './transport';

const KS = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);

/** One socket the test drives by hand. `sent` holds the raw phone frames. */
class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: ArrayBuffer): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate the relay accepting the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(null);
  }

  /** Simulate the relay dropping the connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  /** Simulate the relay replacing this socket with a newer one for the same
   *  rid+role — close 4001, per the wire spec's "Relay" section. */
  evict(): void {
    this.readyState = 3;
    this.onclose?.({ code: 4001 });
  }

  deliver(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }
}

/** A transport wired to a controllable relay. Backoff is instant. */
async function harness() {
  const key = await deriveKey(KS);
  const rid = await deriveRid(KS);
  const sockets: FakeSocket[] = [];
  const received: unknown[] = [];
  const rejected: string[] = [];
  const statuses: string[] = [];
  const timers: Array<() => void> = [];

  const transport = new RemoteTransport({
    keys: new WireKeys(key, rid),
    url: (after) => `wss://relay/r/${rid}?role=phone&after=${after}`,
    onMessage: (m) => void received.push(m),
    onReject: (r) => void rejected.push(r),
    onStatus: (s) => void statuses.push(s),
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    backoff: [0],
    setTimeoutFn: (fn) => void timers.push(fn),
  });

  /** Seal a desktop->phone frame the way the real desktop would. */
  const fromDesktop = (seq: number, msg: unknown) => sealFrame(key, rid, ROLE_DESKTOP, seq, msg);
  /** Open a phone->desktop frame the way the real desktop would. */
  const asDesktop = (frame: Uint8Array) => openFrame(key, rid, frame);

  return { transport, sockets, received, rejected, statuses, timers, fromDesktop, asDesktop, key, rid };
}

const last = <T,>(a: T[]): T => a[a.length - 1];

describe('RemoteTransport — outbound', () => {
  it('seals a webview message into a frame the desktop can open', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const msg = { type: 'send', text: 'hello from the phone', sessionId: 's1' };
    await h.transport.send(msg);

    expect(h.sockets[0].sent).toHaveLength(1);
    const opened = await h.asDesktop(h.sockets[0].sent[0]);
    expect(opened.role).toBe(ROLE_PHONE);
    expect(opened.message).toEqual(msg);
  });

  it('sets binaryType to arraybuffer, or every inbound frame arrives as a Blob', async () => {
    const h = await harness();
    h.transport.connect();
    expect(h.sockets[0].binaryType).toBe('arraybuffer');
  });

  it('numbers FRAMES: seq starts at 1 and advances by exactly one per frame', async () => {
    // The desktop reads seq as a frame count — its replay ring and our
    // `after` both index on it — so a chunk-group id must not consume one.
    // A draft that shared the counter emitted 2, 4, 6 and burnt half the
    // 32-bit space for nothing.
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    await h.transport.send({ type: 'a' });
    await h.transport.send({ type: 'b' });
    await h.transport.send({ type: 'c' });
    const seqs = await Promise.all(h.sockets[0].sent.map(async (f) => (await h.asDesktop(f)).seq));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('numbers every chunk of a split message as its own consecutive frame', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    await h.transport.send({ type: 'big', text: 'z'.repeat(MAX_MESSAGE_BYTES * 2) });
    const seqs = await Promise.all(h.sockets[0].sent.map(async (f) => (await h.asDesktop(f)).seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('KEEPS the seq increasing across a reconnect', async () => {
    // Restarting at 1 would make every frame of the new socket look like a
    // replay to the desktop, which drops them all. This is the regression.
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    await h.transport.send({ type: 'before' });
    const beforeSeq = (await h.asDesktop(h.sockets[0].sent[0])).seq;

    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    h.sockets[1].open();
    await h.transport.send({ type: 'after' });
    const afterSeq = (await h.asDesktop(h.sockets[1].sent[0])).seq;

    expect(afterSeq).toBeGreaterThan(beforeSeq);
  });

  it('drops (and reports) a send made while the socket is down', async () => {
    const h = await harness();
    h.transport.connect();
    await h.transport.send({ type: 'too early' });
    expect(h.sockets[0].sent).toHaveLength(0);
    expect(last(h.rejected)).toMatch(/socket not open/);
  });

  it('chunks an oversized message into frames the desktop reassembles', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const big = { type: 'send', sessionId: 's1', text: 'z'.repeat(MAX_MESSAGE_BYTES * 2) };
    await h.transport.send(big);

    expect(h.sockets[0].sent.length).toBeGreaterThan(1);
    const parts: string[] = [];
    for (const f of h.sockets[0].sent) {
      const m = (await h.asDesktop(f)).message as { type: string; i: number; n: number; part: string };
      expect(m.type).toBe('remote/chunk');
      expect(m.n).toBe(h.sockets[0].sent.length);
      parts[m.i] = m.part;
    }
    expect(JSON.parse(parts.join(''))).toEqual(big);
    // Every frame must stay under the relay's 65,536-byte close-4002 cap.
    for (const f of h.sockets[0].sent) expect(f.length).toBeLessThanOrEqual(65536);
  });
});

describe('RemoteTransport — inbound', () => {
  it('opens a desktop frame and hands the message on unchanged', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const msg = { type: 'sessionCreated', sessionId: 's1', sessionNumber: 1, agentName: 'Tsuru' };
    h.sockets[0].deliver(await h.fromDesktop(1, msg));
    await vi.waitFor(() => expect(h.received).toEqual([msg]));
  });

  it('reassembles a CHUNKED desktop message before dispatching it once', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const big = { type: 'restoreMessages', sessionId: 's1', messages: [{ kind: 'agent', text: 'q'.repeat(MAX_MESSAGE_BYTES * 2) }] };
    const json = JSON.stringify(big);
    const half = Math.ceil(json.length / 2);
    h.sockets[0].deliver(await h.fromDesktop(1, { type: 'remote/chunk', id: 'r1', i: 0, n: 2, part: json.slice(0, half) }));
    h.sockets[0].deliver(await h.fromDesktop(2, { type: 'remote/chunk', id: 'r1', i: 1, n: 2, part: json.slice(half) }));
    await vi.waitFor(() => expect(h.received).toEqual([big]));
  });

  // --- MUTATION PROOF 2: a replayed frame never reaches the webview. --------
  it('REJECTS a replayed frame (same seq delivered twice)', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const frame = await h.fromDesktop(1, { type: 'sessionCreated', sessionId: 's1' });
    h.sockets[0].deliver(frame);
    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    h.sockets[0].deliver(frame);
    await vi.waitFor(() => expect(last(h.rejected)).toMatch(/replayed seq 1 <= 1/));
    expect(h.received).toHaveLength(1);
  });

  it('REJECTS an out-of-order frame whose seq went backwards', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(await h.fromDesktop(5, { type: 'a' }));
    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    h.sockets[0].deliver(await h.fromDesktop(4, { type: 'b' }));
    await vi.waitFor(() => expect(last(h.rejected)).toMatch(/replayed seq 4 <= 5/));
    expect(h.received).toHaveLength(1);
  });

  it('REJECTS a frame claiming to be from another PHONE, not the desktop', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(await sealFrame(h.key, h.rid, ROLE_PHONE, 1, { type: 'send', text: 'spoof' }));
    await vi.waitFor(() => expect(last(h.rejected)).toMatch(/role 2, not the desktop/));
    expect(h.received).toEqual([]);
  });

  it('REJECTS a frame sealed for a different room without killing the socket', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(await sealFrame(h.key, 'someOtherRoom', ROLE_DESKTOP, 1, { type: 'a' }));
    await vi.waitFor(() => expect(last(h.rejected)).toMatch(/did not open/));
    // The socket survives, and the next legitimate frame still lands.
    h.sockets[0].deliver(await h.fromDesktop(1, { type: 'b' }));
    await vi.waitFor(() => expect(h.received).toEqual([{ type: 'b' }]));
    expect(h.sockets[0].closed).toBe(false);
  });

  it('REJECTS a text frame instead of trying to parse it', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].onmessage?.({ data: '{"type":"send"}' });
    await vi.waitFor(() => expect(last(h.rejected)).toMatch(/non-binary/));
  });
});

describe('RemoteTransport — reconnect', () => {
  it('asks the relay to replay AFTER the last seq it actually accepted', async () => {
    const h = await harness();
    h.transport.connect();
    expect(h.sockets[0].url).toMatch(/after=0$/);
    h.sockets[0].open();
    h.sockets[0].deliver(await h.fromDesktop(1, { type: 'a' }));
    h.sockets[0].deliver(await h.fromDesktop(2, { type: 'b' }));
    h.sockets[0].deliver(await h.fromDesktop(3, { type: 'c' }));
    await vi.waitFor(() => expect(h.received).toHaveLength(3));

    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    expect(h.transport.after).toBe(3);
    expect(h.sockets[1].url).toMatch(/after=3$/);
  });

  // INTEROP DEFECT, caught by remoteInterop.test.ts against a real relay: the
  // relay's one-socket-per-role rule is symmetric, so a second shell on one
  // pairing evicts the first with close 4001. The close CODE was being dropped
  // here, so the evicted shell reconnected and evicted the other one back —
  // measured at 7 reconnects in 400 ms, and every cycle re-runs onOpen, which
  // asks the desktop for a fresh hydration. The desktop lane already treats
  // 4001 as terminal (transport.ts CLOSE_SUPERSEDED); both ends must, or the
  // rule that "whoever connected last wins" has no winner.
  it('STOPS on close 4001 rather than reconnecting into an eviction loop', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].evict();
    h.timers.forEach((f) => f());

    expect(h.sockets).toHaveLength(1);
    expect(last(h.statuses)).toBe('closed');
    expect(h.rejected.some((r) => /another phone/i.test(r))).toBe(true);
  });

  it('still reconnects on an ORDINARY close — a screen lock is not an eviction', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    expect(h.sockets).toHaveLength(2);
  });

  // A REPLACED socket keeps firing. reconnect() clears `this.socket` as its
  // first statement, before it looks at closedByUs or the close code, so a
  // close arriving from an already-replaced socket used to drop the live one
  // and schedule a reconnect nobody asked for — the connection the user is
  // actually on, thrown away by a dead one's event. The desktop lane has
  // guarded this since it was written; the phone lane had not.
  // Mutation: delete `if (this.socket === sock)` from onclose -> red here.
  it('IGNORES a close event from a socket it has already replaced', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const stale = h.sockets[0];

    h.transport.connect(); // the live socket from here on
    h.sockets[1].open();
    expect(h.sockets).toHaveLength(2);

    stale.drop(); // the replaced socket's close lands late
    h.timers.forEach((f) => f());

    // No third socket: the stale close neither reconnected nor was mistaken
    // for the live one going away.
    expect(h.sockets).toHaveLength(2);
    expect(last(h.statuses)).toBe('open');

    // ...and the live socket is still the one we send on.
    await h.transport.send({ type: 'send', text: 'still connected' });
    expect(h.sockets[1].sent).toHaveLength(1);
    expect((await h.asDesktop(h.sockets[1].sent[0])).message).toEqual({ type: 'send', text: 'still connected' });
  });

  // INTEROP DEFECT, caught by remoteInterop.test.ts (c) against a real relay and
  // then pinned down with wire logging: the desktop SENT seqs [1..7] and the
  // relay DELIVERED [1..7], but the phone kept 3,4,6,7 and rejected 5 as a
  // replay. Nothing on the wire was wrong — onmessage fired `void receive(...)`
  // per frame, so N receives ran concurrently, each awaiting its own decrypt.
  // Decrypts resolve out of order, lastRecvSeq advanced in RESOLUTION order,
  // and the frame that finished late was dropped as a replay. Silently, and
  // for good: that is a lost transcript message on a real phone.
  //
  // The real race needs load to show up, so the decrypt ORDER is made explicit
  // here instead: the first inbound decrypt is held back so the second
  // finishes first. Mutation: unchain onmessage back to `void this.receive(...)`
  // -> red, with only the second message delivered.
  it('serialises inbound frames: a fast decrypt cannot overtake a slow one', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    const a = { type: 'agentText', sessionId: 's1', text: 'first' };
    const b = { type: 'agentText', sessionId: 's1', text: 'second' };
    const f1 = await h.fromDesktop(1, a);
    const f2 = await h.fromDesktop(2, b);

    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let nth = 0;
    const spy = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockImplementation(async (...args: Parameters<typeof realDecrypt>) => {
        const mine = nth++;
        const out = await realDecrypt(...args);
        if (mine === 0) await new Promise((r) => setTimeout(r, 30));
        return out;
      });

    h.sockets[0].deliver(f1);
    h.sockets[0].deliver(f2);
    await vi.waitFor(() => expect(h.received.length + h.rejected.length).toBe(2), { timeout: 3000 });
    spy.mockRestore();

    expect(h.rejected).toEqual([]);
    expect(h.received).toEqual([a, b]);
    expect(h.transport.after).toBe(2);
  });

  it('does NOT advance `after` past a frame it refused, so the replay refetches it', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(await h.fromDesktop(1, { type: 'a' }));
    await vi.waitFor(() => expect(h.received).toHaveLength(1));
    h.sockets[0].deliver(await sealFrame(h.key, 'wrongRoom', ROLE_DESKTOP, 2, { type: 'b' }));
    await vi.waitFor(() => expect(h.rejected).toHaveLength(1));

    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    expect(h.sockets[1].url).toMatch(/after=1$/);
  });

  it('tolerates the ring re-sending frames we already have after a reconnect', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    h.sockets[0].deliver(await h.fromDesktop(1, { type: 'a' }));
    h.sockets[0].deliver(await h.fromDesktop(2, { type: 'b' }));
    await vi.waitFor(() => expect(h.received).toHaveLength(2));

    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    h.sockets[1].open();
    h.sockets[1].deliver(await h.fromDesktop(2, { type: 'b' })); // stale ring entry
    h.sockets[1].deliver(await h.fromDesktop(3, { type: 'c' }));
    await vi.waitFor(() => expect(h.received).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]));
  });

  it('re-handshakes on every open, not just the first', async () => {
    const opens: number[] = [];
    const key = await deriveKey(KS);
    const rid = await deriveRid(KS);
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const t = new RemoteTransport({
      keys: new WireKeys(key, rid),
      url: (a) => `wss://relay/?after=${a}`,
      onMessage: () => {},
      onOpen: () => void opens.push(sockets.length),
      socketFactory: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      backoff: [0],
      setTimeoutFn: (fn) => void timers.push(fn),
    });
    t.connect();
    sockets[0].open();
    sockets[0].drop();
    timers.forEach((f) => f());
    sockets[1].open();
    expect(opens).toEqual([1, 2]);
  });

  it('reports connecting -> open -> closed, and stops reconnecting on close()', async () => {
    const h = await harness();
    h.transport.connect();
    h.sockets[0].open();
    expect(h.statuses).toEqual(['connecting', 'open']);
    h.transport.close();
    expect(last(h.statuses)).toBe('closed');
    expect(h.sockets[0].closed).toBe(true);
    // A close event arriving after our own close must not start a ladder.
    h.sockets[0].drop();
    h.timers.forEach((f) => f());
    expect(h.sockets).toHaveLength(1);
  });
});
