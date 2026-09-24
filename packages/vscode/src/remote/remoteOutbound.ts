// Origami Remote — COALESCING THE TOKEN STREAM.
//
// Applied AFTER `privilege.outbound` has stamped its approval nonce, this sits
// between that stamp and `pipes.ts` and changes NOTHING about the wire: a
// flushed delta is the same message shape one delta is, with the texts joined.
// The four delta types are posted one per TOKEN, each its own frame padded to a
// size class; buffered per (type, session, stream) and flushed every 150 ms, a
// 300-token turn becomes ~20 frames. The saving is the PADDING.
//
// ORDER IS THE RULE THAT MAKES IT SAFE: any NON-delta for the same session
// flushes it first, in call order, or a tool card lands above the text that
// introduced it. WHICH messages are worth a frame is `remoteScope.ts`; here
// lives WHICH CHAT THE PHONE IS ON, and a null focus scopes NOTHING.

import { DELTA_STREAM_FIELD, scopeOf } from './remoteScope';

/** How long a stream may buffer: 15-20 fast tokens per frame, and still live. */
export const FLUSH_MS = 150;
/** A buffer this big flushes at once, so a flush stays under `CHUNK_BUDGET_BYTES`.
 *  Measured on the RAW text; escaping past the budget is still chunked correctly. */
export const FLUSH_BYTES = 24 * 1024;

const UTF8 = new TextEncoder();

type Msg = Record<string, unknown> | null;

function field(msg: Msg, name: string): string | undefined {
  const v = msg?.[name];
  return typeof v === 'string' && v ? v : undefined;
}

interface Stream {
  base: Record<string, unknown>; // the message that OPENED it; a flush copies it
  sessionId: string;
  parts: string[];
  bytes: number;
}

/** The timer seam, injected so a test drives 300 deltas on a fake clock. */
export interface OutboundClock {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface RemoteOutboundOptions {
  /** The real send — `privilege.outbound` then `OutboundPipe.send`. */
  send: (msg: unknown) => Promise<void>;
  clock: OutboundClock;
  flushMs?: number;
  flushBytes?: number;
}

/** The DESKTOP socket's outbound shaper; what it knows about the phone is dropped on hydration. */
export class RemoteOutbound {
  private readonly streams = new Map<string, Stream>();
  private timer: unknown = null;
  private lastModelOptions = '';
  /** The chat the phone says it is on. Null until it says. */
  private confirmed: string | null = null;
  /** The chat the HOST called active — what mountPick.ts mounts on. */
  private hostActive: string | null = null;
  /** Armed by `newSession`: the next chat announced is the one the phone lands on. */
  private adoptNext = false;

  constructor(private readonly opts: RemoteOutboundOptions) {}

  /** The chat the phone is showing, as well as this side can know it. */
  public get focus(): string | null {
    return this.confirmed ?? this.hostActive;
  }

  /** A hydration is a page with NOTHING. Called before the burst. */
  public forget(): void { this.lastModelOptions = ''; this.confirmed = null; this.adoptNext = false; }

  /** Every message the PHONE sent, read for one fact: a verb naming a session
   *  names the chat the owner is acting in. */
  public notePhone(msg: unknown): void {
    const m = msg as Msg;
    const type = field(m, 'type');
    if (type === 'newSession') { this.adoptNext = true; return; }
    const sessionId = field(m, 'sessionId');
    if (!sessionId) return;
    if (type !== 'closeSession') this.setFocus(sessionId);
    else if (this.confirmed === sessionId) this.confirmed = null;
  }

  /** Host -> phone. Resolves on the wire, or at once if buffered or dropped. */
  public send(msg: unknown): Promise<void> {
    const m = msg as Msg;
    const type = field(m, 'type');
    if (!type) return this.opts.send(msg);
    const sessionId = field(m, 'sessionId');
    this.readFocusFrom(type, sessionId);
    // An unchanged catalogue is a rebroadcast the phone's picker already holds.
    if (type === 'modelOptions') {
      const json = JSON.stringify(msg);
      if (json === this.lastModelOptions) return Promise.resolve();
      this.lastModelOptions = json;
    }
    const scope = scopeOf(type, sessionId, this.focus);
    if (scope === 'drop') return Promise.resolve();
    if (scope === 'buffer' && sessionId && typeof m?.text === 'string') {
      return this.buffer(type, DELTA_STREAM_FIELD.get(type) ?? null, sessionId, m as Record<string, unknown>);
    }
    // ORDER: this session's buffers go first, synchronously, ahead of this message.
    if (sessionId) void this.flushAll(sessionId);
    return this.opts.send(msg);
  }

  /** One session's buffers, or every buffer there is — a stopping transport and
   *  an ending turn both mean the words must not sit in a Map about to be dropped. */
  public flushAll(sessionId?: string): Promise<void> {
    let last: Promise<void> = Promise.resolve();
    for (const [key, held] of [...this.streams]) {
      if (sessionId === undefined || held.sessionId === sessionId) last = this.emit(key);
    }
    if (this.streams.size === 0) this.disarm();
    return last;
  }

  // ------------------------------------------------------------- internals --

  /** The host messages mountPick.ts mounts from, mirrored here. */
  private readFocusFrom(type: string, id: string | undefined): void {
    if (!id) return;
    if (type === 'restoreActiveSession') this.hostActive = id;
    else if (type === 'sessionCreated' && this.adoptNext) {
      this.adoptNext = false;
      this.setFocus(id);
    }
  }

  private setFocus(sessionId: string): void {
    if (this.confirmed === sessionId) return;
    // Flush BEFORE the switch, or the old chat's last words hit the new chat's focus.
    void this.flushAll();
    this.confirmed = sessionId;
  }

  private buffer(type: string, streamField: string | null, sessionId: string, m: Record<string, unknown>): Promise<void> {
    const stream = streamField === null ? '' : field(m, streamField) ?? '';
    const key = `${type}\u0000${sessionId}\u0000${stream}`;
    const text = m.text as string;
    const held = this.streams.get(key);
    if (held) {
      held.parts.push(text);
      held.bytes += UTF8.encode(text).length;
      return held.bytes >= (this.opts.flushBytes ?? FLUSH_BYTES) ? this.emit(key) : Promise.resolve();
    }
    this.streams.set(key, { base: m, sessionId, parts: [text], bytes: UTF8.encode(text).length });
    this.arm();
    return Promise.resolve();
  }

  /** One buffer out, as the SAME message it opened with, texts joined. */
  private emit(key: string): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream) return Promise.resolve();
    this.streams.delete(key);
    return this.opts.send({ ...stream.base, text: stream.parts.join('') });
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.timer = this.opts.clock.setTimer(() => {
      this.timer = null;
      void this.flushAll();
    }, this.opts.flushMs ?? FLUSH_MS);
  }

  private disarm(): void {
    if (this.timer !== null) this.opts.clock.clearTimer(this.timer);
    this.timer = null;
  }
}
