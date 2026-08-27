// The collab stream's LIVE PILL. A collab turn runs for minutes with nothing
// on screen; before this the room read as dead while four agents worked.
//
// The bugs worth catching are the dishonest ones. A pill for an agent that is
// NOT running says work is happening that is not. A blank pill on an engine
// that sends no `liveActivity` says the agent has nothing to say, when the
// truth is the engine never told us. A pill that survives its own finished
// message says the turn is still going after it ended.
//
// Everything here drives the component the way the poll does: statuses in,
// rendering out. There is no local timer to fake.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import CollabStream from './CollabStream.svelte';
import { livePills } from './collabActivity';

const msg = (seq: number, authorId: string, text: string, over: Record<string, unknown> = {}) => ({
  seq, authorId, authorKind: authorId === 'user' ? 'human' : 'agent', text,
  createdAt: '2026-08-05T10:00:00.000Z', ...over,
});
const NAMES = { 'collab-crane': 'Crane - the builder', 'collab-heron': 'Heron - the planner' };

const mount = (props: Record<string, unknown> = {}) =>
  render(CollabStream, { messages: [], loaded: true, names: NAMES, glyphs: {}, ...props });

const pills = (c: Element) => Array.from(c.querySelectorAll('.cs-pill'));
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

afterEach(() => cleanup());

describe('CollabStream — a running agent gets a pill', () => {
  it('draws one pill per RUNNING agent, and none for queued or idle ones', () => {
    const { container } = mount({
      agents: [
        { slug: 'collab-crane', state: 'running' },
        { slug: 'collab-heron', state: 'queued' },
        { slug: 'collab-fox', state: 'idle' },
      ],
    });
    expect(pills(container)).toHaveLength(1);
    expect(flat(pills(container)[0]!.textContent)).toContain('Crane');
  });

  it('draws a pill for EVERY agent running at once, each with its own line', () => {
    // W5: a room may dispatch several turns in parallel, so "running" stops
    // being a property of one agent at a time. A surface that reported the
    // single running worker would hide the rest of the room while they worked —
    // the exact lie the pill exists to remove, just at a new width.
    const { container } = mount({
      agents: [
        { slug: 'collab-crane', state: 'running', liveActivity: { kind: 'tool', text: 'read src/parser.ts' } },
        { slug: 'collab-heron', state: 'running', liveActivity: { kind: 'thought', text: 'weighing the schema' } },
      ],
    });
    const shown = pills(container).map((p) => flat(p.textContent));
    expect(shown).toHaveLength(2);
    expect(shown.some((t) => t.includes('Crane') && t.includes('read src/parser.ts'))).toBe(true);
    expect(shown.some((t) => t.includes('Heron') && t.includes('weighing the schema'))).toBe(true);
  });

  it('shows the live activity text when the engine sent one', () => {
    const { container } = mount({
      agents: [{
        slug: 'collab-crane',
        state: 'running',
        liveActivity: { kind: 'thought', text: 'weighing two parser designs' },
      }],
    });
    expect(flat(pills(container)[0]!.textContent)).toContain('weighing two parser designs');
  });

  it('a TOOL activity renders as a tool line, not as prose', () => {
    const { container } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'tool', text: 'read src/parser.ts' } }],
    });
    const label = pills(container)[0]!.querySelector('.thought-label')!;
    expect(label.textContent).toContain('read src/parser.ts');
    expect(label.classList.contains('mono')).toBe(true);
  });

  it('a THOUGHT activity is NOT marked as a tool line', () => {
    const { container } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'thought', text: 'hmm' } }],
    });
    expect(pills(container)[0]!.querySelector('.thought-label')!.classList.contains('mono')).toBe(false);
  });
});

