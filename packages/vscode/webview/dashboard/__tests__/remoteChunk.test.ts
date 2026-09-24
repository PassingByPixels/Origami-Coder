// Origami Remote — message-level chunking. The requirement is that a message
// too big for a frame arrives INTACT, so the tests are round trips over
// payloads shaped like the real ones (a transcript hydration: long, quoted,
// unicode) plus the ordering and escaping cases that break a naive splitter.
import { describe, expect, it } from 'vitest';
import {
  CHUNK_BUDGET_BYTES,
  ChunkAssembler,
  encodeMessage,
  isChunkMessage,
  type ChunkMessage,
} from '../../../src/remote/chunk';
import { MAX_JSON_BYTES } from '../../../src/remote/frame';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A `restoreMessages` hydration of the size that forced chunking to exist. */
function bigTranscript(turns: number): unknown {
  return {
    type: 'restoreMessages',
    sessionId: 'sess-1',
    messages: Array.from({ length: turns }, (_, i) => ({
      kind: i % 2 ? 'assistant' : 'user',
      text: `turn ${i}: "quoted", back\\slashed, and it said — ok 🚀 ${'lorem ipsum '.repeat(12)}`,
      timestamp: 1_700_000_000 + i,
    })),
  };
}

describe('remote chunking — a message that fits is not chunked', () => {
  it('comes back as its own JSON, one element', () => {
    const msg = { type: 'contextUpdate', sessionId: 's', tokensUsed: 12 };
    expect(encodeMessage(msg)).toEqual([JSON.stringify(msg)]);
  });

  it('does not chunk right up to the interop budget', () => {
    // The shared constant both lanes build to. One byte under it is a plain
    // message; one byte over it is a chunk run.
    const fits = { type: 'x', pad: 'a'.repeat(CHUNK_BUDGET_BYTES - 25) };
    expect(bytes(JSON.stringify(fits))).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
    expect(encodeMessage(fits)).toHaveLength(1);

    const over = { type: 'x', pad: 'a'.repeat(CHUNK_BUDGET_BYTES) };
    expect(bytes(JSON.stringify(over))).toBeGreaterThan(CHUNK_BUDGET_BYTES);
    expect(encodeMessage(over).length).toBeGreaterThan(1);
  });

  it('the budget is the interop constant the phone lane also builds to', () => {
    expect(CHUNK_BUDGET_BYTES).toBe(32_512);
  });
});

describe('remote chunking — a message that does not fit', () => {
  const original = bigTranscript(900);
  const parts = encodeMessage(original);

  it('splits into several chunk envelopes sharing one id', () => {
    expect(parts.length).toBeGreaterThan(1);
    const decoded = parts.map((p) => JSON.parse(p) as ChunkMessage);
    expect(new Set(decoded.map((c) => c.id)).size).toBe(1);
    expect(decoded.map((c) => c.i)).toEqual(decoded.map((_, i) => i));
    expect(decoded.every((c) => c.n === decoded.length)).toBe(true);
  });

  it('keeps every PART inside the budget and every envelope inside the frame', () => {
    for (const part of parts) {
      const c = JSON.parse(part) as ChunkMessage;
      // The budget is on the escaped payload; the frame cap is the real wall.
      expect(bytes(JSON.stringify(c.part)) - 2).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
      expect(bytes(part)).toBeLessThanOrEqual(MAX_JSON_BYTES);
    }
  });

  // --- THE REASSEMBLY. Change `run.parts.join('')` to `run.parts[0]` (or drop
  // the index ordering for arrival order) and this is the test that goes red. ---
  it('reassembles byte-for-byte back into the original message', () => {
    const asm = new ChunkAssembler();
    let whole: string | null = null;
    for (const part of parts) whole = asm.push(JSON.parse(part) as ChunkMessage);
    expect(whole).toBe(JSON.stringify(original));
    expect(JSON.parse(whole!)).toEqual(original);
  });

  it('reassembles when the relay replays the parts OUT OF ORDER', () => {
    const asm = new ChunkAssembler();
    const shuffled = [...parts].reverse();
    let whole: string | null = null;
    for (const part of shuffled) whole = asm.push(JSON.parse(part) as ChunkMessage);
    expect(JSON.parse(whole!)).toEqual(original);
  });

  it('ignores a duplicated chunk instead of doubling it', () => {
    const asm = new ChunkAssembler();
    const decoded = parts.map((p) => JSON.parse(p) as ChunkMessage);
    asm.push(decoded[0]!);
    asm.push(decoded[0]!);
    let whole: string | null = null;
    for (const c of decoded) whole = asm.push(c);
    expect(JSON.parse(whole!)).toEqual(original);
  });

  it('returns null until the last chunk lands', () => {
    const asm = new ChunkAssembler();
    const decoded = parts.map((p) => JSON.parse(p) as ChunkMessage);
    for (const c of decoded.slice(0, -1)) expect(asm.push(c)).toBeNull();
    expect(asm.push(decoded.at(-1)!)).not.toBeNull();
    expect(asm.pending).toBe(0);
  });
});

