// WHAT THE DESK SENDS A PHONE THAT SAYS IT ALREADY HAS SOME OF IT.
//
// The delta road can be wrong in two directions and only one of them is loud.
// Sending too MUCH is the bill this lane exists to cut, and a test that missed
// it would just be slow. Sending too LITTLE — a cursor trusted when it names
// another desk's log, a slice that starts past a row the phone never got — is a
// hole in the middle of the owner's transcript that nothing ever repairs. So
// every road back to the full tail is asserted by name, and the tail it takes
// is asserted to be byte-for-byte the one that shipped before this file.

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

import { RESTORE_Z_CAP, markCaps } from '../../../src/remote/phoneCaps';
import {
  DELTA_OVERLAP,
  DESK_NONCE,
  RESTORE_DELTA_CAP,
  markSince,
  remoteCursor,
  remoteRestore,
} from '../../../src/remote/remoteDelta';
import {
  REMOTE_TAIL_MESSAGES,
  REMOTE_TOOL_CONTENT_CHARS,
  remoteRestoreEnvelope,
  remoteRestoreMessage,
} from '../../../src/remote/remoteTranscript';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';

const CHAT = 'session-1';

function log(n: number): SessionMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: (i % 2 === 0 ? 'user' : 'agent') as SessionMessage['kind'],
    text: `line ${i}`,
    timestamp: 1_700_000_000_000 + i,
  }));
}

interface Delta {
  type: string;
  sessionId: string;
  messages: SessionMessage[];
  truncated: boolean;
  omitted: number;
  from?: number;
}

/** A phone that declared both caps and asked from `since`. */
function phone(since?: Record<string, unknown>, desk = DESK_NONCE): Record<string, unknown> {
  const webview: Record<string, unknown> = {};
  markCaps(webview, [RESTORE_Z_CAP, RESTORE_DELTA_CAP]);
  markSince(webview, { type: 'remote/snapshot', desk, since });
  return webview;
}

