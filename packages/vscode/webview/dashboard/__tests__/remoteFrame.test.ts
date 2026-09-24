// Origami Remote — the binary frame. The header layout is asserted byte by
// byte against the spec table rather than against encodeFrame's own output,
// and each of the three documented rejections (version, replay, GCM) is
// provoked separately so a test cannot pass on the wrong one.
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKey, deriveRid, generateKs, type RemoteKey } from '../../../src/remote/crypto';
import {
  FRAME_VERSION,
  FrameError,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_JSON_BYTES,
  ROLE_DESKTOP,
  ROLE_PHONE,
  buildAad,
  decodeFrame,
  encodeFrame,
} from '../../../src/remote/frame';
import { FrameCodec, SeqGuard } from '../../../src/remote/frameCodec';

let key: RemoteKey;
let rid: string;

beforeAll(async () => {
  const ks = generateKs();
  key = await deriveKey(ks);
  rid = await deriveRid(ks);
});

const reason = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof FrameError ? e.reason : `not-a-FrameError:${String(e)}`;
  }
  return 'no-throw';
};

describe('remote frame — the header layout the spec prints', () => {
  it('is version, role, uint32 BE seq, 12-byte nonce, then ciphertext', async () => {
    const nonce = new Uint8Array(12).fill(0xab);
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 0x01020304, '{"a":1}', nonce);
    expect(frame[0]).toBe(FRAME_VERSION);
    expect(frame[1]).toBe(ROLE_PHONE);
    expect([...frame.subarray(2, 6)]).toEqual([0x01, 0x02, 0x03, 0x04]); // big-endian
    expect([...frame.subarray(6, 18)]).toEqual([...nonce]);
    // 1,024-byte plaintext class + the 16-byte tag, after an 18-byte header.
    expect(frame.length).toBe(HEADER_BYTES + 1024 + 16);
  });

  it('AAD is the utf-8 rid followed by exactly the first SIX header bytes', () => {
    const header = new Uint8Array(HEADER_BYTES);
    header[0] = 1;
    header[1] = 2;
    header.set([9, 9, 9, 9], 2);
    header.fill(0x7f, 6); // nonce bytes, which must NOT appear in the AAD
    const aad = buildAad('AABB', header);
    expect([...aad]).toEqual([65, 65, 66, 66, 1, 2, 9, 9, 9, 9]);
  });

  it('round-trips through decodeFrame', async () => {
    const json = JSON.stringify({ type: 'remote/hello', v: 1, device: 'Origami Code' });
    const decoded = await decodeFrame(key, rid, await encodeFrame(key, rid, ROLE_DESKTOP, 7, json));
    expect(decoded).toEqual({ role: ROLE_DESKTOP, seq: 7, json, version: FRAME_VERSION });
  });

  it('never exceeds the relay frame cap for a message at the JSON limit', async () => {
    const json = JSON.stringify({ t: 'x'.repeat(MAX_JSON_BYTES - 12) });
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_JSON_BYTES);
    const frame = await encodeFrame(key, rid, ROLE_DESKTOP, 1, json);
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe('remote frame — the three rejections', () => {
  it('rejects an unknown version byte', async () => {
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 1, '{}');
    // 3, not 2: 2 is the session-key frame since wire v1.3, so a version the
    // wire DOES define must not be the one this test proves is refused.
    frame[0] = 3;
    expect(await reason(() => decodeFrame(key, rid, frame))).toBe('version');
  });

  it('rejects a frame shorter than a header plus a tag', async () => {
    expect(await reason(() => decodeFrame(key, rid, new Uint8Array(20)))).toBe('short');
  });

  it('rejects an unknown role byte', async () => {
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 1, '{}');
    frame[1] = 9;
    expect(await reason(() => decodeFrame(key, rid, frame))).toBe('role');
  });

  // --- THE AAD BINDING. Each of these mutates a header field that is COVERED
  // by the AAD; the ciphertext is untouched, so only the AAD check can catch
  // them. Break buildAad to `return ridBytes` and all three go green. ---
  it('rejects a frame whose ROLE byte was rewritten in flight', async () => {
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 1, '{}');
    frame[1] = ROLE_DESKTOP;
    expect(await reason(() => decodeFrame(key, rid, frame))).toBe('gcm');
  });

  it('rejects a frame whose SEQ was rewritten in flight', async () => {
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 1, '{}');
    frame[5] = 9;
    expect(await reason(() => decodeFrame(key, rid, frame))).toBe('gcm');
  });

  it('rejects a frame replayed onto a DIFFERENT pairing (the rid is in the AAD)', async () => {
    const frame = await encodeFrame(key, rid, ROLE_PHONE, 1, '{}');
    const otherRid = await deriveRid(generateKs());
    expect(await reason(() => decodeFrame(key, otherRid, frame))).toBe('gcm');
  });

  it('rejects a frame sealed under another pairing key', async () => {
    const frame = await encodeFrame(await deriveKey(generateKs()), rid, ROLE_PHONE, 1, '{}');
    expect(await reason(() => decodeFrame(key, rid, frame))).toBe('gcm');
  });
});

