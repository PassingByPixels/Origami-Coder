// Where an interjection lands in the transcript, and what it does to the
// assistant bubble that was streaming when it landed.
//
// Owner-reproduced on 0.4.22: interject worked end to end, but — his words —
// "the stream pushes the chat posts lower which doesnt make sense". The row was
// appended at the CLICK while the deltas kept flowing into the bubble opened
// BEFORE it, so everything the model wrote AFTER being interrupted rendered
// ABOVE the interruption, and the user's own line drifted down the screen as
// the bubble above it grew. The transcript claimed the opposite of what
// happened.
//
// The only honest shape is [what it said before] · [what the user said] · [what
// it said after]. TWO rules produce it, in two places, and both are asserted
// here because either one alone leaves half the defect:
//
//   - addMessage seals the open agent stream on ANY user row. Not an interject
//     rule — the same rule `toolCall` already applies — which is precisely why
//     a REPLAYED interjection splits the same way, and why live and reloaded
//     transcripts can agree at all (the parity test at the bottom).
//   - interjectSplit.ts holds the row until the host answers, so the split is
//     made where the turn actually TOOK the line, never on an optimistic click
//     that the engine may reject.

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import { armInterject, drainInterject, resolveInterject } from '../panes/interjectSplit';

const ASK = 'do the thing';
const LINE = 'stop, use the other file';
const BEFORE = 'reading the old file';
const AFTER = 'switching to the other file';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
/** Let turnDone's deferred flush (`setTimeout(…, 0)`) actually run. */
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await tick(); };

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener, so a mount from an earlier test
// still answers every posted message — a fresh session id per mount is what
// keeps each assertion about the pane under test (composerEnter.test.ts's rule).
let seq = 0;

/** Every transcript row in document order: what kind it is, and what it says. */
function shape(c: HTMLElement): { kind: string; text: string }[] {
  return [...c.querySelectorAll('.cell-messages .row')].map((el) => ({
    kind: [...el.classList].find((k) => k !== 'row') ?? '',
    text: el.textContent ?? '',
  }));
}