describe('CollabStream — an engine that sends no liveActivity still reads honestly', () => {
  it('says only "thinking…" rather than inventing a line or drawing a blank pill', () => {
    const { container } = mount({ agents: [{ slug: 'collab-crane', state: 'running' }] });
    const text = flat(pills(container)[0]!.textContent);
    expect(text).toContain('thinking');
    // The body must not claim the agent reported something.
    expect(text).toContain('Nothing reported yet');
  });

  it('a malformed activity (unknown kind, non-string text) degrades to "thinking…"', () => {
    const { container } = mount({
      agents: [
        { slug: 'collab-crane', state: 'running', liveActivity: { kind: 'wat', text: 'x' } },
        { slug: 'collab-heron', state: 'running', liveActivity: { kind: 'tool', text: 42 } },
      ],
    });
    expect(pills(container)).toHaveLength(2);
    for (const p of pills(container)) expect(flat(p.textContent)).toContain('thinking');
  });

  it('bounds an over-long activity rather than flooding the row', () => {
    const long = 'x'.repeat(500);
    const { container } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'thought', text: long } }],
    });
    const label = pills(container)[0]!.querySelector('.thought-label')!.textContent ?? '';
    expect(label.length).toBe(200);
  });
});

describe('CollabStream — the pill clears with the turn', () => {
  it('is gone once the finished message lands and the agent is idle again', async () => {
    const { container, rerender } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'thought', text: 'drafting' } }],
    });
    expect(pills(container)).toHaveLength(1);

    // The SAME snapshot that carries the finished message carries the status.
    await rerender({
      messages: [msg(1, 'collab-crane', 'Done — the parser is in.')],
      loaded: true,
      names: NAMES,
      glyphs: {},
      agents: [{ slug: 'collab-crane', state: 'idle' }],
    });
    expect(pills(container)).toHaveLength(0);
    expect(flat(container.textContent)).toContain('Done — the parser is in.');
  });

  it('absent statuses (a build that threads none through) draw no pill at all', () => {
    const { container } = mount({ messages: [msg(1, 'collab-crane', 'hello')] });
    expect(pills(container)).toHaveLength(0);
  });
});

// The rules themselves live in collabActivity.ts, so the input classes a
// rendered test cannot reach comfortably are pinned directly against the leaf.
describe('collabActivity — the shapes a wire can actually arrive in', () => {
  it('a missing or non-array statuses field yields no pills, never a throw', () => {
    expect(livePills(undefined)).toEqual([]);
    expect(livePills(null as never)).toEqual([]);
    expect(livePills({} as never)).toEqual([]);
  });

  it('a status with no slug is dropped — an unnamed pill can name nobody', () => {
    expect(livePills([{ state: 'running' }, { slug: '', state: 'running' }])).toEqual([]);
  });

  // `thought` joined the pill in M4.2 and is ALWAYS present, '' when the engine
  // sent none — the same shape rule `kind` and `text` already follow, so a
  // consumer never has to tell "absent" from "empty" on the same field.
  it('a null liveActivity is the same as an absent one', () => {
    expect(livePills([{ slug: 'a', state: 'running', liveActivity: null }]))
      .toEqual([{ slug: 'a', kind: '', text: '', thought: '' }]);
  });

  it('an activity with a valid kind but empty text falls back to no kind', () => {
    // A `tool` pill with nothing to show would look like it says more than
    // "thinking…" while saying less.
    expect(livePills([{ slug: 'a', state: 'running', liveActivity: { kind: 'tool', text: '' } }]))
      .toEqual([{ slug: 'a', kind: '', text: '', thought: '' }]);
  });

  it('an unknown state (a newer engine) is not treated as running', () => {
    expect(livePills([{ slug: 'a', state: 'paused' }])).toEqual([]);
  });
});

describe('CollabStream — the pill is expandable, like the chat thought it shares', () => {
  it('renders COLLAPSED, with the full text available behind the summary', () => {
    const { container } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'tool', text: 'grep -n parse src/' } }],
    });
    const details = pills(container)[0]!.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')).not.toBeNull();
    expect(details.querySelector('.thought-text')!.textContent).toBe('grep -n parse src/');
  });

  it('a pill for an agent that has not spoken yet still renders — that is the point', () => {
    const { container } = mount({ messages: [], agents: [{ slug: 'collab-heron', state: 'running' }] });
    expect(pills(container)).toHaveLength(1);
    expect(flat(pills(container)[0]!.textContent)).toContain('Heron');
  });
});

