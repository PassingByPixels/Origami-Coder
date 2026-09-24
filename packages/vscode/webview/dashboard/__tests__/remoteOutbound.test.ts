// Origami Remote — the outbound shaper, on a FAKE CLOCK.
//
// The claim under test is a byte count, so the last test in this file does not
// assert about frames: it SEALS them, with the real FrameCodec and the real
// WebCrypto, and measures what a 300-token turn actually puts on the wire with
// the shaper and without it. Everything above it is the behaviour that has to
// survive that saving — order, identity of the text, and the chats the phone
// cannot see.
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKey, deriveRid, generateKs, type RemoteKey } from '../../../src/remote/crypto';
import { ROLE_DESKTOP } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { encodeMessage } from '../../../src/remote/chunk';
import { RemoteOutbound, FLUSH_MS, type OutboundClock } from '../../../src/remote/remoteOutbound';
import { scopeOf } from '../../../src/remote/remoteScope';

/** Virtual time. The shaper's only clock dependency is setTimer/clearTimer, so
 *  300 deltas 10 ms apart cost no real milliseconds at all. */
class FakeClock implements OutboundClock {
  public now = 0;
  private pending: { at: number; fn: () => void; h: object }[] = [];

  public setTimer(fn: () => void, ms: number): unknown {
    const h = {};
    this.pending.push({ at: this.now + ms, fn, h });
    return h;
  }

  public clearTimer(handle: unknown): void {
    this.pending = this.pending.filter((p) => p.h !== handle);
  }

  public advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.pending.filter((p) => p.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.pending = this.pending.filter((p) => p !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
  }
}

type Sent = Record<string, unknown>;

function rig(flushBytes?: number): { out: RemoteOutbound; sent: Sent[]; clock: FakeClock } {
  const sent: Sent[] = [];
  const clock = new FakeClock();
  const out = new RemoteOutbound({
    send: (msg) => {
      sent.push(msg as Sent);
      return Promise.resolve();
    },
    clock,
    flushBytes,
  });
  return { out, sent, clock };
}

/** 20 characters, and a different 20 for every index, so a test that passes
 *  cannot be passing on a reordering. */
const tok = (i: number): string => `d${String(i).padStart(4, '0')}`.padEnd(20, '.');

describe('the shaper coalesces a token stream', () => {
  it('turns 300 deltas 10 ms apart into at most 25 messages, with the text intact and in order', async () => {
    const { out, sent, clock } = rig();
    const source: string[] = [];
    for (let i = 0; i < 300; i++) {
      source.push(tok(i));
      void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: tok(i) });
      clock.advance(10);
    }
    await out.flushAll();

    expect(sent.length).toBeLessThanOrEqual(25);
    expect(sent.length).toBeGreaterThan(1); // a single message would mean nothing flushed on time
    // BYTE-IDENTICAL, in order: the phone must see the same characters it would
    // have seen one per frame.
    expect(sent.map((m) => m.text).join('')).toBe(source.join(''));
    // ...as the SAME message, or the phone page needs a new arm for it.
    for (const m of sent) {
      expect(m.type).toBe('agentText');
      expect(m.sessionId).toBe('s1');
      expect(m.messageId).toBe('m1');
    }
  });

  it('flushes on the timer even while the stream keeps arriving', () => {
    const { out, sent, clock } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: 'a' });
    expect(sent).toEqual([]); // buffered, not sent
    clock.advance(FLUSH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('a');
  });

  it('keeps two live streams in one session apart', async () => {
    const { out, sent } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: 'one-' });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm2', text: 'TWO-' });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: 'one' });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm2', text: 'TWO' });
    await out.flushAll();
    expect(sent.map((m) => [m.messageId, m.text])).toEqual([['m1', 'one-one'], ['m2', 'TWO-TWO']]);
  });

  it('keeps two sub-agents under one parent apart', async () => {
    const { out, sent } = rig();
    void out.send({ type: 'subagentChunk', sessionId: 's1', childSessionId: 'c1', text: 'aa' });
    void out.send({ type: 'subagentChunk', sessionId: 's1', childSessionId: 'c2', text: 'bb' });
    void out.send({ type: 'subagentChunk', sessionId: 's1', childSessionId: 'c1', text: 'AA' });
    await out.flushAll();
    expect(sent.map((m) => [m.childSessionId, m.text])).toEqual([['c1', 'aaAA'], ['c2', 'bb']]);
  });

  it('never mixes two sessions', async () => {
    const { out, sent } = rig();
    for (let i = 0; i < 10; i++) {
      void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: `a${i}` });
      void out.send({ type: 'agentText', sessionId: 's2', messageId: 'm', text: `b${i}` });
    }
    await out.flushAll();
    const text = (id: string): string => sent.filter((m) => m.sessionId === id).map((m) => m.text).join('');
    expect(text('s1')).toBe('a0a1a2a3a4a5a6a7a8a9');
    expect(text('s2')).toBe('b0b1b2b3b4b5b6b7b8b9');
  });

  it('rejoins a surrogate pair the engine split across two deltas', async () => {
    // chunk.ts splits per code point for exactly this reason. Here the SOURCE
    // is already split, so the join must put the halves back byte for byte.
    const { out, sent } = rig();
    const rocket = '\u{1F680}';
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'a' + rocket[0] });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: rocket[1] + 'b' });
    await out.flushAll();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('a' + rocket + 'b');
  });

  it('flushes a buffer over the byte bound without waiting for the timer', () => {
    const { out, sent } = rig(100);
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'x'.repeat(60) });
    expect(sent).toEqual([]);
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'y'.repeat(60) });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('x'.repeat(60) + 'y'.repeat(60));
  });
});