describe('the four roads back to the whole tail', () => {
  it('takes it when the phone named no cursor — and it is the SAME bytes', () => {
    const l = log(150);
    expect(remoteRestore(CHAT, l, { compress: false })).toEqual(remoteRestoreMessage(CHAT, l));
    expect(remoteRestore(CHAT, l, { compress: true })).toEqual(remoteRestoreEnvelope(CHAT, l));
  });

  it('takes it when the cursor is PAST the log — those are not this log rows', () => {
    // A chat the desk restarted, or a phone that is simply confused. Splicing
    // from a row that does not exist would leave the transcript short for ever.
    const l = log(20);
    const out = remoteRestore(CHAT, l, { compress: false, since: 21 }) as Delta;
    expect(out.from).toBeUndefined();
    expect(out).toEqual(remoteRestoreMessage(CHAT, l));
  });

  it('takes it when the gap is wider than the tail — the delta would cost more', () => {
    const l = log(300);
    const wide = remoteRestore(CHAT, l, { compress: false, since: 300 - REMOTE_TAIL_MESSAGES - 1 }) as Delta;
    expect(wide.from).toBeUndefined();
    expect(wide.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    // ...and one row narrower is a delta, so the boundary is asserted, not the
    // side of it that happened to be convenient.
    const narrow = remoteRestore(CHAT, l, { compress: false, since: 300 - REMOTE_TAIL_MESSAGES }) as Delta;
    expect(narrow.from).toBe(300 - REMOTE_TAIL_MESSAGES - DELTA_OVERLAP);
  });

  it('takes it when the phone did not declare it can splice one', () => {
    const webview: Record<string, unknown> = {};
    markCaps(webview, [RESTORE_Z_CAP]); // today's shipped iOS app, plus restoreZ
    markSince(webview, { type: 'remote/snapshot', desk: DESK_NONCE, since: { [CHAT]: 10 } });
    expect(remoteCursor(webview, CHAT)).toBeUndefined();
  });
});

describe('the desk nonce', () => {
  it('records nothing at all for a cursor minted against another desk', () => {
    // Session ids restart at `session-1` on every extension-host start: the id
    // matches while the rows behind it are a different chat.
    expect(remoteCursor(phone({ [CHAT]: 10 }, 'some-other-desk'), CHAT)).toBeUndefined();
    // ...and a snapshot with no `desk` at all: an OLD page, which cannot know
    // which process it is talking to and must be given the tail.
    const old: Record<string, unknown> = {};
    markCaps(old, [RESTORE_DELTA_CAP]);
    markSince(old, { type: 'remote/snapshot', since: { [CHAT]: 10 } });
    expect(remoteCursor(old, CHAT)).toBeUndefined();
    // ...and the same phone, asking with THIS desk, is believed.
    expect(remoteCursor(phone({ [CHAT]: 10 }), CHAT)).toBe(10);
  });

  it('forgets the previous ask rather than merging with it', () => {
    const webview = phone({ [CHAT]: 10 });
    markSince(webview, { type: 'remote/snapshot', desk: DESK_NONCE, since: { 'session-2': 4 } });
    expect(remoteCursor(webview, CHAT)).toBeUndefined();
    expect(remoteCursor(webview, 'session-2')).toBe(4);
  });

  it('treats a malformed cursor as absent, never as a number to repair', () => {
    for (const bad of [{ [CHAT]: '10' }, { [CHAT]: -1 }, { [CHAT]: 1.5 }, { [CHAT]: null }]) {
      expect(remoteCursor(phone(bad as Record<string, unknown>), CHAT)).toBeUndefined();
    }
    expect(remoteCursor(phone(undefined), CHAT)).toBeUndefined();
    expect(remoteCursor(null, CHAT)).toBeUndefined();
  });
});

describe('the delta itself', () => {
  it('starts DELTA_OVERLAP rows before the cursor, so a mutated row is corrected', () => {
    // A tool row is written on the call and MUTATED when the result lands
    // (sessionLog.ts). The phone was sent the stale version; only a re-send
    // fixes it, and the cursor alone would never ask for one.
    const out = remoteRestore(CHAT, log(100), { compress: false, since: 100 }) as Delta;
    expect(out.from).toBe(100 - DELTA_OVERLAP);
    expect(out.messages).toHaveLength(DELTA_OVERLAP);
    expect(out.messages[0].text).toBe(`line ${100 - DELTA_OVERLAP}`);
    expect(out.messages[DELTA_OVERLAP - 1].text).toBe('line 99');
    // `omitted` is the count the phone must have in front of these rows, so
    // `from + messages.length` is the desk's own log length: the next cursor.
    expect(out.omitted).toBe(out.from);
    expect((out.from as number) + out.messages.length).toBe(100);
  });

  it('is far smaller than the tail it replaces, and says the same about the log', () => {
    const l = log(300);
    const tail = remoteRestoreMessage(CHAT, l) as unknown as Delta;
    const delta = remoteRestore(CHAT, l, { compress: false, since: 290 }) as Delta;
    expect(tail.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    expect(delta.messages).toHaveLength(10 + DELTA_OVERLAP);
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(tail).length / 3);
  });

  it('never clips its own overlap off the front', () => {
    // REVERT CHECK: passing the tail's 80-row `keep` here silently drops the
    // 8 oldest rows of an 88-row delta — the exact rows the overlap is for.
    const out = remoteRestore(CHAT, log(200), { compress: false, since: 200 - REMOTE_TAIL_MESSAGES }) as Delta;
    expect(out.messages).toHaveLength(REMOTE_TAIL_MESSAGES + DELTA_OVERLAP);
    expect(out.messages[0].text).toBe(`line ${200 - REMOTE_TAIL_MESSAGES - DELTA_OVERLAP}`);
  });

  it('trims a tool payload and drops its pictures, exactly as the tail does', () => {
    const shot = `data:image/png;base64,${'A'.repeat(5_000)}`;
    const l: SessionMessage[] = [
      ...log(4),
      {
        kind: 'tool',
        text: 'browser',
        timestamp: 5,
        tool: {
          call: { toolCallId: 't1', toolName: 'browser' },
          result: { toolCallId: 't1', content: 'x'.repeat(9_000), images: [shot] },
        },
      },
    ];
    const out = remoteRestore(CHAT, l, { compress: false, since: 5 }) as Delta;
    const result = out.messages[out.messages.length - 1].tool?.result as Record<string, unknown>;
    expect('images' in result).toBe(false);
    expect(result.content).toHaveLength(REMOTE_TOOL_CONTENT_CHARS);
    // NEVER in place: the sidebar replays this same array right after.
    expect((l[4].tool?.result?.content as string)).toHaveLength(9_000);
  });

  it('rides the same deflate envelope, for a phone that can open one', async () => {
    const { expandRestore } = await import('../../remote/inflate');
    const z = remoteRestore(CHAT, log(100), { compress: true, since: 100 }) as { type: string; b64: string };
    expect(z.type).toBe('restoreMessagesZ');
    const plain = (await expandRestore(z)) as Delta;
    expect(plain.from).toBe(100 - DELTA_OVERLAP);
    expect(plain.messages).toHaveLength(DELTA_OVERLAP);
  });
});