// -- W2 (report 1.11 / F10): the stream follows the stream ------------------
//
// The rule is chatScroll.ts's and its input classes are pinned against
// collabStreamFollow.ts. What is pinned HERE is only that the component is
// actually WIRED to it: bound to the right scroller, told when the transcript
// grew, and listening for the two events that disarm it. A leaf that works and
// a component that never calls it is the failure this suite exists for.
describe('CollabStream - the transcript follows the live stream', () => {
  const scroller = (c: Element): HTMLDivElement => {
    const el = c.querySelector('.stream') as HTMLDivElement;
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    el.scrollTop = 600;
    return el;
  };
  const grow = (el: HTMLDivElement, h: number) =>
    Object.defineProperty(el, 'scrollHeight', { value: h, configurable: true });
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
  const base = { loaded: true, names: NAMES, glyphs: {} };

  it('scrolls to the bottom when a message lands', async () => {
    const { container, rerender } = mount({ messages: [msg(1, 'collab-crane', 'one')] });
    const el = scroller(container);
    await nextFrame();

    grow(el, 1400);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'collab-crane', 'two')] });
    await nextFrame();
    expect(el.scrollTop).toBe(1400);
  });

  it('holds position once the user has scrolled up to read', async () => {
    const { container, rerender } = mount({ messages: [msg(1, 'collab-crane', 'one')] });
    const el = scroller(container);
    await nextFrame();

    el.scrollTop = 100;
    await fireEvent.scroll(el);

    grow(el, 1400);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'collab-crane', 'two')] });
    await nextFrame();
    expect(el.scrollTop).toBe(100);
  });

  // The wheel is the ONLY thing holding this one, on purpose. The scroller has
  // not MOVED yet — the browser queues `scroll` to the next rendering
  // opportunity, and the queued follow snaps it back before the event ever
  // fires — so the position still says "at the bottom" and the anchor still
  // says "untouched". The wheel is the earliest evidence the user turned away.
  it('an upward wheel disarms the follow before the scroller has moved at all', async () => {
    const { container, rerender } = mount({ messages: [msg(1, 'collab-crane', 'one')] });
    const el = scroller(container);
    await nextFrame();
    expect(el.scrollTop).toBe(1000); // the follow parked it at the bottom

    await fireEvent.wheel(el, { deltaY: -20 });
    grow(el, 1400);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'collab-crane', 'two')] });
    await nextFrame();
    expect(el.scrollTop).toBe(1000);
  });

  // The pill is the ONE live signal a room has, and it draws below the last
  // message - a follow that only tracked messages would leave it under the fold
  // for the whole minute an agent is working.
  //
  // The SAME array instance goes back in, deliberately. NOTE, honestly: that is
  // not enough to isolate the pill dependency here — `rerender` re-assigns every
  // prop, so the effect re-runs whatever it reads, and dropping `pills` from it
  // still passes this test. In the product only `agents` moves on a poll that
  // carried no new message, which is why the effect reads the pills; this test
  // is the regression net for the OUTCOME, not proof of the mechanism.
  it('follows a pill that appears with no new message behind it', async () => {
    const msgs = [msg(1, 'collab-crane', 'one')];
    const { container, rerender } = mount({ messages: msgs });
    const el = scroller(container);
    await nextFrame();

    grow(el, 1400);
    await rerender({ ...base, messages: msgs, agents: [{ slug: 'collab-crane', state: 'running' }] });
    await nextFrame();
    expect(el.scrollTop).toBe(1400);
  });

  // The other half of the stick: coming back must turn it on again, or one
  // stray wheel would kill the follow for the rest of the room's life.
  it('re-arms when the user scrolls back down to a genuine bottom', async () => {
    const { container, rerender } = mount({ messages: [msg(1, 'collab-crane', 'one')] });
    const el = scroller(container);
    await nextFrame();

    await fireEvent.wheel(el, { deltaY: -20 });
    grow(el, 1400);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'collab-crane', 'two')] });
    await nextFrame();
    expect(el.scrollTop).toBe(1000);

    el.scrollTop = 1000; // 1400 - 400 - 1000 = 0 from the bottom
    await fireEvent.scroll(el);
    grow(el, 1800);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'collab-crane', 'two'), msg(3, 'collab-crane', 'three')] });
    await nextFrame();
    expect(el.scrollTop).toBe(1800);
  });

  it('the user OWN message re-arms the follow, wherever they were reading', async () => {
    const { container, rerender } = mount({ messages: [msg(1, 'collab-crane', 'one')] });
    const el = scroller(container);
    await nextFrame();

    el.scrollTop = 100;
    await fireEvent.scroll(el);

    grow(el, 1400);
    await rerender({ ...base, messages: [msg(1, 'collab-crane', 'one'), msg(2, 'user', 'carry on')] });
    await nextFrame();
    expect(el.scrollTop).toBe(1400);
  });
});

