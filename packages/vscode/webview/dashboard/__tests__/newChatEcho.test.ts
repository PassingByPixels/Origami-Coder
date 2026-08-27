// A NEW chat, typed into before its engine is up: the message must appear ONCE
// and stay once for the rest of the session's life.
//
// Why a new chat is its own case. `createSession` announces the session BEFORE
// it connects (sessionAnnounce.ts: a non-provisional chat "announces first and
// keeps today's behaviour, where a chat is on screen while its engine
// connects"), so the composer is live for the whole engine start and a first
// send is EXPECTED to land pre-connect. Then, once the engine answers, the same
// chat auto-opens its own editor tab (DashboardPanel.ts, after the awaited
// start) — a SECOND view, caught up by `replaySessionsTo`, which re-posts
// `sessionCreated` for every live session and `restoreMessages` with the host's
// whole `messageLog`. So the pane is guaranteed to meet its own session, and
// its own already-drawn rows, a second time.
//
// Those catch-up posts are a REPLAY of state, not new state. The pane used to
// read both as new: a re-announced session was appended as a SECOND entry under
// the same id (a keyed-each duplicate — two cells of the same chat in a popped
// tab), and a replayed log was appended to a transcript that already showed it,
// which is the user's own message on screen twice.
//
// 0.4.19 covers the other half of this — the row is drawn at send and the host
// echo confirms it rather than doubling it (sendEcho.test.ts). This suite is
// about what happens AFTER that, when the host catches a view up.

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const ASK = 'hi who are you';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener, so every mount from an earlier
// test still answers posted messages — a fresh session id per mount keeps each
// assertion about the pane under test (sendEcho.test.ts's own rule).
let seq = 0;

/** A view that has never heard of this chat — what a freshly attached one is. */
function mountBare(solo = false): { c: HTMLElement; sid: string } {
  const sid = `newchat-${++seq}`;
  const { container } = render(ChatPane, { props: solo ? { soloSessionId: sid } : {} });
  return { c: container as HTMLElement, sid };
}

/** A chat announced but NOT yet connected — the state a new chat is in while
 *  the engine starts, and the only state in which a first send can be early. */
async function mountUnconnected(solo = false): Promise<{ c: HTMLElement; sid: string }> {
  const { c, sid } = mountBare(solo);
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  await tick();
  return { c, sid };
}

/** What `replaySessionsTo` posts to a view it is catching up (in that order). */
function replayCatchUp(sid: string, log: Array<Record<string, unknown>>) {
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: 1, agentName: 'Tsuru' });
  if (log.length > 0) post({ type: 'restoreMessages', sessionId: sid, messages: log });
  post({ type: 'restoreActiveSession', sessionId: sid });
}

async function sendFromComposer(c: HTMLElement, text: string) {
  await fireEvent.input(c.querySelector('.input') as HTMLTextAreaElement, { target: { value: text } });
  await fireEvent.click(c.querySelector('.btn.send') as HTMLButtonElement);
  await tick();
}

const userRows = (c: HTMLElement) => [...c.querySelectorAll('.row.user')];
const rowKinds = (c: HTMLElement) => [...c.querySelectorAll('.row')].map((r) => r.className.split(' ')[1]);

describe('new chat — a first send lands before the engine answers', () => {
  it('shows the message once, where the user typed it: above the Connected line', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    // The host echoes straight back (before its model reprobe), then the engine
    // finishes starting and the panel posts its Connected line.
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'system', sessionId: sid, text: 'Connected. Session ses_abc. Type a message and press Enter.' });
    post({ type: 'agentText', sessionId: sid, text: 'I am Tsuru.' });
    post({ type: 'turnDone', sessionId: sid, stopReason: 'success' });
    await tick();
    expect(userRows(c).length).toBe(1);
    expect(rowKinds(c), 'the question stays where it was asked — before the connect notice')
      .toEqual(['user', 'system', 'agent']);
  });

  it('keeps it once when the engine refuses the early prompt and the turn ends in an error', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'error', sessionId: sid, message: 'prompt failed: AcpClient.prompt called before start()' });
    post({ type: 'turnDone', sessionId: sid, stopReason: 'error' });
    post({ type: 'system', sessionId: sid, text: 'Connected. Session ses_abc. Type a message and press Enter.' });
    await tick();
    expect(userRows(c).length).toBe(1);
  });
});

