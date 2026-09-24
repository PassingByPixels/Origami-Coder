import { describe, expect, it } from 'vitest';
import { ChunkAssembler, MAX_MESSAGE_BYTES, isChunk, splitMessage } from './chunk';

/** A message whose JSON is comfortably past one frame's plaintext budget. */
function bigMessage(bytes = MAX_MESSAGE_BYTES * 3) {
  return { type: 'restoreMessages', sessionId: 's1', messages: [{ kind: 'agent', text: 'a'.repeat(bytes) }] };
}

const drain = (a: ChunkAssembler, parts: unknown[]): unknown[] =>
  parts.map((p) => a.accept(p)).filter((m) => m !== undefined);

describe('splitMessage', () => {
  it('leaves a message that already fits completely alone', () => {
    const msg = { type: 'send', text: 'hello', sessionId: 's1' };
    expect(splitMessage(msg, 'id1')).toEqual([msg]);
  });

  it('splits an oversized message into numbered chunks of one id', () => {
    const parts = splitMessage(bigMessage(), 'id1');
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(isChunk(p)).toBe(true);
      const c = p as { id: string; i: number; n: number };
      expect(c.id).toBe('id1');
      expect(c.i).toBe(i);
      expect(c.n).toBe(parts.length);
    });
  });

  it('keeps every chunk inside the single-frame plaintext budget', () => {
    const te = new TextEncoder();
    for (const p of splitMessage(bigMessage(), 'id1')) {
      expect(te.encode(JSON.stringify(p)).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });

  // --- INTEROP DEFECT, caught by remoteInterop.test.ts against a real relay:
  // a `part` is re-escaped when the envelope is stringified, so a character
  // that needs escaping costs ONE byte in the transcript's JSON and TWO in the
  // envelope. Budgeting the part in raw bytes emitted a 65,591-byte envelope
  // -> a 66,594-byte frame -> 1,058 over the relay's 65,536 cap -> close 4002
  // and a dead pairing. Only a payload that both exceeds the chunk threshold
  // AND is escape-dense reaches it, which is why nine phone tests were green.
  it.each([
    ['every character a quote', '"'],
    ['every character a backslash', String.fromCharCode(92)],
    ['every character a newline', '\n'],
    ['every character a control byte', String.fromCharCode(1)],
  ])('keeps every envelope inside one frame when %s', (_name, ch) => {
    const te = new TextEncoder();
    const msg = { type: 'agentText', sessionId: 's1', text: ch.repeat(70_000) };
    const parts = splitMessage(msg, 'id1');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(te.encode(JSON.stringify(p)).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
    expect(drain(new ChunkAssembler(), parts)).toEqual([msg]);
  });

  // Wire spec v1, Clarifications: "a message whose JSON exceeds 32,512 bytes is
  // sent as N envelopes ... Smaller messages are sent unwrapped." The desktop
  // lane splits at 32,512; the phone was splitting at 64,508, so every message
  // in between crossed the wire unwrapped and the two lanes disagreed about
  // what the spec's number means.
  it('chunks at the spec threshold of 32,512 bytes, not at the frame ceiling', () => {
    const te = new TextEncoder();
    const under = { type: 'agentText', text: 'a'.repeat(30_000) };
    expect(te.encode(JSON.stringify(under)).length).toBeLessThan(32_512);
    expect(splitMessage(under, 'id1')).toEqual([under]);

    const over = { type: 'agentText', text: 'a'.repeat(40_000) };
    expect(te.encode(JSON.stringify(over)).length).toBeGreaterThan(32_512);
    const parts = splitMessage(over, 'id1');
    expect(parts.length).toBeGreaterThan(1);
    expect(drain(new ChunkAssembler(), parts)).toEqual([over]);
  });

  it('splits by BYTES, so a message of 4-byte emoji chunks like ASCII does', () => {
    // A char-counted splitter would emit parts up to 4x over budget here.
    const te = new TextEncoder();
    const msg = { type: 'agentText', text: '🌍'.repeat(MAX_MESSAGE_BYTES / 2) };
    for (const p of splitMessage(msg, 'e')) {
      expect(te.encode(JSON.stringify(p)).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });
});

describe('ChunkAssembler', () => {
  it('passes a non-chunk message straight through', () => {
    const a = new ChunkAssembler();
    const msg = { type: 'sessionCreated', sessionId: 's1' };
    expect(a.accept(msg)).toBe(msg);
    expect(a.pendingCount).toBe(0);
  });

  it('round-trips a split message byte-for-byte, and holds until complete', () => {
    const msg = bigMessage();
    const parts = splitMessage(msg, 'id1');
    const a = new ChunkAssembler();
    for (const p of parts.slice(0, -1)) expect(a.accept(p)).toBeUndefined();
    expect(a.accept(parts[parts.length - 1])).toEqual(msg);
    expect(a.pendingCount).toBe(0);
  });

  // The pad shifts every chunk boundary by 0-3 bytes. Without it the test is
  // luck: the budget (32,512) is a multiple of 4, so a run of pure 4-byte
  // emoji lands each boundary exactly BETWEEN characters and a byte-slicing
  // splitter survives. Two mutation runs stayed green before this loop existed.
  it.each([0, 1, 2, 3])('round-trips astral text offset by %i bytes, so a boundary cuts one', (pad) => {
    // Every chunk boundary here falls on or beside a 4-byte character. A
    // splitter that sliced the UTF-8 BYTES rather than the string would hand
    // back a part ending in half a code point, and the rejoin would be
    // mojibake — proven by mutating splitMessage to slice te.encode(json).
    //
    // NOT claimed: that walking UTF-16 code UNITS instead of code POINTS
    // would corrupt anything. It would not — JSON.stringify escapes a lone
    // surrogate as \udXXX and JSON.parse gives it back, so the rejoin is
    // still lossless. That mutation was tried and stayed green; the code
    // walks code points because the byte accounting is then exact, not
    // because a unit walk loses data.
    const msg = { type: 'agentText', text: 'x'.repeat(pad) + '🌍'.repeat(MAX_MESSAGE_BYTES / 2) };
    const parts = splitMessage(msg, 'id1');
    expect(parts.length).toBeGreaterThan(2);
    expect(drain(new ChunkAssembler(), parts)).toEqual([msg]);
  });

  it('reassembles chunks that arrive OUT OF ORDER (the relay ring can do this)', () => {
    const msg = bigMessage();
    const parts = splitMessage(msg, 'id1');
    expect(parts.length).toBeGreaterThan(2);
    const a = new ChunkAssembler();
    expect(drain(a, [...parts].reverse())).toEqual([msg]);
  });

  it('interleaves two multi-part messages without mixing their parts', () => {
    const m1 = { type: 'a', text: 'A'.repeat(MAX_MESSAGE_BYTES * 2) };
    const m2 = { type: 'b', text: 'B'.repeat(MAX_MESSAGE_BYTES * 2) };
    const p1 = splitMessage(m1, 'one');
    const p2 = splitMessage(m2, 'two');
    const a = new ChunkAssembler();
    const woven: unknown[] = [];
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      if (p1[i]) woven.push(p1[i]);
      if (p2[i]) woven.push(p2[i]);
    }
    expect(drain(a, woven)).toEqual([m1, m2]);
  });

  it('tolerates a duplicate part without double-counting it', () => {
    const msg = bigMessage();
    const parts = splitMessage(msg, 'id1');
    const a = new ChunkAssembler();
    a.accept(parts[0]);
    a.accept(parts[0]);
    expect(a.pendingCount).toBe(1);
    expect(drain(a, parts.slice(1))).toEqual([msg]);
  });

  // --- MUTATION PROOF 3: a malformed chunk is refused, not reassembled. -----
  it('REJECTS an index outside its own range', () => {
    const a = new ChunkAssembler();
    expect(() => a.accept({ type: 'remote/chunk', id: 'x', i: 5, n: 3, part: 'a' })).toThrow(/out of range/);
    expect(() => a.accept({ type: 'remote/chunk', id: 'x', i: -1, n: 3, part: 'a' })).toThrow(/out of range/);
    expect(() => a.accept({ type: 'remote/chunk', id: 'x', i: 0, n: 0, part: 'a' })).toThrow(/out of range/);
  });

  it('REJECTS a stream whose declared length changes mid-flight', () => {
    const a = new ChunkAssembler();
    a.accept({ type: 'remote/chunk', id: 'x', i: 0, n: 3, part: '{' });
    expect(() => a.accept({ type: 'remote/chunk', id: 'x', i: 1, n: 4, part: '}' })).toThrow(/changed length/);
  });

  it('REJECTS parts that rejoin into invalid JSON rather than dispatching junk', () => {
    const a = new ChunkAssembler();
    a.accept({ type: 'remote/chunk', id: 'x', i: 0, n: 2, part: '{"a":' });
    expect(() => a.accept({ type: 'remote/chunk', id: 'x', i: 1, n: 2, part: 'nope' })).toThrow();
  });
});

describe('isChunk', () => {
  it('only matches a complete envelope', () => {
    expect(isChunk({ type: 'remote/chunk', id: 'a', i: 0, n: 1, part: 'x' })).toBe(true);
    expect(isChunk({ type: 'remote/chunk', id: 'a', i: 0, n: 1 })).toBe(false);
    expect(isChunk({ type: 'send', text: 'hi' })).toBe(false);
    expect(isChunk(null)).toBe(false);
    expect(isChunk('remote/chunk')).toBe(false);
  });
});