// -- W2 (report 2.3): the A -> B flow rail -----------------------------------
describe('CollabStream - who is waiting on whom', () => {
  it('an ask reads as a direction, not just a verb', () => {
    const { container } = mount({
      messages: [msg(1, 'collab-crane', 'can you plan this?', { kind: 'ask', mentions: ['collab-heron'] })],
    });
    expect(flat(container.textContent)).toContain('Crane → Heron · asked');
  });

  it('a finished task points at the board it is now waiting on', () => {
    const { container } = mount({
      messages: [msg(1, 'collab-crane', 'store.ts written', { kind: 'task_done' })],
    });
    expect(flat(container.textContent)).toContain('Crane → board · finished a task');
  });

  it('a human ask reads as You -> the agent, not as a slug', () => {
    const { container } = mount({
      messages: [msg(1, 'user', 'what next?', { kind: 'ask', mentions: ['collab-heron'] })],
    });
    expect(flat(container.textContent)).toContain('You → Heron · asked');
  });

  it('a standing line says what the room is blocked on while an ask is open', () => {
    const { container } = mount({
      messages: [msg(1, 'collab-crane', 'can you plan this?', { kind: 'ask', mentions: ['collab-heron'] })],
    });
    const waiting = container.querySelector('.cs-waiting');
    expect(waiting).not.toBeNull();
    expect(flat(waiting!.textContent)).toContain('Heron');
    expect(flat(waiting!.textContent)).toContain('Crane');
  });

  it('the line goes the moment the target answers - nothing is left claiming a wait', async () => {
    const ask = msg(1, 'collab-crane', 'can you plan this?', { kind: 'ask', mentions: ['collab-heron'] });
    const { container, rerender } = mount({ messages: [ask] });
    expect(container.querySelector('.cs-waiting')).not.toBeNull();

    await rerender({
      loaded: true, names: NAMES, glyphs: {},
      messages: [ask, msg(2, 'collab-heron', 'here is the plan', { kind: 'answer' })],
    });
    expect(container.querySelector('.cs-waiting')).toBeNull();
  });

  it('an ordinary room shows no waiting line at all', () => {
    const { container } = mount({ messages: [msg(1, 'collab-crane', 'hello')] });
    expect(container.querySelector('.cs-waiting')).toBeNull();
  });
});

