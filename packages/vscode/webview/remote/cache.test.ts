// THE PHONE'S OWN COPY OF THE TRANSCRIPT.
//
// What is asserted here is the CONTRACT `cache.ts` owes the rest of the shell,
// on the four things that can go wrong with a cache and did go wrong with this
// one before the checks below existed:
//
//   - it holds rows across a page load, and paints them before any socket;
//   - the cursor it reports is a length of the DESKTOP's log, never of its own
//     array — the whole delta road is wrong by exactly that difference;
//   - a record it did not write, or one from another desk process, is ABSENT;
//   - the bundle it paints cannot talk on the wire before the desk has.

import { beforeEach, describe, expect, it } from 'vitest';
import { TranscriptCache, forgetCache } from './cache';

const RID = 'rid-cache';

type Row = { kind: string; text: string; timestamp: number };

function rows(n: number, from = 0): Row[] {
  return Array.from({ length: n }, (_, i) => ({ kind: 'agent', text: `row ${from + i}`, timestamp: from + i }));
}

/** A cache with a sink that records what it dispatched into the bundle. */
function open(): { cache: TranscriptCache; out: Array<Record<string, unknown>> } {
  const out: Array<Record<string, unknown>> = [];
  return { cache: new TranscriptCache(RID, (m) => void out.push(m as Record<string, unknown>), window), out };
}

/** The desk's hello, then a full hydration of `n` rows with `omitted` above them. */
function hydrate(cache: TranscriptCache, id: string, n: number, omitted = 0, desk = 'desk-1'): void {
  cache.note({ type: 'remote/hello', v: 1, device: 'desk', desk });
  cache.note({ type: 'sessionCreated', sessionId: id, sessionNumber: 2, agentName: 'Tsuru', agentArt: 'ASCII' });
  cache.note({
    type: 'restoreMessages',
    sessionId: id,
    messages: rows(n, omitted),
    truncated: omitted > 0,
    omitted,
  });
  cache.note({ type: 'restoreActiveSession', sessionId: id });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the transcript survives the page', () => {
  it('paints what the last page was told, before anything is on the wire', () => {
    hydrate(open().cache, 'session-1', 3);

    // A NEW page: the only thing it shares with the last one is localStorage.
    const next = open();
    expect(next.cache.paint()).toBe(true);
    expect(next.out.map((m) => m.type)).toEqual([
      'sessionCreated',
      'restoreMessages',
      'restoreActiveSession',
    ]);
    // The chat's real name and number ride along, so the instant paint is not a
    // placeholder the burst then has to correct on screen.
    expect(next.out[0]).toMatchObject({ sessionId: 'session-1', sessionNumber: 2, agentName: 'Tsuru' });
    // ...but never the ASCII bot art: kilobytes the phone does not draw.
    expect(next.out[0].agentArt).toBeNull();
    expect((next.out[1].messages as Row[]).map((r) => r.text)).toEqual(['row 0', 'row 1', 'row 2']);
    // REVERT CHECK: with `replaces` gone, ChatPane's acceptsReplayedLog drops
    // the desk's real restore that lands on top of this one.
    expect(next.out[1].replaces).toBe(true);
  });

  it('paints nothing at all when it has never been told anything', () => {
    const fresh = open();
    expect(fresh.cache.paint()).toBe(false);
    expect(fresh.out).toEqual([]);
    expect(fresh.cache.snapshot()).toEqual({ type: 'remote/snapshot' });
  });

  it('reports the DESKTOP log length, not the length of what it kept', () => {
    // 90 rows with 200 above them: the desk's log is 290 long, and the cache
    // keeps 80. A cursor of 80 (or of 90) would ask the desk to replay from the
    // wrong row and splice a hole into the owner's transcript.
    hydrate(open().cache, 'session-1', 90, 200);
    const next = open();
    expect(next.cache.snapshot()).toEqual({
      type: 'remote/snapshot',
      desk: 'desk-1',
      since: { 'session-1': 290 },
    });
    next.cache.paint();
    expect(next.out[1].messages).toHaveLength(80);
    expect(next.out[1].omitted).toBe(210);
  });
});

