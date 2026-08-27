// M4.4 scroll stick, driven through the real ChatPane.
//
// THE BUG. scrollToBottom fired from EVERY streamed chunk, so scrolling up to
// re-read what the agent did four tool calls ago yanked you back the moment the
// next token landed. The transcript became unreadable exactly while it was
// worth reading, and the only workaround was to stop the turn.
//
// WHY ITS OWN FILE. ChatPane registers a window `message` listener that it
// never removes, so an instance rendered by an earlier test in the same file
// keeps handling host messages after unmount — and its scrollToBottom resolves
// its target with a DOCUMENT-wide `querySelector`, which then finds THIS test's
// scroller and scrolls it. Harmless in the product (one ChatPane per webview)
// but fatal to a test whose whole assertion is a scrollTop. Vitest isolates per
// FILE, so these three live alone. The same split collabLiveThought.test.ts and
// collabBubbles.test.ts already take off CollabPane.test.ts.

import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import ChatPane from './ChatPane.svelte';

const ACP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_UUID = '11111111-2222-3333-4444-555555555555';
const postFromHost = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', { data }));

function newSession() {
  postFromHost({ type: 'sessionCreated', sessionId: ACP_UUID, sessionNumber: 1, agentName: 'Coder', agentArt: null });
  postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
}

/** Asserts INSIDE waitFor: a bare `waitFor(() => querySelector(x))` resolves
 *  immediately with null, because returning null does not throw. */
const need = <T extends Element>(container: HTMLElement, sel: string): Promise<T> =>
  waitFor(() => {
    const el = container.querySelector(sel) as T | null;
    expect(el).not.toBeNull();
    return el!;
  });

/** jsdom lays nothing out, so the scroller's metrics are supplied here. These
 *  tests assert the STICK RULE, not the browser's layout engine. */
function fakeScroller(el: HTMLDivElement, atBottom: boolean) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
  el.scrollTop = atBottom ? 600 : 100;
}
/** Content arriving under the scroller. Only the BOTTOM moves — scrollTop is
 *  untouched, which is what separates growth from a user scroll. */
function grow(el: HTMLDivElement, scrollHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

async function mounted() {
  const { container } = render(ChatPane);
  newSession();
  postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'first line\n' });
  const el = await need<HTMLDivElement>(container, '.cell-messages');
  return { container, el };
}

