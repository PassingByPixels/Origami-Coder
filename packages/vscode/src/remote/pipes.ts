// Origami Remote — THE TWO ENDS OF THE CODEC. `InboundPipe`: bytes from the
// relay, turned into one message or one named rejection. `OutboundPipe`: one
// message, turned into the frames that carry it, in call order.
//
// The REPLAY arm is why this has a shape rather than a boolean. A phone whose
// `localStorage` seq marks are gone starts at 1 again, so its `remote/hello` is
// rejected as a replay — correctly, and the guard is NOT weakened here. But the
// frame opened, so a replay rejection carries what it opened and the caller
// decides whether to SAY something. Nothing is dispatched, ever.

import { ChunkAssembler, encodeMessage, isChunkMessage } from './chunk';
import { FrameError } from './frame';
import type { FrameCodec } from './frameCodec';
import { noteIn } from './seqStore';

export type Inbound =
  /** A whole message, ready to dispatch. */
  | { ok: true; msg: unknown }
  /** Part of a chunk group: nothing to do until the rest arrives. */
  | { ok: 'partial' }
  /** Dropped, with the reason the status line prints. `replayed` is what the
   *  frame carried — read only to describe the failure, never to act on. */
  | { ok: false; reason: string; replayed?: unknown };

function parse(json: string): unknown | undefined {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** One socket's inbound pipeline, built beside its codec and thrown away with it, so a rotated
 *  pairing inherits no reassembly state. */
export class InboundPipe {
  private readonly assembler = new ChunkAssembler();

  constructor(private readonly codec: FrameCodec) {}

  public async accept(frame: Uint8Array): Promise<Inbound> {
    let json: string;
    try {
      const decoded = await this.codec.decode(frame);
      json = decoded.json;
      noteIn(this.codec.rid, decoded.seq);
    } catch (e) {
      if (!(e instanceof FrameError)) return { ok: false, reason: 'error' };
      const replayed = e.reason === 'replay' && e.frame ? parse(e.frame.json) : undefined;
      return { ok: false, reason: e.reason, replayed };
    }
    let msg = parse(json);
    if (msg === undefined) return { ok: false, reason: 'malformed JSON' };
    if (!isChunkMessage(msg)) return { ok: true, msg };
    const whole = this.assembler.push(msg);
    if (whole === null) return { ok: 'partial' };
    msg = parse(whole);
    if (msg === undefined) return { ok: false, reason: 'malformed JSON (reassembled)' };
    return { ok: true, msg };
  }
}

/** The slice of the transport an outbound pipe uses. */
export interface FrameSink {
  send(frame: Uint8Array): void;
}

/**
 * One socket's outbound pipeline. Chunking happens HERE so the transport queue
 * holds whole frames, and every call links onto the same tail: seals resolve OUT
 * OF ORDER under load while seq is assigned in CALL order.
 */
export class OutboundPipe {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly codec: FrameCodec,
    private readonly sink: FrameSink,
    /** Every failure that is not the caller's business, worded for the pane. */
    private readonly onError: (text: string) => void,
  ) {}

  /** Resolves when the message is on the wire — what lets revoke flush `remote/revoked`. */
  public send(msg: unknown): Promise<void> {
    let jsons: string[];
    try {
      jsons = encodeMessage(msg);
    } catch (e) {
      this.onError(`dropped an unsendable message (${e instanceof Error ? e.message : String(e)})`);
      return Promise.resolve();
    }
    const chain = jsons
      .reduce((prev, json) => prev.then(async () => this.sink.send(await this.codec.encode(json))), this.tail)
      .catch((e: unknown) => this.onError(`seal failed (${e instanceof Error ? e.message : String(e)})`));
    this.tail = chain;
    return chain;
  }
}