describe('remote chunking — the shapes that break a naive splitter', () => {
  it('never cuts a surrogate pair in half', () => {
    // All-emoji: every code point is a surrogate PAIR, so a splitter working
    // in UTF-16 units produces parts that are not valid text at all.
    const original = { type: 'restoreMessages', text: '🚀'.repeat(40_000) };
    const parts = encodeMessage(original);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const c = JSON.parse(part) as ChunkMessage;
      expect(c.part).not.toMatch(/[\uD800-\uDBFF]$/); // no trailing high surrogate
      expect(c.part).not.toMatch(/^[\uDC00-\uDFFF]/); // no leading low surrogate
    }
    const asm = new ChunkAssembler();
    let whole: string | null = null;
    for (const part of parts) whole = asm.push(JSON.parse(part) as ChunkMessage);
    expect(JSON.parse(whole!)).toEqual(original);
  });

  it('stays under the cap when EVERY character escapes to two bytes', () => {
    // A payload of nothing but quotes and backslashes doubles inside a JSON
    // string. Budgeting on raw length would ship over-cap envelopes here.
    const original = { type: 'restoreMessages', text: '"\\'.repeat(60_000) };
    const parts = encodeMessage(original);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(MAX_JSON_BYTES);
    const asm = new ChunkAssembler();
    let whole: string | null = null;
    for (const part of parts) whole = asm.push(JSON.parse(part) as ChunkMessage);
    expect(JSON.parse(whole!)).toEqual(original);
  });

  it('stays under the cap for control characters, which escape to six bytes', () => {
    const original = { type: 'restoreMessages', text: '\u0001'.repeat(30_000) };
    for (const part of encodeMessage(original)) expect(bytes(part)).toBeLessThanOrEqual(MAX_JSON_BYTES);
  });
});

describe('remote chunking — guards', () => {
  it('recognises a chunk and refuses a malformed one', () => {
    expect(isChunkMessage({ type: 'remote/chunk', id: 'a', i: 0, n: 2, part: 'x' })).toBe(true);
    // An out-of-range index is still a CHUNK — reassembly ignores it (below),
    // rather than this returning false and the envelope reaching the webview.
    expect(isChunkMessage({ type: 'remote/chunk', id: 'a', i: 2, n: 2, part: 'x' })).toBe(true);
    expect(isChunkMessage({ type: 'remote/chunk', id: 'a', i: 0, n: 0, part: 'x' })).toBe(false);
    expect(isChunkMessage({ type: 'remote/chunk', id: 'a', i: 1.5, n: 2, part: 'x' })).toBe(false);
    expect(isChunkMessage({ type: 'restoreMessages' })).toBe(false);
    expect(isChunkMessage(null)).toBe(false);
  });

  it('reassembly IGNORES an index outside [0, n)', () => {
    const asm = new ChunkAssembler();
    for (const i of [-1, 2, 99]) {
      expect(asm.push({ type: 'remote/chunk', id: 'r', i, n: 2, part: 'junk' })).toBeNull();
    }
    expect(asm.pending).toBe(0); // it did not even open a run
    // The real run still completes, uncorrupted by any of that.
    expect(asm.push({ type: 'remote/chunk', id: 'r', i: 0, n: 2, part: 'he' })).toBeNull();
    expect(asm.push({ type: 'remote/chunk', id: 'r', i: 1, n: 2, part: 'llo' })).toBe('hello');
  });

  it('drops the OLDEST unfinished run rather than growing without limit', () => {
    const asm = new ChunkAssembler(2);
    for (let k = 0; k < 5; k++) asm.push({ type: 'remote/chunk', id: `run${k}`, i: 0, n: 2, part: 'a' });
    expect(asm.pending).toBeLessThanOrEqual(2);
  });

  it('refuses a run whose length changes mid-flight', () => {
    const asm = new ChunkAssembler();
    asm.push({ type: 'remote/chunk', id: 'r', i: 0, n: 3, part: 'a' });
    expect(() => asm.push({ type: 'remote/chunk', id: 'r', i: 1, n: 4, part: 'b' })).toThrow(/changed length/);
  });
});
