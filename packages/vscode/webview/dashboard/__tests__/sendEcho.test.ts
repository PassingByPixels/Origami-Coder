// The user's OWN message on screen: when it appears, and how many of it there are.
//
// UAT (0.4.18): press Enter and the transcript shows nothing but "reasoning…";
// the message lands later, and then reads twice. Two separate defects sat behind
// that one report, and this suite pins both:
//
//  1. WHEN. The row was drawn only when the host posted `echoUser` back, and the
//     host echoes AFTER `if (!this.modelInfo.ok) await this.reprobeModel()`
//     (DashboardPanel.ts) — two sequential HTTP probes, 4 s timeout each. The
//     composer had already flipped to in-flight, so a chat whose provider never
//     answers an LM Studio-shaped probe showed a running turn with no question
//     in it. The row is now drawn at send; the host's echo confirms it.
//
//  2. HOW MANY. `echoUser` therefore now arrives for a row that already exists,
//     and must not draw a second one — while an `echoUser` NOBODY here typed
//     (history replay, a slash command the host expanded, an Agent Manager task)
//     still must. `pendingEcho` is the only thing that separates them.
//
// The third strand is the pinned mirror: it renders the same words a second time
// directly above the real row, which is what "appears TWICE" actually is.

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const ASK = 'who are you';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener, so every mount from an earlier
// test still answers posted messages — a fresh session id per mount keeps each
// assertion about the pane under test (composerEnter.test.ts's own rule).
let seq = 0;

/** A live chat, mounted the way the user reaches one. */
async function mountChat(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `echo-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  post({ type: 'modelStatus', sessionId: sid, ok: true, modelName: 'deepseek' });
  await tick();
  return { c: container as HTMLElement, sid };
}

/** Type into the composer and press its send button — a real send, not a post. */
async function sendFromComposer(c: HTMLElement, text: string) {
  await fireEvent.input(c.querySelector('.input') as HTMLTextAreaElement, { target: { value: text } });
  await fireEvent.click(c.querySelector('.btn.send') as HTMLButtonElement);
  await tick();
}

const userRows = (c: HTMLElement) => [...c.querySelectorAll('.row.user')];

describe('send echo — the row is drawn at send, not on the host round trip', () => {
  it('puts the message in the transcript the instant it is sent, before the host answers', async () => {
    const { c } = await mountChat();
    await sendFromComposer(c, ASK);

    // Nothing has come back from the host yet — this is the frame the UAT
    // screenshot caught, with "reasoning…" up and the question missing.
    expect(c.querySelector('.stream-indicator'), 'the turn is visibly running').not.toBeNull();
    const rows = userRows(c);
    expect(rows.length, 'exactly one user row, already on screen').toBe(1);
    expect(rows[0].textContent).toContain(ASK);
  });

  it('treats the host echo as confirmation of that row, not as a second message', async () => {
    const { c, sid } = await mountChat();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    await tick();
    expect(userRows(c).length).toBe(1);
  });

  it('still shows the message once after the reply lands', async () => {
    const { c, sid } = await mountChat();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    post({ type: 'agentText', sessionId: sid, text: 'I am Tsuru.' });
    post({ type: 'turnDone', sessionId: sid, stopReason: 'success' });
    await tick();
    expect(userRows(c).length).toBe(1);
  });

  it('consumes ONE pending echo: a later replay of the same words still draws its own row', async () => {
    const { c, sid } = await mountChat();
    await sendFromComposer(c, ASK);
    post({ type: 'echoUser', sessionId: sid, text: ASK });          // confirmation
    await tick();
    post({ type: 'echoUser', sessionId: sid, text: ASK, replay: true }); // a real second turn
    await tick();
    expect(userRows(c).length).toBe(2);
  });

  it('keeps the row for a send the host REFUSES, and stops waiting for an echo that is never coming', async () => {
    // A budget-blocked turn returns before `echoUser` is ever posted — the old
    // pane showed nothing at all for a message the user definitely typed.
    const { c, sid } = await mountChat();
    await sendFromComposer(c, ASK);
    post({ type: 'turnDone', sessionId: sid, stopReason: 'blocked' });
    await tick();
    expect(userRows(c).length, 'the message the user typed stays on screen').toBe(1);
    // The stale pending slot must not swallow the NEXT echo of the same words.
    post({ type: 'echoUser', sessionId: sid, text: ASK });
    await tick();
    expect(userRows(c).length).toBe(2);
  });

  it('draws a row for a user turn this pane never sent (history replay)', async () => {
    const { c, sid } = await mountChat();
    post({ type: 'echoUser', sessionId: sid, text: 'restored turn', replay: true });
    await tick();
    expect(userRows(c).length).toBe(1);
    expect(userRows(c)[0].textContent).toContain('restored turn');
  });

  it('matches the host echo for a MODE command, which the host echoes with its /prefix', async () => {
    const { c, sid } = await mountChat();
    await sendFromComposer(c, '/loop 30m triage the failing tests');
    // What the host actually posts back for `send` with mode='loop'.
    post({ type: 'echoUser', sessionId: sid, text: '/loop 30m triage the failing tests' });
    await tick();
    const rows = userRows(c);
    expect(rows.length, 'the local row and the host echo are the same message').toBe(1);
    expect(rows[0].textContent).toContain('/loop 30m triage the failing tests');
  });
});

describe('send echo — the pinned mirror never doubles a row that is already on screen', () => {
  it('shows no mirror while the user message is the last thing in the transcript', async () => {
    const { c } = await mountChat();
    await sendFromComposer(c, ASK);
    expect(c.querySelector('.pinned-user'), 'nothing has scrolled under it yet').toBeNull();
    // ...and the words appear exactly once on the whole surface.
    expect([...c.querySelectorAll('.row.user, .pinned-user')].length).toBe(1);
  });

  it('mirrors once the agent has put output below it — that is what the mirror is for', async () => {
    const { c, sid } = await mountChat();
    await sendFromComposer(c, ASK);
    post({ type: 'agentText', sessionId: sid, text: 'I am Tsuru.' });
    await tick();
    expect(c.querySelectorAll('.pinned-user').length).toBe(1);
  });
});

describe('send echo — an interjection is a message the user sent too', () => {
  // The one place this suite's "draw it at the click" rule does NOT hold, and
  // interjectSplit.ts says why: an interjection's row also marks a SPLIT in the
  // turn under it, and a split is only true once the engine has taken the line.
  // The cost that bought the optimistic row for `send` — the 4 s model reprobe —
  // does not exist on this path, and the "interjecting…" chip covers the gap
  // (InterjectingChip.svelte, all that is left of the retired queue chip).
  it('appears in the transcript exactly once, at the moment the turn takes it', async () => {
    const { c, sid } = await mountChat();
    post({ type: 'busy', sessionId: sid });
    await tick();
    // Enter during a turn IS the interjection — it posts on the keypress.
    const box = c.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'stop and explain' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await tick();
    expect(userRows(c).length, 'the engine has not taken it yet — the chip is the placeholder').toBe(0);

    post({ type: 'interjected', sessionId: sid });
    await tick();
    const rows = userRows(c);
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('stop and explain');
    expect(posted().filter((m) => m.type === 'interject').length, 'and it crossed once').toBe(1);
  });
});