// -- W2 (report 1.12 / F11): the reasoning block is OPEN while the turn runs --
//
// This REVERSES the M4.2 default above deliberately. Collapsed-while-streaming
// was chosen so the transcript would not jump as the text grew - but the stream
// now follows itself (1.11), so the jump it was avoiding is the follow doing its
// job, and the cost was a room that showed a ring and one line while four agents
// worked. ThoughtPill already took `live` and never set `open`.
describe('CollabStream - a live turn shows its reasoning', () => {
  it('opens the block while the agent is running and the engine sent a thought', () => {
    const { container } = mount({
      agents: [{
        slug: 'collab-crane', state: 'running',
        liveActivity: { kind: 'thought', text: 'weighing two designs' },
        liveThought: 'First the parser, then the printer. The printer is the risk.',
      }],
    });
    const details = pills(container)[0]!.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details.querySelector('.thought-text')!.textContent).toContain('The printer is the risk');
  });

  // Nothing to read is not worth opening: the body would be the "nothing
  // reported yet" placeholder, which says less than the summary already does.
  it('stays shut when the engine sent no reasoning to show', () => {
    const { container } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveActivity: { kind: 'tool', text: 'read src/parser.ts' } }],
    });
    const details = pills(container)[0]!.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.open).toBe(false);
  });

  it('the block goes with the turn - an idle agent leaves no open reasoning behind', async () => {
    const { container, rerender } = mount({
      agents: [{ slug: 'collab-crane', state: 'running', liveThought: 'still going' }],
    });
    expect((pills(container)[0]!.querySelector('details.thought-block') as HTMLDetailsElement).open).toBe(true);

    await rerender({
      messages: [msg(1, 'collab-crane', 'done')], loaded: true, names: NAMES, glyphs: {},
      agents: [{ slug: 'collab-crane', state: 'idle' }],
    });
    expect(container.querySelector('details.thought-block')).toBeNull();
  });
});

// W3 wave 3 (F13) — A FAILED AGENT IS VISIBLE WITHOUT CLICKING A 14px BADGE.
//
// A failed turn appends NOTHING to the stream, and deliberately so: "a stack
// trace in the log would be a message every other agent then reads and reacts
// to" (collab/runner.ts's drain). So the failure has to reach the room WITHOUT
// entering the transcript the agents read — which is what this row is.
describe('CollabStream — the failure row (F13)', () => {
  const failed = [
    { slug: 'collab-crane', state: 'idle', lastError: '@collab-crane has no model — pick one in its agent definition' },
    { slug: 'collab-heron', state: 'idle' },
  ];

  it('says the failure out loud, under the agent name', () => {
    const { container } = mount({ agents: failed });
    const row = container.querySelector('.cs-failure')!;
    expect(flat(row.textContent)).toContain('Crane');
    expect(flat(row.textContent)).toContain('has no model');
  });

  // Wave 2's needs-a-model reason is the whole point of the path: an unpinned
  // agent's turn now fails clean with a named next action, and until this row
  // existed that action was behind a click on a badge.
  it('carries the pick-a-model text into the room', () => {
    const { container } = mount({ agents: failed });
    expect(flat(container.textContent)).toContain('pick one in its agent definition');
  });

  it('draws nothing at all for a room where nothing has failed', () => {
    const { container } = mount({ agents: [{ slug: 'collab-crane', state: 'running' }] });
    expect(container.querySelector('.cs-failure')).toBeNull();
  });

  it('draws one row per failed agent, never one for the room', () => {
    const { container } = mount({ agents: [
      { slug: 'collab-crane', state: 'idle', lastError: 'a' },
      { slug: 'collab-heron', state: 'idle', lastError: 'b' },
    ] });
    expect(container.querySelectorAll('.cs-failure')).toHaveLength(2);
  });

  // The failure is NOT in the messages array, so it must survive an empty one —
  // an agent can fail its very first turn, before the room has a transcript.
  it('is drawn even when nothing has been said yet', () => {
    const { container } = mount({ messages: [], agents: failed });
    expect(container.querySelector('.cs-failure')).not.toBeNull();
  });
});