describe('a delta is spliced onto what is held', () => {
  it('keeps the rows before `from` and takes the desk copy of everything after', () => {
    const first = open();
    hydrate(first.cache, 'session-1', 10);

    // The desk answers a cursor of 10 with an overlap of 4: rows 6..12. Rows
    // 6-9 are RE-SENT because they may have been mutated in place since.
    const back = open();
    const out = back.cache.note({
      type: 'restoreMessages',
      sessionId: 'session-1',
      messages: [
        { kind: 'agent', text: 'row 6 EDITED', timestamp: 6 },
        ...rows(6, 7),
      ],
      truncated: true,
      omitted: 6,
      from: 6,
    }) as Record<string, unknown>;

    expect((out.messages as Row[]).map((r) => r.text)).toEqual([
      'row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5',
      'row 6 EDITED', 'row 7', 'row 8', 'row 9', 'row 10', 'row 11', 'row 12',
    ]);
    expect(out.omitted).toBe(0);
    expect(back.cache.snapshot()).toMatchObject({ since: { 'session-1': 13 } });
  });

  it('takes a delta wholesale when it starts before anything held', () => {
    // `from` below the first row the cache holds: there is nothing to keep in
    // front of it, and keeping the tail would leave a GAP in the middle.
    const c = open();
    hydrate(c.cache, 'session-1', 5, 100); // holds log rows 100..104
    const out = c.cache.note({
      type: 'restoreMessages',
      sessionId: 'session-1',
      messages: rows(3, 50),
      omitted: 50,
      from: 50,
    }) as Record<string, unknown>;
    expect((out.messages as Row[]).map((r) => r.text)).toEqual(['row 50', 'row 51', 'row 52']);
    expect(c.cache.snapshot()).toMatchObject({ since: { 'session-1': 53 } });
  });
});

describe('what is never trusted', () => {
  it('drops everything when the desk process changed', () => {
    hydrate(open().cache, 'session-1', 4, 0, 'desk-1');
    // Session ids restart at `session-1` on every extension-host start, so the
    // id still matches while the rows behind it are a different chat entirely.
    const next = open();
    next.cache.note({ type: 'remote/hello', v: 1, device: 'desk', desk: 'desk-2' });
    expect(next.cache.paint()).toBe(false);
    expect(next.cache.snapshot()).toEqual({ type: 'remote/snapshot', desk: 'desk-2', since: {} });
  });

  it('treats a record it did not write as absent, and never repairs one', () => {
    for (const bad of [
      'not json at all',
      JSON.stringify({ v: 2, sessions: {} }),
      JSON.stringify({ v: 1 }),
      // A cursor SHORTER than the rows it claims to end at cannot be spliced.
      JSON.stringify({ v: 1, sessions: { 'session-1': { rows: rows(5), cursor: 2, at: 1 } } }),
    ]) {
      window.localStorage.setItem(`origami-remote/tx/${RID}`, bad);
      const c = open();
      expect(c.cache.paint()).toBe(false);
      expect(c.out).toEqual([]);
    }
  });

  it('forgets a pairing on revoke, by the same key the shell writes', () => {
    hydrate(open().cache, 'session-1', 2);
    expect(window.localStorage.getItem(`origami-remote/tx/${RID}`)).not.toBeNull();
    forgetCache(RID, window);
    expect(window.localStorage.getItem(`origami-remote/tx/${RID}`)).toBeNull();
    expect(open().cache.paint()).toBe(false);
  });
});

describe('the bounds', () => {
  it('keeps no more rows than the desk would ever send in a tail', () => {
    hydrate(open().cache, 'session-1', 200);
    const next = open();
    next.cache.paint();
    expect(next.out[1].messages).toHaveLength(80);
    // The newest end, and the cursor still names the desk's real length.
    expect((next.out[1].messages as Row[])[79].text).toBe('row 199');
    expect(next.cache.snapshot()).toMatchObject({ since: { 'session-1': 200 } });
  });

  it('keeps three chats and evicts the least recently written', () => {
    const c = open();
    // ONE burst, as `replaySessionsTo` sends it: every chat announced and
    // restored, and the active one named at the very end.
    c.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    for (const id of ['a', 'b', 'c', 'd']) {
      c.cache.note({ type: 'sessionCreated', sessionId: id });
      c.cache.note({ type: 'restoreMessages', sessionId: id, messages: rows(2), omitted: 0 });
    }
    c.cache.note({ type: 'restoreActiveSession', sessionId: 'd' });
    const held = Object.keys((open().cache.snapshot() as { since: object }).since);
    expect(held).toHaveLength(3);
    expect(held).not.toContain('a');
  });

  it('drops chats rather than throwing when the record will not fit', () => {
    const c = open();
    const fat = (id: string): void =>
      void c.cache.note({
        type: 'restoreMessages',
        sessionId: id,
        messages: [{ kind: 'agent', text: 'x'.repeat(200_000), timestamp: 1 }],
        omitted: 0,
      });
    c.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    fat('a');
    fat('b');
    // 400 KB of rows cannot be stored under a 250 KB budget: the oldest goes,
    // and what is left is still readable rather than a half-written record.
    const held = Object.keys((open().cache.snapshot() as { since?: object }).since ?? {});
    expect(held.length).toBeLessThanOrEqual(1);
  });
});