describe('new chat — the host catches a view up on a session it already holds', () => {
  it('does not draw the message a second time when the log is replayed under it', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'system', sessionId: sid, text: 'Connected. Session ses_abc. Type a message and press Enter.' });
    await tick();
    // The host's messageLog already has this send in it (the `send` case logs
    // the same text it echoes), so its replay is the message already on screen.
    post({ type: 'restoreMessages', sessionId: sid, messages: [{ kind: 'user', text: ASK, timestamp: Date.now() }] });
    await tick();
    expect(userRows(c).length, 'the replayed log is the same message, not a second one').toBe(1);
    expect(rowKinds(c), 'and nothing else was re-added under it').toEqual(['user', 'system']);
  });

  it('survives the whole catch-up — re-announce, log, active pointer — with one of everything', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'system', sessionId: sid, text: 'Connected. Session ses_abc. Type a message and press Enter.' });
    await tick();
    // The chat's own editor tab opens once the engine is up; this is exactly
    // what replaySessionsTo posts into a view, in that order.
    replayCatchUp(sid, [{ kind: 'user', text: ASK, timestamp: Date.now() }]);
    await tick();
    expect(c.querySelectorAll('.chat-cell').length, 'one chat, one cell').toBe(1);
    expect(userRows(c).length).toBe(1);
    expect(rowKinds(c)).toEqual(['user', 'system']);
  });

  it('renders the chat once — a re-announced session is the same session', async () => {
    const { c, sid } = await mountUnconnected(true);
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    await tick();
    replayCatchUp(sid, []);
    await tick();
    expect(c.querySelectorAll('.chat-cell').length, 'one chat, one cell').toBe(1);
    expect(userRows(c).length).toBe(1);
  });

  it('draws a message typed AFTER the catch-up once — the echo has to find the chat it was sent from', async () => {
    // The double this closes: a second entry under one id splits the chat in
    // two. The composer sends against the cell's own session (arming
    // `pendingEcho` there) while `addMessage` and the `echoUser` guard both
    // resolve the id to the FIRST entry — so the row lands on one and the guard
    // on the other, and the host echo draws the message a second time.
    const { c, sid } = await mountUnconnected(true);
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    const inputs = c.querySelectorAll('.input');
    const sends = c.querySelectorAll('.btn.send');
    await fireEvent.input(inputs[inputs.length - 1] as HTMLTextAreaElement, { target: { value: ASK } });
    await fireEvent.click(sends[sends.length - 1] as HTMLButtonElement);
    await tick();
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    await tick();
    expect(userRows(c).length).toBe(1);
  });

  it('takes the identity the replay carries — a title learned before this view attached', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    await tick();
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: 1, agentName: 'Tsuru', title: 'who is Tsuru' });
    await tick();
    expect(c.textContent, 'the replayed title shows').toContain('who is Tsuru');
    expect(userRows(c).length, 'and the transcript survived it').toBe(1);
  });
});

describe('new chat — a view with nothing on screen is still caught up', () => {
  it('restores the whole log into a freshly attached, empty transcript', async () => {
    const { c, sid } = mountBare();
    replayCatchUp(sid, [
      { kind: 'user', text: ASK, timestamp: Date.now() },
      { kind: 'agent', text: 'I am Tsuru.', timestamp: Date.now() },
    ]);
    await tick();
    expect(userRows(c).length).toBe(1);
    expect(rowKinds(c)).toEqual(['user', 'agent']);
  });
});

// This block used to read "a line QUEUED during the first turn", and the queue
// is gone: typing during a turn now delivers into it on the keypress
// (composerEnter.test.ts). The invariant it was written for is untouched and is
// what both tests below still assert — the second line crosses the wire ONCE and
// appears ONCE. Only the wire message changed.
describe('new chat — a line typed during the first turn', () => {
  const wire = () => globalThis.__vscodeApiMock.postMessage.mock.calls
    .map((x: unknown[]) => x[0] as Record<string, unknown>);
  const SECOND = 'and what can you do';

  /** Type the second line during the first turn and press Enter. */
  async function typeDuringTurn(c: HTMLElement) {
    const box = c.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: SECOND } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();
  }

  it('crosses once as an interjection, and appears once when the turn ends', async () => {
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    await typeDuringTurn(c);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'turnDone', sessionId: sid, stopReason: 'success' });
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    await tick();

    expect(userRows(c).map((r) => r.textContent)).toHaveLength(2);
    expect(wire().filter((m) => m.type === 'interject').length, 'the second line crossed once').toBe(1);
    expect(wire().filter((m) => m.type === 'send').length, 'and did NOT also cross as a send').toBe(1);
  });

  it('and when the engine is not up yet, the refusal brings it back as a send — once', async () => {
    // The whole point of this file: a new chat is typed into WHILE its engine
    // starts. An interjection then has no engine session to reach, the host says
    // so before the message crosses (turnMessages.ts), and the line is owed a
    // turn rather than a row (interjectRetry.ts). Losing it here would be the
    // same defect this suite exists for, one layer down.
    const { c, sid } = await mountUnconnected();
    await sendFromComposer(c, ASK);
    await typeDuringTurn(c);

    post({ type: 'error', sessionId: sid, message: 'Interject failed: no running turn to interject into.' });
    await tick();
    post({ type: 'echoUser', sessionId: sid, text: SECOND });
    await tick();

    expect(userRows(c).map((r) => r.textContent), 'each line on screen exactly once').toHaveLength(2);
    expect(userRows(c)[1].textContent).toContain(SECOND);
    expect(wire().filter((m) => m.type === 'send' && m.text === SECOND).length,
      'the refused line went out as a fresh prompt, once').toBe(1);
  });
});