/** A chat with a real turn running, started the way the user starts one. */
async function mountTurn(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `ij-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  post({ type: 'modelStatus', sessionId: sid, ok: true, modelName: 'deepseek' });
  await tick();
  await fireEvent.input(container.querySelector('.input') as HTMLTextAreaElement, { target: { value: ASK } });
  await fireEvent.click(container.querySelector('.btn.send') as HTMLButtonElement);
  await tick();
  return { c: container as HTMLElement, sid };
}

/** Type a line during the turn and press Enter — which IS the interjection now
 *  (composerEnter.test.ts owns that rule; this file owns where the row lands). */
async function interject(c: HTMLElement, text = LINE) {
  const box = c.querySelector('.input') as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: text } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  await tick();
}

describe('an interjection splits the turn it interrupts', () => {
  it('reads in the order it happened: agent, then the user, then the agent again', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();

    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    await tick();

    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    post({ type: 'agentText', sessionId: sid, text: ' now', messageId: 'm2' });
    await tick();

    const rows = shape(c);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(rows[0].text).toContain(ASK);
    expect(rows[1].text).toContain(BEFORE);
    expect(rows[2].text).toContain(LINE);
    expect(rows[3].text).toContain(`${AFTER} now`);
  });

  it('nothing streamed after the interjection reaches the bubble above it', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    await tick();
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    await tick();

    const [, first] = shape(c);
    // THE defect, stated as an assertion: post-interjection prose appended back
    // into the pre-interjection bubble and therefore rendered ABOVE the user.
    expect(first.text, 'the sealed half must not absorb what came after the split').not.toContain(AFTER);
    expect(first.text).toContain(BEFORE);
  });

  it('a thinking burst after the split opens below the user row too, not above it', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentThought', sessionId: sid, text: 'weighing the options' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    await tick();
    post({ type: 'agentThought', sessionId: sid, text: 're-planning' });
    await tick();

    const thoughts = [...c.querySelectorAll('.cell-messages .thought-pill, .cell-messages details')];
    const texts = thoughts.map((t) => t.textContent ?? '');
    expect(texts.some((t) => t.includes('weighing the options') && t.includes('re-planning')),
      'the open reasoning stream must be sealed by the user row as well').toBe(false);
  });

  it('is ONE transcript row, with the sticky mirror above it — not two rows', async () => {
    // The blue "You: …" bar in the bug report is PinnedUserMessage.svelte, the
    // deliberate sticky mirror of the most recent user message (pinnedUser.ts).
    // It is display-only and every user message gets one; after the split it
    // correctly mirrors the interjection, because that is now the newest user
    // message with output scrolling under it. Nothing leaks the engine's
    // synthetic envelope into it.
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    await tick();
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    await tick();

    expect(shape(c).filter((r) => r.kind === 'user' && r.text.includes(LINE)).length,
      'one representation of the interjection in the transcript').toBe(1);
    const pins = [...c.querySelectorAll('.cell-messages .pinned-user')];
    expect(pins.length).toBe(1);
    expect(pins[0].textContent).toContain(LINE);
    expect(pins[0].textContent, 'the interject envelope is the model\'s, never the user\'s').not.toContain('while you were working');
  });
});

describe('the row waits for the engine to take the line', () => {
  it('the click posts the interjection but draws no row — the chip is the placeholder', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();

    await interject(c);

    expect(posted()).toContainEqual({ type: 'interject', sessionId: sid, text: LINE });
    expect(shape(c).filter((r) => r.kind === 'user').length,
      'only the turn-opening send — the engine has not taken this one yet').toBe(1);
    expect(c.querySelector('.interjecting-chip')).not.toBeNull();

    post({ type: 'interjected', sessionId: sid });
    await tick();
    expect(shape(c).filter((r) => r.kind === 'user').length).toBe(2);
    expect(c.querySelector('.interjecting-chip'), 'and the chip is released by the same message').toBeNull();
  });

  it('a REJECTED interjection keeps the words and annotates them — no empty bubble', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);

    // An ENGINE-side refusal. The host's own pre-wire refusal reads the same on
    // the wire but means something different — the engine never saw the text —
    // and takes the retry path instead (interjectRetry.ts, composerEnter.test.ts).
    // Here the line may well have been taken, so the row stands and is annotated.
    post({ type: 'error', sessionId: sid, message: 'Interject failed: session not found: ses_9' });
    await tick();

    const rows = shape(c);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent', 'user', 'error']);
    expect(rows[2].text, 'the line the user typed is not thrown away').toContain(LINE);
    expect(rows[3].text, 'and the row right under it says it never landed').toContain('Interject failed');
    expect(rows.filter((r) => r.kind === 'agent').every((r) => r.text.trim().length > 0),
      'a split that opened an empty assistant bubble would be worse than the bug').toBe(true);
    expect(c.querySelector('.interjecting-chip')).toBeNull();
  });

  it('a turn that ends before the answer comes back still shows what was typed', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    const rows = shape(c);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent', 'user']);
    expect(rows[2].text).toContain(LINE);
    // (the turn-opening send is in `posted()` too — this is about the LINE.)
    expect(posted().filter((m) => m.type === 'send' && m.text === LINE),
      'the engine most likely took it — re-sending it as a fresh turn is the double-send').toEqual([]);
  });
});

describe('turn bookkeeping survives the split', () => {
  it('mid-turn the sealed half offers no Rewind — nothing is rewindable while a turn runs', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    await tick();

    expect(c.querySelectorAll('.rewind-btn').length).toBe(0);
    expect(c.querySelector('.stream-indicator'), 'the turn is still running').not.toBeNull();
  });

  it('turnDone clears the turn and stamps the spend on the LAST half, not the first', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    post({ type: 'contextUpdate', sessionId: sid, tokensUsed: 2048 });
    await tick();

    post({ type: 'turnDone', sessionId: sid });
    await settle();

    expect(c.querySelector('.stream-indicator'), 'inFlight cleared').toBeNull();
    expect(c.querySelector('.interjecting-chip'), 'interjecting cleared').toBeNull();
    const agents = [...c.querySelectorAll('.cell-messages .row.agent')];
    expect(agents.length).toBe(2);
    // The stamp walks back to the turn's final agent row and stops at the first
    // user row above it — a row added ahead of that walk would hide it.
    expect(agents[1].querySelector('.spend-badge, .token-badge')).not.toBeNull();
    expect(agents[0].querySelector('.spend-badge, .token-badge')).toBeNull();
  });

  it('rewinding the second half cuts back to the interjection that opened it', async () => {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    await tick();
    post({ type: 'turnDone', sessionId: sid });
    await settle();

    const buttons = [...c.querySelectorAll('.rewind-btn')] as HTMLButtonElement[];
    expect(buttons.length, 'both halves are rewindable once the turn is over').toBe(2);

    await fireEvent.click(buttons[1]);
    await tick();

    expect(posted()).toContainEqual({ type: 'revertToMessage', messageId: 'm2', sessionId: sid });
    // The engine's revert resolves to the last USER message (rewindSlice.ts) —
    // which for the second half IS the interjection, so the first half stays.
    const rows = shape(c);
    expect(rows.map((r) => r.kind)).toEqual(['user', 'agent']);
    expect(rows[1].text).toContain(BEFORE);
  });
});

describe('replay parity — a reloaded chat shows the same transcript as the live one', () => {
  // On `session/load` the engine re-emits the interjected turn as it stored it:
  // assistant text, the user's message (its synthetic ENVELOPE part dropped by
  // the audience filter — acpClient.test.ts), assistant text. That path never
  // touches interjectSplit.ts, so the two can only agree if the SEAL lives on
  // the user row itself. This test is what says they do.
  async function replayed(): Promise<{ kind: string; text: string }[]> {
    const sid = `ij-replay-${++seq}`;
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
    await tick();
    post({ type: 'echoUser', sessionId: sid, text: ASK, replay: true });
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    post({ type: 'echoUser', sessionId: sid, text: LINE, replay: true });
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    await tick();
    return shape(container as HTMLElement);
  }

  async function live(): Promise<{ kind: string; text: string }[]> {
    const { c, sid } = await mountTurn();
    post({ type: 'agentText', sessionId: sid, text: BEFORE, messageId: 'm1' });
    await tick();
    await interject(c);
    post({ type: 'interjected', sessionId: sid });
    await tick();
    post({ type: 'agentText', sessionId: sid, text: AFTER, messageId: 'm2' });
    post({ type: 'turnDone', sessionId: sid });
    await settle();
    return shape(c);
  }

  /**
   * A row's text with the RENDERED CLOCK normalised to a marker.
   *
   * The two halves are mounted one after the other, so they read `Date.now()`
   * a few hundred milliseconds apart — and whenever that gap straddles a second
   * boundary the live half rendered `12:05:26` and the replayed half `12:05:27`
   * and this failed on the clock rather than on parity. It was always a race;
   * it only became a frequent one when the suite grew and the first half took
   * longer. A MARKER, not a deletion: a row that carries no time at all still
   * differs from one that does, which is a parity fact worth keeping.
   */
  const words = (text: string) => text.replace(/\d{1,2}:\d{2}:\d{2}/g, '<time>').replace(/\s+/g, ' ').trim();

  it('same rows, same order, same words', async () => {
    const liveShape = (await live()).map((r) => ({ kind: r.kind, text: words(r.text) }));
    cleanup();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const replayShape = (await replayed()).map((r) => ({ kind: r.kind, text: words(r.text) }));

    // Agreement is the point, but two transcripts can agree by being wrong
    // together — so pin the shape they must agree ON as well. The first row is
    // spelled out so `words` cannot quietly become a no-op (nothing normalised,
    // the flake back) or over-strip (both sides equal because both are empty).
    expect(liveShape[0].text).toBe(`You <time> ${ASK}`);
    expect(liveShape.map((r) => r.kind)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(replayShape.map((r) => r.kind)).toEqual(liveShape.map((r) => r.kind));
    expect(replayShape.map((r) => r.text)).toEqual(liveShape.map((r) => r.text));
  });
});

describe('interjectSplit — one interjection, one row', () => {
  type Target = { interjecting?: boolean; pendingInterject?: string[] };

  it('holds the line from the keypress until an answer, then hands it over once', () => {
    const s: Target = {};

    armInterject(s, LINE);
    expect(s.interjecting).toBe(true);
    expect(s.pendingInterject).toEqual([LINE]);

    expect(resolveInterject(s)).toBe(LINE);
    expect(s.interjecting).toBe(false);
    // `interjected` and a `turnDone` behind it both resolve; the second must
    // find nothing, or the same words go on screen twice.
    expect(resolveInterject(s)).toBeNull();
  });

  it('resolving with nothing outstanding still releases the chip', () => {
    const s: Target = { interjecting: true };
    expect(resolveInterject(s)).toBeNull();
    expect(s.interjecting).toBe(false);
  });

  // Enter delivers on the keypress, so a fast typist can have several lines with
  // the host at once. A single slot would let the second overwrite the first and
  // the first would never get a row at all — these three say it cannot.
  it('is a FIFO: the OLDEST line answers first, and the chip stays up until the last', () => {
    const s: Target = {};
    armInterject(s, 'first');
    armInterject(s, 'second');
    expect(s.pendingInterject).toEqual(['first', 'second']);

    expect(resolveInterject(s)).toBe('first');
    expect(s.interjecting, 'one is still with the host').toBe(true);
    expect(resolveInterject(s)).toBe('second');
    expect(s.interjecting).toBe(false);
    expect(resolveInterject(s)).toBeNull();
  });

  it('drains the rest in order for a turn that just ENDS — no answer is coming', () => {
    const s: Target = {};
    armInterject(s, 'first');
    armInterject(s, 'second');
    armInterject(s, 'third');
    expect(resolveInterject(s)).toBe('first');

    expect(drainInterject(s)).toEqual(['second', 'third']);
    expect(s.interjecting).toBe(false);
    // A late host answer for one of the drained lines must draw nothing.
    expect(resolveInterject(s)).toBeNull();
    expect(drainInterject(s)).toEqual([]);
  });

  it('draining with nothing outstanding is empty, not undefined', () => {
    expect(drainInterject({})).toEqual([]);
  });
});