describe('a record the quota refuses', () => {
  /** One chat of a working day: 80 rows of ~3.1 KB. Over the 250 KB budget
   *  once serialised — `remoteTail` allows two 2,000-char tool payloads a row,
   *  and the app owner measured three such chats at 256,575 bytes. */
  function heavy(n: number, bytes: number): Row[] {
    return Array.from({ length: n }, (_, i) => ({ kind: 'agent', text: 'x'.repeat(bytes), timestamp: i }));
  }

  it('paints every row of a chat too big to store, and reports no cursor for it', () => {
    const c = open();
    c.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    const out = c.cache.note({
      type: 'restoreMessages',
      sessionId: 'big',
      messages: heavy(80, 3_100),
      omitted: 0,
    }) as Record<string, unknown>;
    // REVERT CHECK: `save()` evicts oldest-first and the set it evicts from
    // includes the record it has just written, so a restore that read the entry
    // BACK out of the file dereferenced undefined. `main.ts` swallows the throw
    // (`.catch(() => undefined)`), so the biggest chat painted empty and stayed
    // empty across every hydration. What is painted must not depend on a quota.
    expect(out.messages).toHaveLength(80);
    // The chat is simply UNCACHEABLE: no cursor, so the desk sends the tail.
    expect((c.cache.snapshot() as { since: Record<string, number> }).since).toEqual({});
  });

  it('does not evict a chat it has DECLARED to make room for another', () => {
    const first = open();
    first.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    for (const id of ['a', 'b']) {
      first.cache.note({ type: 'restoreMessages', sessionId: id, messages: heavy(1, 110_000), omitted: 0 });
    }

    // A new page. Opening the socket is where it DECLARES what it holds, and
    // declaring is what pins: the desk answers `since[id]` with the rows after
    // that cursor and nothing else.
    const back = open();
    expect(Object.keys((back.cache.snapshot() as { since: object }).since).sort()).toEqual(['a', 'b']);
    const out = back.cache.note({
      type: 'restoreMessages',
      sessionId: 'c',
      messages: heavy(1, 110_000),
      omitted: 0,
    }) as Record<string, unknown>;

    // REVERT CHECK: oldest-first alone drops `a` here, and the desk goes on
    // holding a cursor for rows this page no longer has — the next hydration
    // answers it with a handful of rows and the chat is short for ever.
    expect(Object.keys((back.cache.snapshot() as { since: object }).since).sort()).toEqual(['a', 'b']);
    // `c` is the one not stored, and it still paints (the rule above).
    expect(out.messages).toHaveLength(1);
  });

  it('renders a delta it has nothing to splice onto as truncated, and keeps no cursor', () => {
    const c = open();
    c.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    // The desk answering a cursor this page has since lost: rows 6..16 of a log
    // whose first six rows are on no device.
    const out = c.cache.note({
      type: 'restoreMessages',
      sessionId: 'orphan',
      messages: rows(11, 6),
      truncated: true,
      omitted: 6,
      from: 6,
    }) as Record<string, unknown>;
    expect(out.messages).toHaveLength(11);
    // Honest on screen: eleven rows with six above them, never a whole chat.
    expect(out.truncated).toBe(true);
    expect(out.omitted).toBe(6);
    // REVERT CHECK: keeping the cursor asks the desk for another delta on to of
    // an eleven-row stub, for ever. Dropped, the next hydration sends the tail.
    expect((c.cache.snapshot() as { since: object }).since).toEqual({});
  });
});

