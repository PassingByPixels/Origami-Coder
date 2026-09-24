// What ENTER does in the composer — the whole rule, in one place.
//
// It used to do three different things depending on state, and one of them was
// a UI the user had to learn: mid-turn, Enter QUEUED the line into a chip, and
// a second click on that chip's "Interject" button was what actually delivered
// it. The owner's report of that surface is the requirement this file encodes:
// "i just hit enter and its sent in the chat". So:
//
//   idle      -> a normal prompt (unchanged)
//   in flight -> an interjection, posted IMMEDIATELY, composer cleared
//
// There is no queue any more, and that removes a whole hazard class rather than
// guarding it: composerQueue.test.ts (this file's predecessor) existed mostly to
// rule out a DOUBLE SEND, where a `turnDone` racing the host round trip flushed
// the queued copy of a line the engine had already taken. With no queued copy to
// flush, the only way a line can go twice now is the RETRY below, so that is
// what the double-send assertions moved onto.
//
// The retry is the "sensibly" half. `turnMessages.ts` refuses a line BEFORE it
// crosses the wire when the chat has no engine session to reach, and that
// refusal is the one failure where the engine provably never saw the text — so
// the line is re-sent as an ordinary prompt instead of being drawn as a row that
// landed. Every OTHER failure keeps the annotated shape (the row, then the error
// under it), because the engine may well have taken the line.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ChatPane from '../panes/ChatPane.svelte';
import { flushQueuedSend } from '../panes/queuedFlush';
import { NEVER_REACHED_ENGINE, retryAsPrompt } from '../panes/interjectRetry';
import { SLASH_WAITS } from '../components/interjectHold';

const LINE = 'also check the migration';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const sends = () => posted().filter((m) => m.type === 'send');
const interjects = () => posted().filter((m) => m.type === 'interject');
/** Let a deferred send (`setTimeout(…, 0)`) actually run. */
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await tick(); };

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane binds its `window` message listener at init and never unbinds it, so
// an unmounted instance from an earlier test still answers every posted message.
// A FRESH session id per mount is what keeps each assertion about the pane under
// test: every stale listener resolves the id to no session of its own.
let seq = 0;