describe('ChatPane — the transcript follows the stream only while you are at the bottom', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });
  // MANDATORY here, not housekeeping. scrollToBottom resolves its target with
  // `document.querySelector('.cell-messages[data-session-id=…]')` — the FIRST
  // match in the document. Leave a previous test's container mounted and every
  // later test scrolls that one instead of its own, which reads as the stick
  // failing when nothing is wrong. The house pattern boardShell.test.ts and
  // collabAgentsPane.test.ts already follow.
  afterEach(() => cleanup());

  it('holds position while a chunk streams into a transcript the user scrolled up in', async () => {
    const { el } = await mounted();

    // jsdom fires no scroll event of its own, so the handler is driven the way
    // a browser would drive it.
    fakeScroller(el, false);
    await fireEvent.scroll(el);

    el.scrollTop = 100;
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'more streamed text\n' });
    await nextFrame();
    expect(el.scrollTop).toBe(100);
  });

  it('honours upward wheel intent before the first movement clears the bottom threshold', async () => {
    const { el } = await mounted();
    await nextFrame();
    fakeScroller(el, true);

    await fireEvent.wheel(el, { deltaY: -20 });
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'chunk queued after wheel\n' });
    el.scrollTop = 580;
    await fireEvent.scroll(el);
    await nextFrame();

    expect(el.scrollTop).toBe(580);
  });

  it('does not snap for a terminal verdict that arrives after the visible response', async () => {
    const { el } = await mounted();
    fakeScroller(el, true);
    await nextFrame();
    el.scrollTop = 540;
    await fireEvent.scroll(el);

    postFromHost({ type: 'turnVerdict', sessionId: ACP_UUID, stopReason: 'success' });
    await nextFrame();

    expect(el.scrollTop).toBe(540);
  });

  it('keeps holding across MANY chunks — the stick is not a one-shot', async () => {
    const { el } = await mounted();
    await nextFrame();
    fakeScroller(el, false);
    await fireEvent.scroll(el);

    for (let i = 0; i < 5; i++) {
      el.scrollTop = 100;
      postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: `chunk ${i}\n` });
      await nextFrame();
      expect(el.scrollTop).toBe(100);
    }
  });

  it('resumes following the moment the user scrolls back to the bottom', async () => {
    const { el } = await mounted();
    fakeScroller(el, false);
    await fireEvent.scroll(el);
    fakeScroller(el, true);
    await fireEvent.scroll(el);

    // A following scroller proves itself by TRACKING new content. Parking
    // scrollTop somewhere first would prove nothing — moving the scroller by
    // hand is exactly what a user drag looks like, and now reads as one.
    grow(el, 1400);
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'and more\n' });
    await nextFrame();
    expect(el.scrollTop).toBe(1400);
  });

  it('the user SENDING a message re-arms the follow, wherever they were reading', async () => {
    // Their own send is an explicit "I want to watch this".
    const { container, el } = await mounted();
    fakeScroller(el, false);
    await fireEvent.scroll(el);

    const box = await need<HTMLTextAreaElement>(container, 'textarea.input');
    await fireEvent.input(box, { target: { value: 'carry on' } });
    const send = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Send')!;
    await fireEvent.click(send);

    grow(el, 1400);
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'reply\n' });
    await nextFrame();
    expect(el.scrollTop).toBe(1400);
  });

  it('a fresh session follows by default — nothing has to opt in', async () => {
    // `stuckToBottom` is undefined until the user scrolls, and undefined must
    // mean FOLLOW: otherwise a brand-new chat would never scroll its first
    // reply into view.
    const { el } = await mounted();
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 0;
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'reply\n' });
    await nextFrame();
    expect(el.scrollTop).toBe(1000);
  });

  // ── Everything that moves a scroller and is NOT a wheel ────────────────────
  //
  // The 0.4.2 guard read WHEEL intent, because a `scroll` event alone came too
  // late: the browser queues it to the next rendering opportunity, the queued
  // frame snaps the scroller back FIRST, and the coalesced event then reports
  // the BOTTOM — the user's movement is erased before any handler sees it.
  // A scrollbar drag, PgUp/PgDn/Home/End, the arrow keys, a touch drag and
  // find-in-page all move the scroller with no wheel event at all, so for all
  // of them the stick never disarms and every chunk snaps.
  //
  // These tests reproduce that ordering literally: move `scrollTop`, fire NO
  // scroll event, then let the queued frame run.

  it('holds a scrollbar drag whose scroll event has not fired yet when a chunk lands', async () => {
    const { el } = await mounted();
    fakeScroller(el, true);
    await fireEvent.scroll(el);
    await nextFrame();

    el.scrollTop = 100;
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'chunk mid-drag\n' });
    await nextFrame();

    expect(el.scrollTop).toBe(100);
  });

  it('holds a keyboard scroll-up when the turn COMPLETES', async () => {
    // "It snapped after streaming finished": the end-of-turn events scroll too,
    // so a PgUp during the last chunk is undone by the completion, not by a chunk.
    const { el } = await mounted();
    fakeScroller(el, true);
    await fireEvent.scroll(el);
    await nextFrame();

    el.scrollTop = 220;
    postFromHost({ type: 'planReady', sessionId: ACP_UUID, planId: 'p1', title: 'Plan', status: 'awaiting_user' });
    postFromHost({ type: 'turnDone', sessionId: ACP_UUID });
    await nextFrame();

    expect(el.scrollTop).toBe(220);
  });

  it('a scroll shorter than one message row still counts as reading', async () => {
    // One arrow-key press is ~30px. Treating that as "still at the bottom"
    // re-arms the follow and the next chunk snaps — the user's deliberate
    // movement is read as noise.
    const { el } = await mounted();
    fakeScroller(el, true);
    await fireEvent.scroll(el);
    await nextFrame();

    el.scrollTop = 570;
    await fireEvent.scroll(el);
    postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: 'chunk\n' });
    await nextFrame();

    expect(el.scrollTop).toBe(570);
  });

  it("a background session's message never scrolls the chat on screen", async () => {
    // `single` layout renders the ACTIVE cell only, so a background session has
    // no scroller in the DOM. Its scroll must then do nothing — not fall back
    // to whichever scroller happens to be bound, which is the one the user is
    // reading and whose own stick was never consulted.
    const { container } = await mounted();
    postFromHost({ type: 'sessionCreated', sessionId: OTHER_UUID, sessionNumber: 2, agentName: 'Peer', agentArt: null });
    postFromHost({ type: 'restoreActiveSession', sessionId: ACP_UUID });
    const el = await need<HTMLDivElement>(container, `.cell-messages[data-session-id="${ACP_UUID}"]`);

    fakeScroller(el, false);
    await fireEvent.scroll(el);
    el.scrollTop = 100;

    postFromHost({ type: 'peerMessage', sessionId: OTHER_UUID, from: 'Scout', text: 'handoff done' });
    await nextFrame();

    expect(el.scrollTop).toBe(100);
  });

  it('a transcript growing under an armed follow is not mistaken for a user scroll', async () => {
    // The other side of the guard above: only `scrollHeight` changes here, the
    // user touched nothing, and the follow must survive every growth step.
    const { el } = await mounted();
    fakeScroller(el, true);
    await fireEvent.scroll(el);
    await nextFrame();

    for (let i = 0; i < 3; i++) {
      grow(el, 1000 + i * 200);
      postFromHost({ type: 'agentText', sessionId: ACP_UUID, text: `grow ${i}\n` });
      await nextFrame();
      expect(el.scrollTop).toBe(1000 + i * 200);
    }
  });
});