describe('what the page re-declares after a restore', () => {
  it('sends its cursors and its focus, and never a second `remote/snapshot`', () => {
    const c = open();
    const sent: Array<Record<string, unknown>> = [];
    c.cache.speak((m) => void sent.push(m as Record<string, unknown>));
    hydrate(c.cache, 'session-1', 5, 40);

    // REVERT CHECK 1: 0.4.114 re-declared with a `remote/snapshot`, and a
    // snapshot MEANS "hydrate me" — `hydrateGate.asked()` owes an answer to any
    // absent/present inside its flap window, so a screen-off/on followed by the
    // next restore cost a whole burst. `remote/cursors` says only what is held.
    // REVERT CHECK 2: without the focus the desk scopes the token stream to the
    // DESKTOP's active chat after every hydration (remoteOutbound.forget).
    expect(sent.map((m) => m.type)).toEqual(['remote/cursors', 'remote/focus']);
    expect(sent[0]).toMatchObject({ desk: 'desk-1', since: { 'session-1': 45 } });
    expect(sent[1]).toEqual({ type: 'remote/focus', sessionId: 'session-1' });
  });

  it('names the chat the STRIP moved to, not the one the desktop is on', () => {
    const c = open();
    const sent: Array<Record<string, unknown>> = [];
    const post = c.cache.speak((m) => void sent.push(m as Record<string, unknown>));
    // The chat strip's own tap (sessionBar.ts choose()), read on the way past.
    c.cache.note({ type: 'remote/hello', desk: 'desk-1' });
    c.cache.note({ type: 'sessionCreated', sessionId: 'reading' });
    post({ type: 'remote/focus', sessionId: 'reading' });
    sent.length = 0;
    c.cache.note({ type: 'sessionCreated', sessionId: 'desktop-is-here' });
    c.cache.note({ type: 'restoreActiveSession', sessionId: 'desktop-is-here' });
    expect(sent).toEqual([{ type: 'remote/focus', sessionId: 'reading' }]);
  });
});

describe('a chat the desk no longer has', () => {
  it('repins the pane, so the owner is not stranded on a dead chat', () => {
    hydrate(open().cache, 'gone', 3);
    const next = open();
    next.cache.paint();
    next.out.length = 0;
    // The burst names only the chats this desk really holds, and ends on the
    // active one. `gone` is not among them.
    next.cache.note({ type: 'sessionCreated', sessionId: 'session-2' });
    next.cache.note({ type: 'restoreActiveSession', sessionId: 'session-2' });
    expect(next.out).toContainEqual({ type: 'soloSession', sessionId: 'session-2' });
    expect(next.cache.snapshot()).toMatchObject({ since: {} });
  });
});

describe('the painted bundle cannot talk before the desk has', () => {
  it('holds what is posted until the desktop speaks past the handshake', () => {
    hydrate(open().cache, 'session-1', 2);
    const next = open();
    const sent: unknown[] = [];
    const speak = next.cache.speak((m) => void sent.push(m));
    next.cache.paint();

    // The chat bundle mounts and posts its boot burst. Under K, on a socket
    // whose device key has not verified yet, every one of these is readable by
    // anyone holding the pairing secret (remoteSessionKey.test.ts).
    speak({ type: 'requestSessions' });
    speak({ type: 'requestCollabs' });
    next.cache.note({ type: 'remote/hello', v: 1, device: 'desk', desk: 'desk-1' });
    expect(sent).toEqual([]);

    // The desk's first word past the handshake IS its decision to talk to this
    // page: it withheld the burst until the key verified.
    next.cache.note({ type: 'sessionCreated', sessionId: 'session-1' });
    expect(sent).toEqual([{ type: 'requestSessions' }, { type: 'requestCollabs' }]);

    speak({ type: 'cancel' });
    expect(sent).toHaveLength(3);
  });

  it('holds nothing at all on a page that painted nothing', () => {
    const fresh = open();
    const sent: unknown[] = [];
    const speak = fresh.cache.speak((m) => void sent.push(m));
    fresh.cache.paint();
    speak({ type: 'requestSessions' });
    expect(sent).toEqual([{ type: 'requestSessions' }]);
  });
});
