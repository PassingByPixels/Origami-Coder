// nestUnwrap.ts — the frame chunker's reassembly per peer, for the nest hub.
// Moved out of nestHub.ts unchanged (t-t7lfho) to make room there for the
// hand-over record (nestAway.ts).

import { ChunkAssembler, isChunkMessage } from '../remote/chunk';

export class NestUnwrap {
  private readonly assemblers = new Map<string, ChunkAssembler>();

  /** A whole message from `peerId`, or null while a chunk run is incomplete or it is malformed. */
  public unwrap(peerId: string, raw: Record<string, unknown>): Record<string, unknown> | null {
    if (!isChunkMessage(raw)) return raw;
    let asm = this.assemblers.get(peerId);
    if (!asm) this.assemblers.set(peerId, (asm = new ChunkAssembler()));
    try {
      const json = asm.push(raw);
      const whole = json === null ? null : (JSON.parse(json) as unknown);
      return whole && typeof whole === 'object' ? (whole as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