describe('ORDER — nothing overtakes the words it followed', () => {
  it('flushes the text before a tool card that arrived mid-stream', async () => {
    const { out, sent } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'before' });
    void out.send({ type: 'toolCall', sessionId: 's1', toolCallId: 't1' });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'after' });
    await out.flushAll();
    expect(sent.map((m) => m.type)).toEqual(['agentText', 'toolCall', 'agentText']);
    expect(sent[0]!.text).toBe('before');
    expect(sent[2]!.text).toBe('after');
  });

  it('flushes on turnDone, so a turn never settles over unsent words', () => {
    const { out, sent } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'last words' });
    void out.send({ type: 'turnDone', sessionId: 's1', stopReason: 'end_turn' });
    expect(sent.map((m) => m.type)).toEqual(['agentText', 'turnDone']);
    expect(sent[0]!.text).toBe('last words');
  });

  it('does not let ANOTHER session’s message flush this one early', () => {
    const { out, sent } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'held' });
    void out.send({ type: 'turnDone', sessionId: 's2', stopReason: 'end_turn' });
    expect(sent.map((m) => m.type)).toEqual(['turnDone']);
  });

  it('flushAll empties every buffer — the transport-stop path', async () => {
    const { out, sent } = rig();
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'a' });
    void out.send({ type: 'agentThought', sessionId: 's2', text: 'b' });
    await out.flushAll();
    expect(sent.map((m) => m.text).sort()).toEqual(['a', 'b']);
  });
});

describe('scope — what the phone has no cell to paint', () => {
  it('drops the four heavy types whatever the focus', () => {
    for (const type of ['browserSnapshot', 'agentImage', 'glidepathData', 'feedMessage']) {
      expect(scopeOf(type, 's1', 's1')).toBe('drop');
      expect(scopeOf(type, 's1', null)).toBe('drop');
      expect(scopeOf(type, undefined, null)).toBe('drop');
    }
  });

  it('scopes NOTHING while the focus is unknown, so a hydration burst is never filtered', () => {
    expect(scopeOf('contextUpdate', 's9', null)).toBe('send');
    expect(scopeOf('agentText', 's9', null)).toBe('buffer');
  });

  it('drops an unfocused chat’s stream but never its permission ask', () => {
    expect(scopeOf('agentText', 's2', 's1')).toBe('drop');
    expect(scopeOf('toolCall', 's2', 's1')).toBe('drop');
    expect(scopeOf('requestPermission', 's2', 's1')).toBe('send');
    expect(scopeOf('permissionAudit', undefined, 's1')).toBe('send');
    expect(scopeOf('turnDone', 's2', 's1')).toBe('send');
    expect(scopeOf('busy', 's2', 's1')).toBe('send');
    expect(scopeOf('sessionCreated', 's2', 's1')).toBe('send');
    expect(scopeOf('sessionClosed', 's2', 's1')).toBe('send');
  });

  // t-dclj7z: the phone MOUNTS the dashboard's ChatPane, so its Todo panel
  // already draws the per-sub-agent tab strip — it was simply being sent every
  // OTHER chat's children too. Scoped beside `todoUpdate`, never dropped:
  // those tabs are the only place a phone sees a delegated plan at all.
  it('sends a sub-agent todo list for the chat the phone is on, and drops the others', () => {
    expect(scopeOf('subagentTodos', 's1', 's1')).toBe('send');
    expect(scopeOf('subagentTodos', 's2', 's1')).toBe('drop');
    expect(scopeOf('todoUpdate', 's2', 's1')).toBe('drop');
    // ...and never while the focus is unknown, like every other scoped type.
    expect(scopeOf('subagentTodos', 's2', null)).toBe('send');
  });

  // t-gvz8t0. The phone mounts the dashboard's own ChatPane, so its sub-agent
  // row is the desk's row — and the desk's row showed NOTHING for a child's
  // two-minute first step of pure thought. Buffered like the prose beside it:
  // a 7k-token thought is 7k frames up the relay unbuffered.
  it('buffers a sub-agent thought for the focused chat, and drops another chat’s', () => {
    expect(scopeOf('subagentThinking', 's1', 's1')).toBe('buffer');
    expect(scopeOf('subagentThinking', 's2', 's1')).toBe('drop');
    // Never while the focus is unknown, like every other scoped type.
    expect(scopeOf('subagentThinking', 's2', null)).toBe('buffer');
  });

  it('always passes hydration, whichever chat it names', () => {
    expect(scopeOf('restoreMessages', 's2', 's1')).toBe('send');
    expect(scopeOf('restoreActiveSession', 's2', 's1')).toBe('send');
  });

  it('passes an unlisted control message rather than swallowing it', () => {
    // The phone's InputBar and ModelPicker consume 25 types this file never
    // names. A default-deny gate would kill them silently.
    for (const type of ['availableCommands', 'effortOptions', 'providerAuthData', 'usageUpdate', 'themeSync']) {
      expect(scopeOf(type, 's2', 's1')).toBe('send');
    }
  });
});