describe('remote frame — SeqGuard', () => {
  it('starts at 0 so the first ?after= is 0, as the relay defaults', () => {
    const guard = new SeqGuard();
    expect(guard.seen(ROLE_PHONE)).toBe(0);
  });

  it('accepts strictly increasing seqs and refuses <= the high-water mark', () => {
    const guard = new SeqGuard();
    expect(guard.accept(ROLE_PHONE, 1)).toBe(true);
    expect(guard.accept(ROLE_PHONE, 2)).toBe(true);
    expect(guard.accept(ROLE_PHONE, 2)).toBe(false); // a DUPLICATE is a replay
    expect(guard.accept(ROLE_PHONE, 1)).toBe(false);
    expect(guard.accept(ROLE_PHONE, 5)).toBe(true); // a gap is fine; the relay drops frames
    expect(guard.seen(ROLE_PHONE)).toBe(5);
  });

  it('tracks the two roles independently', () => {
    const guard = new SeqGuard();
    guard.accept(ROLE_PHONE, 9);
    expect(guard.accept(ROLE_DESKTOP, 1)).toBe(true);
  });
});

describe('remote frame — FrameCodec', () => {
  const phoneCodec = async (): Promise<FrameCodec> => new FrameCodec(key, rid, ROLE_PHONE);

  it('numbers its own frames from 1, strictly increasing', async () => {
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      seqs.push((await decodeFrame(key, rid, await codec.encode('{}'))).seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
  });

  // --- THE REPLAY CHECK. Delete the `if (!this.guard.accept(...))` block in
  // FrameCodec.decode and this goes green while the desktop happily re-runs
  // whatever the captured frame said. ---
  it('REJECTS a frame it has already accepted', async () => {
    const desktop = new FrameCodec(key, rid, ROLE_DESKTOP);
    const phone = await phoneCodec();
    const frame = await phone.encode(JSON.stringify({ type: 'permission', optionId: 'allow' }));
    expect((await desktop.decode(frame)).json).toContain('permission');
    expect(await reason(() => desktop.decode(frame))).toBe('replay');
  });

  it('rejects an OLDER frame after a newer one has landed', async () => {
    const desktop = new FrameCodec(key, rid, ROLE_DESKTOP);
    const phone = await phoneCodec();
    const first = await phone.encode('{"i":1}');
    const second = await phone.encode('{"i":2}');
    await desktop.decode(second);
    expect(await reason(() => desktop.decode(first))).toBe('replay');
  });

  it('rejects a frame carrying our OWN role — the relay never echoes us back', async () => {
    const desktop = new FrameCodec(key, rid, ROLE_DESKTOP);
    const echoed = await encodeFrame(key, rid, ROLE_DESKTOP, 1, '{}');
    expect(await reason(() => desktop.decode(echoed))).toBe('role');
  });

  it('afterSeq follows the PEER, so a reconnect resumes where we got to', async () => {
    const desktop = new FrameCodec(key, rid, ROLE_DESKTOP);
    const phone = await phoneCodec();
    expect(desktop.afterSeq).toBe(0);
    await desktop.decode(await phone.encode('{"i":1}'));
    await desktop.decode(await phone.encode('{"i":2}'));
    await desktop.encode('{"mine":true}'); // our own sends must not move it
    expect(desktop.afterSeq).toBe(2);
  });

  it('refuses to encode a message that would overflow a frame', async () => {
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    await expect(codec.encode('x'.repeat(MAX_JSON_BYTES + 1))).rejects.toThrow(/chunk it first/);
  });
});