/** A chat with a turn running, reached the way the host drives one. */
async function mountBusy(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `enter-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  await tick();
  post({ type: 'busy', sessionId: sid }); // host-driven in-flight, same flag a send sets
  await tick();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  return { c: container as HTMLElement, sid };
}

/** Type a line and press ENTER — the only gesture this file is about. */
async function enter(c: HTMLElement, text: string) {
  const box = c.querySelector('.input') as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: text } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  await tick();
}

/** Every transcript row in document order. */
const rows = (c: HTMLElement) => [...c.querySelectorAll('.cell-messages .row')].map((el) => ({
  kind: [...el.classList].find((k) => k !== 'row') ?? '',
  text: el.textContent ?? '',
}));
const userRows = (c: HTMLElement) => rows(c).filter((r) => r.kind === 'user');

describe('Enter, mid-turn: the line goes into the running turn at once', () => {
  it('posts the interjection on the keypress — no button, no second gesture', async () => {
    const { c, sid } = await mountBusy();

    await enter(c, LINE);

    expect(interjects()).toEqual([{ type: 'interject', sessionId: sid, text: LINE }]);
    expect(sends(), 'a turn is running — this is not a fresh prompt').toEqual([]);
  });

  it('clears the composer, exactly as a normal send does', async () => {
    const { c } = await mountBusy();
    await enter(c, LINE);
    expect((c.querySelector('.input') as HTMLTextAreaElement).value).toBe('');
  });

  it('writes NO queue state: nothing is left for the turn boundary to flush', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, LINE);

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(sends(), 'the engine has the line — sending it again duplicates it').toEqual([]);
  });

  it('leaves no queue surface behind — no chip, no Interject button, no cancel ✕', async () => {
    const { c } = await mountBusy();
    await enter(c, LINE);
    for (const dead of ['.queued-chip', '.queued-interject', '.queued-x']) {
      expect(c.querySelector(dead), `${dead} is the retired queue UI`).toBeNull();
    }
  });

  it('says it is delivering, so the composer is not blank for the round trip', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, LINE);
    // The row itself waits for the host answer (interjectSplit.ts). This is what
    // covers that window — and the same answer retires it.
    expect(c.querySelector('.interjecting-chip')).not.toBeNull();

    post({ type: 'interjected', sessionId: sid });
    await tick();
    expect(c.querySelector('.interjecting-chip')).toBeNull();
    expect(userRows(c).map((r) => r.text.includes(LINE))).toEqual([true]);
  });

  it('still refuses a SLASH command mid-turn — its side effects wait for idle', async () => {
    const { c } = await mountBusy();
    await enter(c, '/compact');

    expect(interjects()).toEqual([]);
    expect(posted().filter((m) => m.type === 'slashCommand')).toEqual([]);
    expect((c.querySelector('.input') as HTMLTextAreaElement).value,
      'and the draft is kept, not eaten').toBe('/compact');
  });
});

// The IMAGE half of the same keypress.
//
// It used to do NOTHING. The wire carried `{ type:'interject', sessionId, text }`
// and nothing else, so `doSend`'s in-flight branch HELD a draft with a picture
// on it — no post, no chip, no word — and the draft simply sat there until the
// turn ended. On a long turn that is indistinguishable from a broken button,
// which is how the owner met it (t-4ahs3u): an image plus two paragraphs, a
// composer showing Send and Cancel, and no way to send.
//
// The wire carries the pictures now, in the SAME `{dataUrl,name}` shape a fresh
// prompt's `sendWithImages` uses, so a mid-turn message is the mid-turn message
// it would have been without the attachment. What genuinely cannot go into a
// running turn — a slash command, a composer with no turn to reach — says so in
// one line instead (interjectHold.ts).
describe('Enter, mid-turn, WITH an image: it goes INTO the turn, picture and all', () => {
  let realImage: typeof Image;
  beforeAll(() => {
    realImage = globalThis.Image;
    // jsdom decodes nothing, so `resizeIfNeeded`'s `new Image()` settles
    // neither way and the intake promise would hang forever. A stub reporting
    // a small picture takes the no-resize branch — the path a pasted
    // screenshot under 2048px takes in the real composer.
    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      width = 8;
      height = 8;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = StubImage as unknown as typeof Image;
  });
  afterAll(() => { globalThis.Image = realImage; });

  const withImages = () => posted().filter((m) => m.type === 'sendWithImages');
  const shot = { dataUrl: expect.stringContaining('data:image/png'), name: 'shot.png' };

  /** Paste one PNG into the composer, the way a screenshot arrives. */
  async function attach(c: HTMLElement) {
    const box = c.querySelector('.input') as HTMLTextAreaElement;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
    await fireEvent.paste(box, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
    await vi.waitFor(() => expect(c.querySelector('.image-strip')).not.toBeNull());
  }

  it('posts the interjection WITH the picture — the defect was nothing being posted at all', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);
    await enter(c, LINE);

    expect(interjects()).toEqual([{ type: 'interject', sessionId: sid, text: LINE, images: [shot] }]);
    expect(withImages(), 'it goes INTO the turn, not behind it as a fresh prompt').toEqual([]);
  });

  it('clears the composer and the strip, exactly as an idle send does', async () => {
    const { c } = await mountBusy();
    await attach(c);
    await enter(c, LINE);

    expect((c.querySelector('.input') as HTMLTextAreaElement).value).toBe('');
    expect(c.querySelector('.image-strip')).toBeNull();
  });

  it('sends a picture with NO words on it — "look at this" is a whole message', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);
    await enter(c, '');

    expect(interjects()).toEqual([{ type: 'interject', sessionId: sid, text: '', images: [shot] }]);
  });

  it('draws the picture in the transcript row the host answer opens', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);
    await enter(c, LINE);

    post({ type: 'interjected', sessionId: sid });
    await tick();

    const row = [...c.querySelectorAll('.cell-messages .row.user')].at(-1)!;
    expect(row.textContent).toContain(LINE);
    // The row an ordinary prompt draws carries its attachments; an interjected
    // one that showed the words alone would be a different transcript for the
    // same message.
    expect(row.querySelector('img.chat-image')?.getAttribute('src')).toContain('data:image/png');
  });

  it('goes out ONCE — the turn ending does not send it again', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);
    await enter(c, LINE);

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(interjects().length).toBe(1);
    expect(withImages(), 'nothing was left behind for the boundary to flush').toEqual([]);
  });

  it('a SLASH command with a picture on it is still refused — and now says why', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);
    await enter(c, '/compact');

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(interjects()).toEqual([]);
    expect(withImages()).toEqual([]);
    expect(posted().filter((m) => m.type === 'slashCommand')).toEqual([]);
    expect((c.querySelector('.input') as HTMLTextAreaElement).value).toBe('/compact');
  });

  it('says WHY a refused mid-turn line went nowhere, instead of a dead Send', async () => {
    const { c } = await mountBusy();
    await attach(c);
    await enter(c, '/compact');

    // The sentence is the deliverable: a composer that swallows the keypress in
    // silence is the whole defect, picture or no picture.
    expect(c.querySelector('.interjecting-chip.held')?.textContent).toContain(SLASH_WAITS);
  });

  it('an image attached but never entered is not sent when the turn ends', async () => {
    const { c, sid } = await mountBusy();
    await attach(c);

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(withImages(), 'nothing was ever submitted').toEqual([]);
    expect(interjects()).toEqual([]);
    expect(c.querySelector('.image-strip')).not.toBeNull();
  });
});

describe('Enter, idle: unchanged', () => {
  it('sends a normal prompt', async () => {
    const sid = `enter-idle-${++seq}`;
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await enter(container as HTMLElement, LINE);

    expect(sends()).toEqual([{ type: 'send', text: LINE, sessionId: sid, mode: undefined }]);
    expect(interjects()).toEqual([]);
  });
});

describe('rapid Enters: FIFO, one row each, in the order they were typed', () => {
  it('posts every line, in order', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, 'first');
    await enter(c, 'second');
    await enter(c, 'third');

    expect(interjects()).toEqual([
      { type: 'interject', sessionId: sid, text: 'first' },
      { type: 'interject', sessionId: sid, text: 'second' },
      { type: 'interject', sessionId: sid, text: 'third' },
    ]);
  });

  it('draws the OLDEST line on each answer — a second Enter cannot overwrite the first', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, 'first');
    await enter(c, 'second');

    post({ type: 'interjected', sessionId: sid });
    await tick();
    expect(userRows(c).length, 'one answer, one row').toBe(1);
    expect(userRows(c)[0].text).toContain('first');

    post({ type: 'interjected', sessionId: sid });
    await tick();
    expect(userRows(c).map((r) => r.text.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ]);
    expect(c.querySelector('.interjecting-chip'), 'nothing outstanding now').toBeNull();
  });

  it('a turn that ends with several still outstanding loses none of them', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, 'first');
    await enter(c, 'second');

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(userRows(c).map((r) => r.text.includes('first') || r.text.includes('second'))).toEqual([true, true]);
    expect(userRows(c)[0].text).toContain('first');
    expect(sends(), 'they were delivered, not queued').toEqual([]);
  });
});

describe('the turn-end race: a line the engine never saw is not lost', () => {
  it('re-sends it as an ordinary prompt — exactly once', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, LINE);

    post({ type: 'error', sessionId: sid, message: NEVER_REACHED_ENGINE });
    await settle();

    expect(sends(), 'the words came back as the next prompt').toEqual([
      { type: 'send', text: LINE, sessionId: sid, mode: undefined },
    ]);
    // ONE representation of the line: the retry's own echo row, not that plus an
    // interjected row claiming a place in a turn it never entered.
    expect(userRows(c).filter((r) => r.text.includes(LINE)).length).toBe(1);
  });

  it('and NOT twice — a turnDone behind the error finds nothing left to send', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, LINE);

    post({ type: 'error', sessionId: sid, message: NEVER_REACHED_ENGINE });
    await settle();
    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(sends().length, 'one line, one send').toBe(1);
  });

  it('two refused lines both come back, in order — the second is not eaten by the first', async () => {
    // The sharp edge of retrying at all. Both refusals land before either send
    // does, so a retry that defers itself would run second AFTER the first retry
    // had already put the session back in flight — and `handleSendForSession`
    // drops a send on an in-flight session without a word. Losing the line the
    // fallback exists to save is worse than never having had the fallback.
    const { c, sid } = await mountBusy();
    await enter(c, 'first');
    await enter(c, 'second');

    post({ type: 'error', sessionId: sid, message: NEVER_REACHED_ENGINE });
    post({ type: 'error', sessionId: sid, message: NEVER_REACHED_ENGINE });
    await settle();

    expect(sends().map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('a GENUINE failure on a live turn keeps its words in place instead, annotated', async () => {
    const { c, sid } = await mountBusy();
    await enter(c, LINE);

    // An engine-side refusal: the line may well have been taken before it failed,
    // so re-sending it is the double-send, not the fix.
    post({ type: 'error', sessionId: sid, message: 'Interject failed: session not found: ses_9' });
    await settle();

    const shape = rows(c);
    expect(shape.map((r) => r.kind)).toEqual(['user', 'error']);
    expect(shape[0].text).toContain(LINE);
    expect(shape[1].text).toContain('Interject failed');
    expect(sends(), 'not re-sent — it may already be in the turn').toEqual([]);
  });
});

describe('interjectRetry — which failures mean the engine never saw the line', () => {
  it('is the host\'s own pre-wire refusal, and nothing else', () => {
    expect(retryAsPrompt(NEVER_REACHED_ENGINE)).toBe(true);
    expect(retryAsPrompt(`  ${NEVER_REACHED_ENGINE}  `), 'whitespace is not meaning').toBe(true);
    expect(retryAsPrompt('Interject failed: session not found: ses_9')).toBe(false);
    expect(retryAsPrompt('Interject failed: Internal error')).toBe(false);
    expect(retryAsPrompt('The model returned an error'), 'an ordinary turn error').toBe(false);
    expect(retryAsPrompt('')).toBe(false);
  });

  // A MIRROR, and the house rule for one: a test that reads BOTH files. The
  // webview cannot import a runtime value from src/ (tsconfig.webview rootDir),
  // so the sentence is declared twice — and a reword on the host side that did
  // not follow here would silently turn every raced line back into a lost one.
  it('matches the sentence turnMessages.ts actually posts', () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const host = readFileSync(path.join(pkgRoot, 'src/dashboard/turnMessages.ts'), 'utf8');
    expect(host).toContain(`failed('${NEVER_REACHED_ENGINE}')`);
  });
});

// The plan-mode Revise path was AUDITED before the queue was removed, because
// the two shared one flush: `pendingSend` (Revise) and `queuedMessage` (the
// composer). They were never the same field — ChatPane's
// handlePermissionChoiceForSession writes `pendingSend` from PermissionBar's
// `reviseText` slot, and nothing else ever wrote it — so Revise survives the
// queue untouched, and what follows is its coverage, unchanged in substance.
//
// It stays at UNIT level deliberately. A pane-level version would have to post a
// `requestPermission` carrying both an `allow_always` option (or the webview
// routes it to the QuestionModal, which has no Revise handling at all) and an
// option named "Revise" — and no engine ask produces that combination:
// acp/permission.ts's tool asks are Allow once / Always allow / Reject, while
// plan_exit (tool/plan.ts) is a `question.ask` with no allow_always. Writing
// that fixture would be inventing the external system rather than deriving from
// it, which is exactly how the browser tool once passed 38/38 while being unable
// to work. FLAGGED for the owner instead: PermissionBar's Revise branch may have
// no live producer, which is a pre-existing question, not this change's.
describe('queuedFlush — the plan-mode Revise path, which the composer never owned', () => {
  it('sends the revision at the turn boundary, cleared BEFORE the send is armed', async () => {
    const s = { pendingSend: 'revise the plan' as string | undefined };
    const send = vi.fn();

    flushQueuedSend(s, send);

    expect(s.pendingSend, 'cleared synchronously — a second turnDone must find nothing').toBeUndefined();
    expect(send, 'deferred past the rest of turnDone').not.toHaveBeenCalled();
    await settle();
    expect(send).toHaveBeenCalledWith(s, 'revise the plan');
  });

  it('does nothing when no revision is waiting', async () => {
    const send = vi.fn();
    flushQueuedSend({}, send);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('a second flush sends nothing — the clear is what makes it idempotent', async () => {
    const s = { pendingSend: 'revise the plan' as string | undefined };
    const send = vi.fn();

    flushQueuedSend(s, send);
    flushQueuedSend(s, send);
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
  });
});