describe('focus — which chat the phone is on', () => {
  it('follows the host’s active chat, then the phone’s own verb', () => {
    const { out, sent } = rig();
    expect(out.focus).toBeNull();
    void out.send({ type: 'restoreActiveSession', sessionId: 's1' });
    expect(out.focus).toBe('s1');
    void out.send({ type: 'agentText', sessionId: 's2', messageId: 'm', text: 'unseen' });
    // The phone SENDS in s2: it is on s2, whatever the desktop is showing.
    out.notePhone({ type: 'send', sessionId: 's2', text: 'hi' });
    expect(out.focus).toBe('s2');
    void out.send({ type: 'agentText', sessionId: 's2', messageId: 'm', text: 'seen' });
    void out.send({ type: 'turnDone', sessionId: 's2' });
    expect(sent.filter((m) => m.type === 'agentText').map((m) => m.text)).toEqual(['seen']);
  });

  it('adopts the chat the phone asked for with newSession', () => {
    const { out } = rig();
    void out.send({ type: 'restoreActiveSession', sessionId: 's1' });
    out.notePhone({ type: 'newSession' });
    void out.send({ type: 'sessionCreated', sessionId: 'sNEW', sessionNumber: 2 });
    expect(out.focus).toBe('sNEW');
  });

  it('gives the focus back to the host when the phone closes the chat it was on', () => {
    const { out } = rig();
    void out.send({ type: 'restoreActiveSession', sessionId: 's1' });
    out.notePhone({ type: 'send', sessionId: 's2' });
    out.notePhone({ type: 'closeSession', sessionId: 's2' });
    expect(out.focus).toBe('s1');
  });

  it('flushes before the focus moves, so the old chat’s last words are not filtered away', () => {
    const { out, sent } = rig();
    void out.send({ type: 'restoreActiveSession', sessionId: 's1' });
    void out.send({ type: 'agentText', sessionId: 's1', messageId: 'm', text: 'tail' });
    out.notePhone({ type: 'send', sessionId: 's2' });
    expect(sent.filter((m) => m.type === 'agentText').map((m) => m.text)).toEqual(['tail']);
  });

  it('sends a model catalogue once and drops the rebroadcasts', () => {
    const { out, sent } = rig();
    const cat = { type: 'modelOptions', current: 'a', options: [{ id: 'a' }, { id: 'b' }] };
    void out.send(cat);
    void out.send({ ...cat });
    void out.send({ ...cat, current: 'b' });
    expect(sent).toHaveLength(2);
  });

  it('after forget() sends the catalogue again and follows the host — a reloaded page holds nothing', () => {
    const { out, sent } = rig();
    const cat = { type: 'modelOptions', current: 'a', options: [{ id: 'a' }] };
    void out.send(cat);
    out.notePhone({ type: 'send', sessionId: 's2' });
    expect(out.focus).toBe('s2');
    out.forget();
    expect(out.focus).toBeNull();
    void out.send({ ...cat });
    void out.send({ type: 'restoreActiveSession', sessionId: 's1' });
    expect(sent.filter((m) => m.type === 'modelOptions')).toHaveLength(2);
    expect(out.focus).toBe('s1');
  });
});

describe('THE WIRE — what a 300-token turn really costs', () => {
  let key: RemoteKey;
  let rid: string;

  beforeAll(async () => {
    const ks = generateKs();
    key = await deriveKey(ks);
    rid = await deriveRid(ks);
  });

  /** Seal each message the way `pipes.ts` does — encodeMessage, then the real
   *  FrameCodec — and total the bytes the transport would hand the relay. */
  async function wireBytes(messages: unknown[]): Promise<number> {
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    let total = 0;
    for (const msg of messages) {
      for (const json of encodeMessage(msg)) total += (await codec.encode(json)).length;
    }
    return total;
  }

  it('is over 300 KB unshaped and under 40 KB shaped, for the same characters', async () => {
    const raw: unknown[] = [];
    for (let i = 0; i < 300; i++) {
      raw.push({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: tok(i) });
    }
    const { out, sent, clock } = rig();
    for (const msg of raw) {
      void out.send(msg);
      clock.advance(10);
    }
    await out.flushAll();

    const before = await wireBytes(raw);
    const after = await wireBytes(sent);

    // The characters the phone ends up with are the same ones.
    expect(sent.map((m) => m.text).join('')).toBe(raw.map((m) => (m as { text: string }).text).join(''));
    // 300 frames, each padded to its own 1 KiB block, plus header and tag.
    expect(before).toBeGreaterThan(300 * 1024);
    expect(after).toBeLessThan(40 * 1024);
    // Recorded so a regression that halves the saving is still a failure.
    expect(after * 8).toBeLessThan(before);
  });
});