// W3 wave 3 (report 2.4) — APPROVE/REJECT WHERE THE WORK LANDS. The flow rail
// already reads `A → board · finished a task`; until now the human could only
// act on it by opening the drawer. `collab_review` is the verdict wire.
describe('CollabStream — a verdict on a finished task', () => {
  const doneRow = msg(4, 'collab-crane', 'built the migration', { kind: 'task_done', taskId: 'clbt_1' });
  const board = [{ id: 'clbt_1', state: 'done' }];

  const mountReview = (over: Record<string, unknown> = {}) => {
    const reviews: Array<{ taskId: string; verdict: string; note?: string }> = [];
    const r = mount({
      messages: [doneRow], tasks: board, archived: false,
      onReview: (taskId: string, verdict: string, note?: string) => reviews.push({ taskId, verdict, note }),
      ...over,
    });
    return { ...r, reviews };
  };

  it('offers Approve and Send back on a task still awaiting a verdict', () => {
    const { getByRole } = mountReview();
    expect(getByRole('button', { name: /Approve/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /Send back/i })).toBeInTheDocument();
  });

  it('approves the task the row names', async () => {
    const { getByRole, reviews } = mountReview();
    await fireEvent.click(getByRole('button', { name: /Approve/i }));
    expect(reviews).toEqual([{ taskId: 'clbt_1', verdict: 'approve', note: undefined }]);
  });

  // The engine REFUSES a reject with no reason, and the row the owner is woken
  // by has to carry it — so the reason is asked for BEFORE the call, exactly as
  // the task board's own reopen already does.
  it('asks for a reason before it sends a task back, and carries it', async () => {
    const { getByRole, getByLabelText, reviews } = mountReview();
    await fireEvent.click(getByRole('button', { name: /Send back/i }));
    await fireEvent.input(getByLabelText(/Why is it going back/i), { target: { value: 'the index is missing' } });
    await fireEvent.click(getByRole('button', { name: /^Reject$/i }));
    expect(reviews).toEqual([{ taskId: 'clbt_1', verdict: 'reject', note: 'the index is missing' }]);
  });

  it('will not send a task back with a blank reason', async () => {
    const { getByRole, getByLabelText, reviews } = mountReview();
    await fireEvent.click(getByRole('button', { name: /Send back/i }));
    await fireEvent.input(getByLabelText(/Why is it going back/i), { target: { value: '  ' } });
    await fireEvent.click(getByRole('button', { name: /^Reject$/i }));
    expect(reviews).toEqual([]);
  });

  // The board moves on; the row does not. A task accepted an hour ago still has
  // its task_done row in the transcript, and `collab_review` refuses it.
  it('offers no verdict once the task has been accepted', () => {
    const { queryByRole } = mountReview({ tasks: [{ id: 'clbt_1', state: 'accepted' }] });
    expect(queryByRole('button', { name: /Approve/i })).toBeNull();
  });

  it('offers no verdict on an archived room, or on an engine with no board', () => {
    const { queryByRole } = mountReview({ archived: true });
    expect(queryByRole('button', { name: /Approve/i })).toBeNull();
    cleanup();
    const noBoard = mountReview({ tasks: undefined });
    expect(noBoard.queryByRole('button', { name: /Approve/i })).toBeNull();
  });

  // A REJECT is what makes the room row true: the engine reopens the task and
  // writes the note into the `task_reopen` row every agent then reads. The
  // stream must render that row as the room's own record of the correction.
  it('renders the reopened row WITH the note once the engine has answered', () => {
    cleanup();
    const { container } = mount({
      messages: [
        doneRow,
        msg(5, 'user', 'reopened task: built the migration — the index is missing', { kind: 'task_reopen', taskId: 'clbt_1' }),
      ],
      tasks: [{ id: 'clbt_1', state: 'claimed' }],
      archived: false,
      onReview: () => {},
    });
    expect(flat(container.textContent)).toContain('the index is missing');
    // ...and the verdict controls are gone, because the task is no longer done.
    expect(container.querySelector('.cr-verdict')).toBeNull();
  });
});
