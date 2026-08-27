// CollabPane — ONE collab's stream in its own editor tab. The pane owns three
// things nothing else can, so those are what is asserted here rather than "an
// element rendered":
//
//   1. The POLL. It is the pane's own loop, and its `sinceSeq` is the whole
//      reason a settled collab costs one near-empty round trip instead of the
//      full transcript every second. A poll that always asked from 0 would
//      still "work" and would be a silent regression.
//   2. FAN-OUT ISOLATION. The host's `post` reaches EVERY attached webview, so
//      two open collab tabs both receive both streams' replies. A pane that
//      forgot to filter on collabId would paint the other collab's messages
//      into this one.
//   3. The THREE cap values. null / 0 / N are not a spectrum — 0 means the loop
//      breaker is OFF (overnight mode) and `cap || default` would turn that
//      into "6" and quietly re-arm a breaker the user disabled.

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-1';

beforeEach(() => {
  (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__ = { id: ID, title: 'Storm plan' };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

function posts(): Array<Record<string, unknown>> {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
}

function polls(): Array<Record<string, unknown>> {
  return posts().filter((p) => p.type === 'collabPoll');
}

const msg = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  authorId: 'collab-crane',
  authorKind: 'agent',
  text: `message ${seq}`,
  createdAt: '2026-08-04T10:00:00.000Z',
  ...over,
});

function state(over: Record<string, unknown> = {}): unknown {
  return {
    type: 'collabStateData',
    collabId: ID,
    sinceSeq: 0,
    collab: { id: ID, title: 'Storm plan', createdAt: '2026-08-04T09:00:00.000Z', loopBreakerCap: null },
    participants: [
      { agentSlug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen' },
      { agentSlug: 'collab-heron', displayName: 'Heron', model: null },
    ],
    messages: [],
    agents: [{ slug: 'collab-crane', state: 'idle' }, { slug: 'collab-heron', state: 'idle' }],
    suspended: false,
    ...over,
  };
}

function bubbleTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.msg-text')).map((n) => n.textContent ?? '');
}
function ringStates(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.chip-ring')).map((r) => r.getAttribute('data-state'));
}
/** One entry per rendered HEADER — i.e. per speaker turn, not per message.
 *  M2's stream groups a run of consecutive same-author messages under one. */
function authorHeaders(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.cs-author')).map((n) => n.textContent ?? '');
}
function groupSizes(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.cs-group')).map((g) => g.querySelectorAll('.cs-msg').length);
}

describe('CollabPane — roster and stream', () => {
  it('renders one chip per participant with the name the engine gave it', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(Array.from(container.querySelectorAll('.chip-name')).map((n) => n.textContent)).toEqual(['Crane', 'Heron']);
  });

  it('renders the messages author-labelled, with the human visually distinct from an agent', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2, { authorId: 'user', authorKind: 'human', text: 'do the thing' })] }));

    expect(bubbleTexts(container)).toEqual(['message 1', 'do the thing']);
    const groups = container.querySelectorAll('.cs-group');
    expect(groups[0].className).not.toContain('human');
    expect(groups[1].className).toContain('human');
    // An agent's group is labelled with its ROSTER name, not its raw slug.
    expect(authorHeaders(container)).toEqual(['Crane', 'You']);
  });

  it('an agent message from a slug not in the roster still renders, labelled with its short name', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { authorId: 'collab-ghost' })] }));
    // No roster entry to mine a name from, so it falls back to the slug
    // itself (minus the collab- prefix, capitalised) — same rule as a
    // roster-known agent, just with nothing but the slug to work from.
    expect(authorHeaders(container)).toEqual(['Ghost']);
  });

  it('per-agent rings follow the engine state; idle draws no state of its own', async () => {
    const { container } = render(CollabPane);
    await post(state({ agents: [{ slug: 'collab-crane', state: 'running' }, { slug: 'collab-heron', state: 'queued' }] }));
    expect(ringStates(container)).toEqual(['running', 'queued']);

    await post(state({ sinceSeq: 0, agents: [{ slug: 'collab-crane', state: 'idle' }, { slug: 'collab-heron', state: 'idle' }] }));
    expect(ringStates(container)).toEqual(['idle', 'idle']);
  });

  it("an agent's lastError raises a badge whose text is reachable, and no badge appears without one", async () => {
    const { container } = render(CollabPane);
    await post(state({ agents: [{ slug: 'collab-crane', state: 'idle', lastError: 'model 502' }, { slug: 'collab-heron', state: 'idle' }] }));

    const badges = container.querySelectorAll('.chip-error');
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute('title')).toBe('model 502');
    // The text is also expandable in place, for anyone who cannot hover.
    await fireEvent.click(badges[0]);
    expect(container.querySelector('.chip-error-text')!.textContent).toBe('model 502');
  });

  it('an empty stream says so rather than rendering a blank pane', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(container.querySelector('.stream-empty')!.textContent).toContain('Nothing said yet');
  });
});

// The screenshot this closed showed 'Crane - the collab's builder: ...' as
// both a chip's own text AND the message author label — a sentence where a
// name belongs. The short name is the SAME rule in both places; the full
// description is never dropped, only moved to a tooltip.
describe('CollabPane — short names, full description on hover', () => {
  const longName = "Crane - the collab's builder: reviews every diff before it lands";

  it("a chip shows the short name; the full description is its tooltip, not its text", async () => {
    const { container } = render(CollabPane);
    await post(state({ participants: [
      { agentSlug: 'collab-crane', displayName: longName, model: 'lmstudio/qwen' },
      { agentSlug: 'collab-heron', displayName: 'Heron', model: null },
    ] }));
    expect(Array.from(container.querySelectorAll('.chip-name')).map((n) => n.textContent)).toEqual(['Crane', 'Heron']);
    const craneChip = container.querySelectorAll('.chip')[0] as HTMLElement;
    expect(craneChip.title).toContain("the collab's builder");
  });

  it('the message author header shows the short name, with the description on hover', async () => {
    const { container } = render(CollabPane);
    await post(state({
      participants: [{ agentSlug: 'collab-crane', displayName: longName, model: null }],
      messages: [msg(1)],
    }));
    const author = container.querySelector('.cs-author') as HTMLElement;
    expect(author.textContent).toBe('Crane');
    expect(author.title).toContain("the collab's builder");
  });
});

// The bugs worth catching: markdown rendering as literal characters ("a
// screed of text"), and a human's literal `**` being MISread as emphasis.
describe('CollabPane — markdown in the stream', () => {
  it("an agent's message renders markdown — headings and bold become real elements", async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { text: '## Plan\n\n**do it now**' })] }));
    const bubble = container.querySelector('.msg-text') as HTMLElement;
    expect(bubble.querySelector('h2')?.textContent).toBe('Plan');
    expect(bubble.querySelector('strong')?.textContent).toBe('do it now');
    expect(bubble.textContent).not.toContain('##');
    expect(bubble.textContent).not.toContain('**');
  });

  it("a human's message is shown literally — never parsed as markdown", async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { authorId: 'user', authorKind: 'human', text: '**not bold**' })] }));
    const bubble = container.querySelector('.msg-text') as HTMLElement;
    expect(bubble.querySelector('strong')).toBeNull();
    expect(bubble.textContent).toBe('**not bold**');
  });
});

// Each message gets its own bordered bubble; the side (and its tint) is
// carried on the bubble itself, not just the group's avatar column.
describe('CollabPane — chat-style bubble sides', () => {
  it("a human's bubble is marked for the tinted right side; an agent's is not", async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [msg(1), msg(2, { authorId: 'user', authorKind: 'human', text: 'do the thing' })],
    }));
    const bubbles = container.querySelectorAll('.cs-msg');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].className).not.toContain('human');
    expect(bubbles[1].className).toContain('human');
  });
});

describe('CollabPane — the poll loop', () => {
  it('polls its OWN collab on mount, from the very beginning of the stream', () => {
    render(CollabPane);
    expect(polls()).toEqual([{ type: 'collabPoll', collabId: ID, sinceSeq: 0 }]);
  });

  it('the next poll asks only for what is NEW — sinceSeq is the highest seq rendered', async () => {
    render(CollabPane);
    await post(state({ messages: [msg(1), msg(2), msg(3)] }));
    // `collabPosted` makes the pane re-poll immediately (a send should show up
    // now, not on the next tick) — the same poll() the timer fires.
    await post({ type: 'collabPosted', collabId: ID, seq: 4 });
    expect(polls().at(-1)).toEqual({ type: 'collabPoll', collabId: ID, sinceSeq: 3 });
  });

  it('an incremental payload APPENDS; a sinceSeq-0 payload REPLACES', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2)] }));
    await post(state({ sinceSeq: 2, messages: [msg(3)] }));
    expect(bubbleTexts(container)).toEqual(['message 1', 'message 2', 'message 3']);

    // A full snapshot is authoritative — it replaces, so a message the engine
    // dropped cannot linger on screen forever.
    await post(state({ sinceSeq: 0, messages: [msg(1)] }));
    expect(bubbleTexts(container)).toEqual(['message 1']);
  });

  // The HOST polls collabs too now (collabWatch.ts) and keeps its own seq
  // count, so one of its increments can reach a pane whose own sinceSeq-0 poll
  // has not answered yet. Appending it would render a transcript that starts in
  // the middle of the conversation.
  it('ignores an increment that arrives before the pane has its first full snapshot', async () => {
    const { container } = render(CollabPane);
    await post(state({ sinceSeq: 4, messages: [msg(5)] }));
    expect(bubbleTexts(container)).toEqual([]);
    await post(state({ sinceSeq: 0, messages: [msg(1), msg(2)] }));
    expect(bubbleTexts(container)).toEqual(['message 1', 'message 2']);
  });

  it('a repeated increment cannot double-print a message', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1)] }));
    await post(state({ sinceSeq: 1, messages: [msg(2)] }));
    await post(state({ sinceSeq: 1, messages: [msg(2)] }));
    expect(bubbleTexts(container)).toEqual(['message 1', 'message 2']);
  });

  // The timer is the pane's engine. Everything above drives poll() through a
  // handler; this drives it through the real re-armed setTimeout, so the
  // callback itself — including the busy-vs-idle rate decision it reads — is
  // executed rather than assumed.
  it('keeps polling on its own timer — loosely while idle', async () => {
    vi.useFakeTimers();
    try {
      render(CollabPane);
      expect(polls()).toHaveLength(1);           // the mount poll

      await vi.advanceTimersByTimeAsync(1500);   // inside the idle gap
      expect(polls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);   // past 4s
      expect(polls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The bug this pins down: re-arming the loop ONLY from inside the tick meant
  // a run that started during an idle stretch stayed invisible until the
  // already-armed 4s timeout came round. The rate has to change when `busy`
  // changes, not when the next tick happens to land.
  it('tightens the loop the MOMENT an agent starts, not at the next idle tick', async () => {
    vi.useFakeTimers();
    try {
      render(CollabPane);
      await vi.advanceTimersByTimeAsync(500);    // mid-way through an idle gap
      const before = polls().length;

      await post(state({ agents: [{ slug: 'collab-crane', state: 'running' }] }));
      await vi.advanceTimersByTimeAsync(1300);
      await vi.advanceTimersByTimeAsync(1300);
      expect(polls().length).toBe(before + 2);

      // ...and loosens again once the work is done.
      await post(state({ sinceSeq: 0, agents: [{ slug: 'collab-crane', state: 'idle' }] }));
      const settled = polls().length;
      await vi.advanceTimersByTimeAsync(1500);
      expect(polls().length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling once the tab is gone — a closed collab must not keep asking forever', async () => {
    vi.useFakeTimers();
    try {
      render(CollabPane);
      await vi.advanceTimersByTimeAsync(5000);
      expect(polls().length).toBeGreaterThan(1);
      cleanup();
      const after = polls().length;
      await vi.advanceTimersByTimeAsync(20000);
      expect(polls().length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a payload for a DIFFERENT collab is dropped — one host broadcast reaches every open tab', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1)] }));
    await post({ ...(state({ messages: [msg(9, { text: 'other collab' })] }) as object), collabId: 'collab-other' });
    expect(bubbleTexts(container)).toEqual(['message 1']);
  });
});

describe('CollabPane — suspended banner', () => {
  it('shows the paused banner ONLY when the engine says the loop breaker tripped', async () => {
    const { container } = render(CollabPane);
    await post(state({ suspended: false }));
    expect(container.querySelector('.suspend-banner')).toBeNull();

    await post(state({ suspended: true }));
    expect(container.querySelector('.suspend-banner')!.textContent).toContain('waiting for you');

    await post(state({ suspended: false }));
    expect(container.querySelector('.suspend-banner')).toBeNull();
  });

  it('a build that omits `suspended` reads as RUNNING — never freeze a live stream behind a banner it did not earn', async () => {
    const { container } = render(CollabPane);
    const s = state() as Record<string, unknown>;
    delete s.suspended;
    await post(s);
    expect(container.querySelector('.suspend-banner')).toBeNull();
  });
});

describe('CollabPane — the loop-breaker cap', () => {
  it('states the cap, and null / 0 / N stay three different readings at bar width', async () => {
    // Owner UAT moved the sentence onto `title` (it wrapped ugly at sidebar
    // widths); the bar text is short, but the three states must never fold.
    const { container } = render(CollabPane);
    const capText = () => container.querySelector('.cap-text')!.textContent ?? '';
    const capTitle = () => container.querySelector('.cap-text')!.getAttribute('title') ?? '';

    await post(state({ collab: { id: ID, title: 't', createdAt: '', loopBreakerCap: null } }));
    expect(capText()).toBe('cap: default');

    await post(state({ collab: { id: ID, title: 't', createdAt: '', loopBreakerCap: 0 } }));
    expect(capText()).toBe('cap: off');
    expect(capTitle()).toContain('OFF');

    await post(state({ collab: { id: ID, title: 't', createdAt: '', loopBreakerCap: 12 } }));
    expect(capText()).toBe('cap: 12');
    expect(capTitle()).toContain('12 agent turns');
  });

  it('a blank cap input restores the DEFAULT (null); "0" turns the breaker OFF — the two are never folded together', async () => {
    const { container } = render(CollabPane);
    const input = container.querySelector('.cap-input') as HTMLInputElement;
    const apply = container.querySelector('.cap-apply') as HTMLElement;

    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: null });

    await fireEvent.input(input, { target: { value: '0' } });
    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: 0 });

    await fireEvent.input(input, { target: { value: '9' } });
    await fireEvent.click(apply);
    expect(posts().at(-1)).toEqual({ type: 'collabSetCap', collabId: ID, cap: 9 });
  });

  it('a negative cap is refused rather than sent — there is no such setting', async () => {
    const { container } = render(CollabPane);
    const input = container.querySelector('.cap-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '-3' } });
    await fireEvent.click(container.querySelector('.cap-apply') as HTMLElement);
    expect(posts().filter((p) => p.type === 'collabSetCap')).toEqual([]);
  });
});

// The composer is the chat's InputBar in bare mode now (`.input` is its
// textarea). These cases are unchanged in what they assert: the pane's contract
// with whatever box it mounts — trim, clear on success, never send whitespace,
// and surface a refusal — is exactly what a swapped composer could break.
describe('CollabPane — the composer', () => {
  it('sending posts the trimmed text to THIS collab and clears the box', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '  ship it  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(posts()).toContainEqual({ type: 'collabPost', collabId: ID, text: 'ship it' });
    expect(box.value).toBe('');
  });

  it('Enter sends; Shift+Enter does not', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;

    await fireEvent.input(box, { target: { value: 'line one' } });
    await fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(posts().filter((p) => p.type === 'collabPost')).toEqual([]);

    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts()).toContainEqual({ type: 'collabPost', collabId: ID, text: 'line one' });
  });

  it('an all-whitespace message is never sent', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '   ' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts().filter((p) => p.type === 'collabPost')).toEqual([]);
  });

  it('a refused post is surfaced — a message that never landed must not look sent', async () => {
    const { container } = render(CollabPane);
    await post({ type: 'collabPosted', collabId: ID, seq: null, error: 'collab is archived' });
    expect(container.querySelector('.error-banner')!.textContent).toContain('collab is archived');
  });

  // A collab tab is the ONLY place its stream exists — the host keeps no mirror
  // of it — so the export has to be rendered here and handed over whole.
  it('Export hands the host a rendered, ATTRIBUTED transcript of this collab', async () => {
    render(CollabPane);
    await post(state({ messages: [msg(1, { text: 'on it' }), msg(2, { authorId: 'user', authorKind: 'human', text: 'go' })] }));

    await fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const sent = posts().filter((p) => p.type === 'exportCollab').at(-1)!;
    expect(sent.collabId).toBe(ID);
    expect(sent.title).toBe('Storm plan');
    const md = String(sent.markdown);
    expect(md).toContain('# Origami collab — Storm plan');
    expect(md).toContain('**Crane**');
    expect(md).toContain('**You**');
    expect(md).toContain('on it');
    expect(md).toContain('go');
  });

  // M4.1: the BOARD goes with the transcript. A collab's tasks are half of what
  // happened in the room, and an export that dropped them wrote down the talking
  // and none of the work. Driven through the pane's real polled state, so this
  // also proves the two board fields are actually threaded to the renderer.
  it('Export carries the task board and the spend totals, not just the talking', async () => {
    render(CollabPane);
    await post(state({
      messages: [msg(1, { text: 'on it', kind: 'say' })],
      tasks: [
        { id: 't1', title: 'Write the parser', owner: 'collab-crane', state: 'accepted',
          createdBy: 'user', result: null, note: null, originSeq: null, createdAt: '', updatedAt: '' },
        { id: 't2', title: 'Design the grammar', owner: null, state: 'open',
          createdBy: 'user', result: null, note: null, originSeq: null, createdAt: '', updatedAt: '' },
      ],
      costTotals: [{ agentSlug: 'collab-crane', cost: 0.5, tokensInput: 900, tokensOutput: 100 }],
    }));

    await fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const md = String(posts().filter((p) => p.type === 'exportCollab').at(-1)!.markdown);
    expect(md).toContain('## Board');
    expect(md).toContain('- **accepted** · Crane · Write the parser');
    expect(md).toContain('- **open** · unowned · Design the grammar');
    expect(md).toContain('1,000 tokens');
  });

  // An engine with no board must not produce a heading claiming there are no
  // tasks — "this build has no board" and "this room has no tasks" differ.
  it('...and writes NO Board section when the engine reported no board at all', async () => {
    render(CollabPane);
    await post(state({ messages: [msg(1, { text: 'on it' })] }));
    await fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    expect(String(posts().filter((p) => p.type === 'exportCollab').at(-1)!.markdown)).not.toContain('## Board');
  });

  // An empty export is a file that says nothing, so the control is dead until
  // there is a stream to write.
  it('...and the button is disabled while the stream is empty', async () => {
    render(CollabPane);
    await post(state({ messages: [] }));
    expect((screen.getByRole('button', { name: /Export/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// M2 — the stream became a Slack-style transcript. The grouping is the feature,
// so it is asserted as a COUNT of headers against a known run of messages: a
// stream that reverted to one header per message still renders every word and
// would pass any "the text is on screen" check.
describe('CollabPane — Slack-style grouping', () => {
  it('a run of consecutive messages from one author renders ONE header', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2), msg(3)] }));
    expect(bubbleTexts(container)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(authorHeaders(container)).toEqual(['Crane']);
    expect(groupSizes(container)).toEqual([3]);
  });

  it('a change of author breaks the run, and the FIRST author returning starts a new group', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [
        msg(1),
        msg(2, { authorId: 'collab-heron' }),
        msg(3),
        msg(4),
      ],
    }));
    // Not ['Crane','Heron'] — the second Crane run is a separate turn and must
    // not be folded back into the first one further up the stream.
    expect(authorHeaders(container)).toEqual(['Crane', 'Heron', 'Crane']);
    expect(groupSizes(container)).toEqual([1, 1, 2]);
  });

  it('a human run groups too, and is styled as You rather than by slug', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [
        msg(1, { authorId: 'user', authorKind: 'human', text: 'a' }),
        msg(2, { authorId: 'user', authorKind: 'human', text: 'b' }),
      ],
    }));
    expect(authorHeaders(container)).toEqual(['You']);
    expect(container.querySelectorAll('.cs-group.human')).toHaveLength(1);
  });

  // An agent and a human sharing an authorId would be the one case where
  // grouping could merge two different speakers into one header.
  it('grouping splits on author KIND, not just the id', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [msg(1, { authorId: 'user', authorKind: 'agent' }), msg(2, { authorId: 'user', authorKind: 'human' })],
    }));
    // 'user' has no roster entry and no collab- prefix to strip, so the
    // short-name rule still applies: capitalised, same as any other slug.
    expect(authorHeaders(container)).toEqual(['User', 'You']);
  });

  it('appended messages extend the OPEN group rather than opening a duplicate header', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1)] }));
    await post(state({ sinceSeq: 1, messages: [msg(2)] }));
    expect(authorHeaders(container)).toEqual(['Crane']);
    expect(groupSizes(container)).toEqual([2]);
  });
});

describe('CollabPane — avatars', () => {
  it("an agent whose slug resolves to a brand glyph gets the glyph, not a letter disc", async () => {
    const { container } = render(CollabPane);
    // `collab-crane` is not a glyph key: it resolves only if the prefix is
    // stripped AND `crane` is aliased onto the tsuru polygons.
    await post(state({ messages: [msg(1, { authorId: 'collab-crane' })] }));
    expect(container.querySelectorAll('.cs-glyph')).toHaveLength(1);
    expect(container.querySelectorAll('.cs-disc')).toHaveLength(0);
  });

  it('an agent with no glyph falls back to an initial-letter disc in a theme colour', async () => {
    const { container } = render(CollabPane);
    await post(state({
      participants: [{ agentSlug: 'collab-zzz', displayName: 'Zephyr', model: null }],
      messages: [msg(1, { authorId: 'collab-zzz' })],
    }));
    const disc = container.querySelector('.cs-disc') as HTMLElement;
    expect(disc.textContent).toBe('Z');
    // The tone is a THEME VAR, never a literal — a hard-coded colour would be
    // invisible in at least one of the five themes.
    expect(disc.getAttribute('style')).toMatch(/--cs-tone: var\(--og-[a-z0-9-]+\)/);
  });

  it('the same slug always draws the same tone, and two slugs are picked independently', async () => {
    const { container, unmount } = render(CollabPane);
    const toneFor = (c: HTMLElement) => (c.querySelector('.cs-disc') as HTMLElement).getAttribute('style');
    await post(state({
      participants: [{ agentSlug: 'collab-zzz', displayName: 'Zephyr', model: null }],
      messages: [msg(1, { authorId: 'collab-zzz' })],
    }));
    const first = toneFor(container);
    unmount();

    const { container: again } = render(CollabPane);
    await post(state({
      participants: [{ agentSlug: 'collab-zzz', displayName: 'Zephyr', model: null }],
      messages: [msg(1, { authorId: 'collab-zzz' })],
    }));
    expect(toneFor(again)).toBe(first);
  });

  it('the human gets no brand glyph — a You disc, never an animal', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { authorId: 'user', authorKind: 'human' })] }));
    expect(container.querySelectorAll('.cs-glyph')).toHaveLength(0);
    expect(container.querySelector('.cs-disc')!.className).toContain('you');
  });
});

// Flock M4 wave X1 — the unified Message/Summary types gained kind/mentions/
// taskId/trace/lead/objective. The engine does not send any of them yet, and
// even once it does, an OLD build in the field still won't — so both
// directions have to render exactly as they do today, with no crash and no
// extra chrome (X2 owns the trace/kind/task presentation).
describe('CollabPane — flock M4 fields are defensively absent-safe', () => {
  it('a message with none of the new fields (today\'s wire shape) renders exactly as before', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1)] }));
    expect(bubbleTexts(container)).toEqual(['message 1']);
    expect(authorHeaders(container)).toEqual(['Crane']);
  });

  it('a message CARRYING the new fields still renders through the same bubble — extra fields are not a crash', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [msg(1, {
        id: 'm1',
        kind: 'ask',
        mentions: ['collab-heron'],
        taskId: 't1',
        trace: [{ tool: 'bash', summary: 'ran a command', status: 'ok' }],
      })],
    }));
    expect(bubbleTexts(container)).toEqual(['message 1']);
  });

  it('a collab summary with lead/objective set does not disturb the cap text or roster', async () => {
    const { container } = render(CollabPane);
    await post(state({ collab: { id: ID, title: 'Storm plan', createdAt: '', loopBreakerCap: null, lead: 'collab-crane', objective: 'Ship it' } }));
    expect(container.querySelector('.cap-text')!.textContent).toContain('default');
  });
});

describe('CollabPane — an archived collab is read-only', () => {
  const archivedState = () =>
    state({ collab: { id: ID, title: 'Storm plan', createdAt: '', archivedAt: '2026-08-04T11:00:00.000Z', loopBreakerCap: null } });

  it('disables the composer and says why, and tags the roster', async () => {
    const { container } = render(CollabPane);
    await post(archivedState());
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toContain('archived');
    expect(container.querySelector('.roster-archived')).not.toBeNull();
  });

  it('a live collab is NOT disabled — the lock is earned by archivedAt, not assumed', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect((container.querySelector('.input') as HTMLTextAreaElement).disabled).toBe(false);
    expect(container.querySelector('.roster-archived')).toBeNull();
  });

  // collab-resume: "cannot resume" used to be a dead end. Resume posts
  // collab_unarchive (via collabUnarchive) with the right collabId, and once
  // the engine's reply clears archivedAt on the next poll, the room reopens
  // live — composer re-enabled, tag and button both gone.
  it('Resume posts collabUnarchive with this collabId, and the room reopens once the poll reflects it', async () => {
    const { container } = render(CollabPane);
    await post(archivedState());
    const resumeBtn = container.querySelector('.roster-resume') as HTMLButtonElement | null;
    expect(resumeBtn).not.toBeNull();
    await fireEvent.click(resumeBtn!);
    expect(posts()).toContainEqual({ type: 'collabUnarchive', collabId: ID });

    // The engine cleared archivedAt; the pane's own re-poll (send() already
    // triggers one) picks it up on the next collabStateData reply.
    await post(state());
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(container.querySelector('.roster-archived')).toBeNull();
    expect(container.querySelector('.roster-resume')).toBeNull();
  });
});

describe('CollabPane — the / palette', () => {
  async function type(container: HTMLElement, value: string) {
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value } });
    return box;
  }

  it('typing / opens the palette; Escape closes it without clearing the draft', async () => {
    const { container } = render(CollabPane);
    const box = await type(container, '/');
    expect(container.querySelector('.slash-dropdown')).not.toBeNull();
    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(container.querySelector('.slash-dropdown')).toBeNull();
    expect(box.value).toBe('/');
  });

  it('each collab command dispatches its own host message', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    const send = async (text: string) => {
      await fireEvent.input(box, { target: { value: text } });
      await fireEvent.keyDown(box, { key: 'Enter' });
      return posts().at(-2) ?? posts().at(-1); // the poll() that follows is last
    };

    expect(await send('/rename Wire review')).toEqual({ type: 'collabRename', collabId: ID, title: 'Wire review' });
    expect(await send('/archive')).toEqual({ type: 'collabArchive', collabId: ID });
    expect(await send('/invite collab-heron')).toEqual({ type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-heron' });
    expect(await send('/remove collab-heron')).toEqual({ type: 'collabRemoveParticipant', collabId: ID, agentSlug: 'collab-heron' });
  });

  // Flock M4 wave X1 — the three new commands, dispatched but not yet
  // rendered anywhere (X2 builds the lead badge / objective field / stop
  // button); this pins the wire they will hang off.
  it('/lead, /objective and /stop each dispatch their own host message', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    const send = async (text: string, type: string) => {
      await fireEvent.input(box, { target: { value: text } });
      await fireEvent.keyDown(box, { key: 'Enter' });
      return posts().filter((p) => p.type === type).at(-1);
    };

    expect(await send('/lead collab-crane', 'collabSetLead')).toEqual({ type: 'collabSetLead', collabId: ID, agentSlug: 'collab-crane' });
    expect(await send('/objective Ship it Friday', 'collabSetObjective')).toEqual({ type: 'collabSetObjective', collabId: ID, objective: 'Ship it Friday' });
    expect(await send('/stop', 'collabStop')).toEqual({ type: 'collabStop', collabId: ID });
  });

  it('/cap keeps the three values apart — off is 0, default is null, N is N', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    const capSent = async (text: string) => {
      await fireEvent.input(box, { target: { value: text } });
      await fireEvent.keyDown(box, { key: 'Enter' });
      return posts().filter((p) => p.type === 'collabSetCap').at(-1);
    };
    expect(await capSent('/cap off')).toEqual({ type: 'collabSetCap', collabId: ID, cap: 0 });
    expect(await capSent('/cap default')).toEqual({ type: 'collabSetCap', collabId: ID, cap: null });
    expect(await capSent('/cap 9')).toEqual({ type: 'collabSetCap', collabId: ID, cap: 9 });
  });

  // The rule that matters most: the composer must never eat what you typed.
  it('an unrecognised /word is POSTED as an ordinary message, not swallowed', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/achive now' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts()).toContainEqual({ type: 'collabPost', collabId: ID, text: '/achive now' });
  });

  it('a command missing its argument says so and KEEPS the draft', async () => {
    const { container } = render(CollabPane);
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/rename' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts().filter((p) => p.type === 'collabRename')).toEqual([]);
    expect(container.querySelector('.error-banner')!.textContent).toContain('/rename needs a title');
    expect(box.value).toBe('/rename');
  });
});

describe('CollabPane — the per-agent context tracker', () => {
  const withSession = () =>
    state({
      participants: [
        { agentSlug: 'collab-crane', displayName: 'Crane', model: 'lmstudio/qwen', sessionId: 'ses_1' },
        { agentSlug: 'collab-heron', displayName: 'Heron', model: null },
      ],
    });

  const chip = (c: HTMLElement, i: number) => c.querySelectorAll('.chip')[i] as HTMLElement;

  it('clicking a chip with a sessionId asks the host for THAT session\'s capture', async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 0));
    expect(posts()).toContainEqual({
      type: 'collabPromptCapture', collabId: ID, sessionId: 'ses_1', slug: 'collab-crane',
    });
  });

  it('a participant with no sessionId asks for nothing and says why', async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 1));
    expect(posts().filter((p) => p.type === 'collabPromptCapture')).toEqual([]);
    expect(container.querySelector('.ctx-empty')!.textContent).toContain('has not taken a turn in the collab');
  });

  it('an evicted capture is a DIFFERENT sentence from never having taken a turn', async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 0));
    await post({ type: 'collabPromptCaptureData', collabId: ID, slug: 'collab-crane', capture: null });
    expect(container.querySelector('.ctx-empty')!.textContent).toContain('has not taken a turn recently');
  });

  it('renders a real capture through the shared section', async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 0));
    await post({
      type: 'collabPromptCaptureData',
      collabId: ID,
      slug: 'collab-crane',
      capture: {
        capturedAt: '2026-08-04T10:00:00.000Z',
        model: 'lmstudio/qwen',
        tokensApproxMethod: 'chars/4',
        labeledParts: [{ label: 'instructions', text: 'be terse', chars: 8, tokensApprox: 2 }],
        finalSystem: [{ text: 'be terse', chars: 8, tokensApprox: 2 }],
        tools: [],
      },
    });
    expect(container.querySelector('.pc-block')).not.toBeNull();
    expect(container.querySelector('.pc-meta')!.textContent).toContain('lmstudio/qwen');
  });

  // The fan-out hazard: a reply for the OTHER agent must not be painted under
  // the open one's name, which would misattribute a whole prompt.
  it("a capture reply for a different agent is dropped, not painted under the open agent's name", async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 0));
    await post({
      type: 'collabPromptCaptureData',
      collabId: ID,
      slug: 'collab-heron',
      capture: { capturedAt: 'x', model: 'other/model', tokensApproxMethod: 'chars/4', labeledParts: [], finalSystem: [], tools: [] },
    });
    // The drawer is still Crane's and still WAITING — it did not adopt Heron's
    // capture, and in particular never names Heron's model.
    expect(container.querySelector('.ctx-title')!.textContent).toContain('Crane');
    expect(container.textContent).not.toContain('other/model');
    expect(container.querySelector('.pc-empty')!.textContent).toContain('Reading the last prepared request');
  });

  it('clicking the open chip again closes the drawer', async () => {
    const { container } = render(CollabPane);
    await post(withSession());
    await fireEvent.click(chip(container, 0));
    expect(container.querySelector('.ctx-drawer')).not.toBeNull();
    await fireEvent.click(chip(container, 0));
    expect(container.querySelector('.ctx-drawer')).toBeNull();
  });
});

// M3 — agents no longer ride the create form (that is title-only now); they
// join from the roster's own Invite button instead. These pin the merge
// (engine ∪ fs, active participants excluded) and that a refused fetch is
// SAID rather than silently leaving the popover at whatever it last held —
// the exact class of swallow that made Goal 1's create button go silently
// dead in the first place.
describe('CollabPane — the Invite popover (M3)', () => {
  const inviteBtn = (c: HTMLElement) => c.querySelector('.invite-btn') as HTMLElement;

  it('merges engine agents with fs-only defs, disabling the fs-only one with the restart reason', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({ type: 'collabAgents', agents: [{ slug: 'collab-falcon', displayName: 'Falcon' }], glyphs: {} });
    await post({ type: 'collabAgentDefs', defs: [{ slug: 'collab-new', description: 'New agent' }] });

    await fireEvent.click(inviteBtn(container));
    const rows = Array.from(container.querySelectorAll('.il-row'));
    // The row shows the SHORT name now — 'New agent' has no ' - ' separator,
    // so it falls back to the slug-derived 'New'; the full description moved
    // to the row's title instead (asserted below).
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Falcon'), expect.stringContaining('New')]),
    );
    const fsRow = rows.find((r) => r.querySelector('.il-slug')?.textContent === 'collab-new') as HTMLButtonElement;
    expect(fsRow.disabled).toBe(true);
    expect(fsRow.title).toContain('New agent');
    // M4.3: the engine rescans defs on demand, so fs-only = the FILE failed
    // to load - the reason must point at the definition, not at a restart.
    expect(fsRow.title).toContain('not loadable');
  });

  it('an already-active participant is excluded — it cannot be invited twice', async () => {
    const { container } = render(CollabPane);
    await post(state()); // participants already include collab-crane
    await post({
      type: 'collabAgents',
      agents: [{ slug: 'collab-crane', displayName: 'Crane' }, { slug: 'collab-falcon', displayName: 'Falcon' }],
      glyphs: {},
    });

    await fireEvent.click(inviteBtn(container));
    const slugs = Array.from(container.querySelectorAll('.il-slug')).map((n) => n.textContent);
    expect(slugs).not.toContain('collab-crane');
    expect(slugs).toContain('collab-falcon');
  });

  // X2 (report 1.3): a pick no longer commits — the popover holds the picks and
  // one Invite click sends them all. The wire per agent is unchanged.
  it('picking a row and committing posts collabAddParticipant for THAT collab', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({ type: 'collabAgents', agents: [{ slug: 'collab-falcon', displayName: 'Falcon' }], glyphs: {} });

    await fireEvent.click(inviteBtn(container));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Falcon/ }));
    expect(posts().filter((p) => p.type === 'collabAddParticipant')).toEqual([]);

    await fireEvent.click(screen.getByRole('button', { name: /^Invite \(/ }));
    expect(posts()).toContainEqual({ type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-falcon' });
  });

  it('two picks commit as two adds on one click, and re-poll once', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({
      type: 'collabAgents',
      agents: [{ slug: 'collab-falcon', displayName: 'Falcon' }, { slug: 'collab-wren', displayName: 'Wren' }],
      glyphs: {},
    });

    await fireEvent.click(inviteBtn(container));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Falcon/ }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Wren/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Invite \(/ }));

    expect(posts().filter((p) => p.type === 'collabAddParticipant')).toEqual([
      { type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-falcon' },
      { type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-wren' },
    ]);
  });

  it('a refused engine-roster fetch is surfaced, not silently left stale', async () => {
    const { container } = render(CollabPane);
    await post({ type: 'collabAgents', agents: [], error: 'engine unreachable' });
    expect(container.querySelector('.error-banner')!.textContent).toContain('engine unreachable');
  });

  it('a refused fs-def fetch is surfaced the same way', async () => {
    const { container } = render(CollabPane);
    await post({ type: 'collabAgentDefs', defs: [], error: 'permission denied' });
    expect(container.querySelector('.error-banner')!.textContent).toContain('permission denied');
  });
});

// ---------------------------------------------------------------------------
// Flock M4 wave X2 — the collab pane became a WORKING surface: the stream
// carries a protocol, there is a task board under the controls, and the room
// has a lead, a budget and a bill. Everything below is asserted against the
// contract's own vocabulary rather than against markup, because the shapes are
// what the engine and the pane have to agree on.
// ---------------------------------------------------------------------------

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  title: 'Wire the store',
  owner: 'collab-crane',
  state: 'open',
  createdBy: 'user',
  result: null,
  note: null,
  originSeq: null,
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
  ...over,
});

const TOTALS = [
  { agentSlug: 'collab-crane', cost: 0.25, tokensInput: 12000, tokensOutput: 20000 },
  { agentSlug: 'collab-heron', cost: 0.05, tokensInput: 2000, tokensOutput: 5000 },
];

const board = (c: HTMLElement) => c.querySelector('.tb-head') as HTMLButtonElement;
/** Open the collapsible board — it is shut on mount, and opening it is also
 *  what asks the host for the per-turn ledger. */
async function openBoard(c: HTMLElement): Promise<void> {
  await fireEvent.click(board(c));
}
const taskRows = (c: HTMLElement) => Array.from(c.querySelectorAll('.tb-row'));
const rowButtons = (row: Element) => Array.from(row.querySelectorAll('button')).map((b) => b.textContent?.trim());

describe('CollabPane — @mentions ride the post as structured data (C17)', () => {
  async function send(container: HTMLElement, text: string) {
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: text } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    return posts().filter((p) => p.type === 'collabPost').at(-1);
  }

  it('a named agent lands on the payload as a slug array', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(await send(container, '@collab-heron take the store')).toEqual({
      type: 'collabPost', collabId: ID, text: '@collab-heron take the store', mentions: ['collab-heron'],
    });
  });

  it('two named agents keep the order they were typed in, deduped', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const sent = await send(container, '@collab-heron and @collab-crane and @collab-heron again');
    expect(sent!.mentions).toEqual(['collab-heron', 'collab-crane']);
  });

  // The engine REFUSES a post naming an unknown slug and appends nothing, so a
  // typo'd handle sent through would cost the user the whole message.
  it('a slug the roster does not carry is dropped rather than sent', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(await send(container, '@collab-ghost do it')).toEqual({
      type: 'collabPost', collabId: ID, text: '@collab-ghost do it',
    });
  });

  it('a REMOVED participant is not mentionable — the active roster is the authority', async () => {
    const { container } = render(CollabPane);
    await post(state({
      participants: [
        { agentSlug: 'collab-crane', displayName: 'Crane', model: null },
        { agentSlug: 'collab-heron', displayName: 'Heron', model: null, removedAt: '2026-08-05T09:00:00.000Z' },
      ],
    }));
    expect(await send(container, '@collab-heron are you there')).toEqual({
      type: 'collabPost', collabId: ID, text: '@collab-heron are you there',
    });
  });

  // An unaddressed post is the common case and must keep TODAY'S exact wire
  // shape — an empty array would read as "addressed to nobody on purpose",
  // which is a different instruction to the wake rules than "not addressed".
  it('an ordinary message carries no mentions field at all', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(await send(container, 'ship it')).toEqual({ type: 'collabPost', collabId: ID, text: 'ship it' });
  });

  it('the composer offers the ACTIVE roster to the picker, short-named', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '@' } });
    expect(Array.from(container.querySelectorAll('.slash-name')).map((n) => n.textContent))
      .toEqual(['@collab-crane', '@collab-heron']);
    expect(Array.from(container.querySelectorAll('.slash-desc')).map((n) => n.textContent))
      .toEqual(['Crane', 'Heron']);
  });
});

describe('CollabPane — the lead badge (C18)', () => {
  // X2: the star is a SIBLING of the chip button, not a child — a button inside
  // a button is invalid markup, and the settable star (`.chip-lead.set`, drawn
  // on every OTHER chip) is an offer, not a badge.
  const leadStars = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.chip-wrap')).map((wrap) => !!wrap.querySelector('.chip-lead:not(.set)'));

  it('marks exactly the lead chip, and nobody else', async () => {
    const { container } = render(CollabPane);
    await post(state({ lead: 'collab-heron' }));
    expect(leadStars(container)).toEqual([false, true]);
  });

  it('a leadless collab draws no badge at all — no lead is a real state, not a missing one', async () => {
    const { container } = render(CollabPane);
    await post(state({ lead: null }));
    expect(leadStars(container)).toEqual([false, false]);
    // ...and so is an engine that never sends the field.
    await post(state({ sinceSeq: 0 }));
    expect(leadStars(container)).toEqual([false, false]);
  });

  it('the lead on the collab SUMMARY is honoured too — one field set is enough', async () => {
    const { container } = render(CollabPane);
    await post(state({
      collab: { id: ID, title: 'Storm plan', createdAt: '', loopBreakerCap: null, lead: 'collab-crane' },
    }));
    expect(leadStars(container)).toEqual([true, false]);
  });

  it("the chip's hover text says lead as well — the star alone is colour and shape", async () => {
    const { container } = render(CollabPane);
    await post(state({ lead: 'collab-crane' }));
    expect((container.querySelectorAll('.chip')[0] as HTMLElement).title).toContain('lead');
    expect((container.querySelectorAll('.chip')[1] as HTMLElement).title).not.toContain('lead');
  });
});

describe('CollabPane — message kinds render as what they DID', () => {
  const bubbles = (c: HTMLElement) => Array.from(c.querySelectorAll('.cs-msg'));
  const tones = (c: HTMLElement) => bubbles(c).map((b) => b.getAttribute('data-tone'));
  const kindLabels = (c: HTMLElement) => Array.from(c.querySelectorAll('.cs-kind')).map((n) => n.textContent);
  const sysRows = (c: HTMLElement) => Array.from(c.querySelectorAll('.cs-sys'));

  // W2 (report 2.3): the label became a DIRECTION. "asked @Heron" said a
  // question happened; it did not say who was now blocked on whom, which is the
  // one thing a supervisor reads off a four-agent room. The rule and every input
  // class it has are pinned in collabKinds.test.ts.
  it('an ask is tinted and reads as a direction, by SHORT name', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { kind: 'ask', mentions: ['collab-heron'], text: 'can you wire it?' })] }));
    expect(tones(container)).toEqual(['ask']);
    expect(kindLabels(container)).toEqual(['Crane → Heron · asked']);
    expect(bubbleTexts(container)).toEqual(['can you wire it?']);
  });

  it('a handoff carries its own tone and verb — the two directed kinds are told apart', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { kind: 'handoff', mentions: ['collab-heron'] })] }));
    expect(tones(container)).toEqual(['handoff']);
    expect(kindLabels(container)).toEqual(['Crane → Heron · handed on']);
  });

  it('an answer links back to the ask it belongs to', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [
        msg(1, { kind: 'ask', mentions: ['collab-heron'] }),
        msg(2, { authorId: 'collab-heron', kind: 'answer', replyToSeq: 1, text: 'done' }),
      ],
    }));
    const link = container.querySelectorAll('.cs-reply');
    expect(Array.from(link).map((n) => n.textContent)).toEqual(['answer to #1']);
    // A control, not a caption: it jumps to the message it names.
    expect(link[0].tagName).toBe('BUTTON');
    await fireEvent.click(link[0]);
    // jsdom has no scrollIntoView — the guard is the point, so a missing
    // target must do nothing rather than throw and blank the stream.
    expect(bubbleTexts(container)).toEqual(['message 1', 'done']);
  });

  it('every task_* kind is a compact ONE-LINE row, never a bubble', async () => {
    const { container } = render(CollabPane);
    await post(state({
      messages: [
        msg(1, { kind: 'task_open', text: 'Wire the store' }),
        msg(2, { kind: 'task_claim', text: 'Wire the store' }),
        msg(3, { kind: 'task_done', text: 'Wire the store' }),
        msg(4, { kind: 'task_accept', text: 'Wire the store' }),
        msg(5, { kind: 'task_reopen', text: 'Wire the store' }),
      ],
    }));
    expect(sysRows(container)).toHaveLength(5);
    expect(bubbles(container)).toHaveLength(0);
    expect(Array.from(container.querySelectorAll('.cs-sys-label')).map((n) => n.textContent)).toEqual([
      // Only task_done gains a direction: it is the one that is now WAITING —
      // on a human, at the board, to accept it or send it back.
      'opened a task', 'claimed a task', 'Crane → board · finished a task',
      'accepted a task', 'reopened a task',
    ]);
  });

  it("a system line's own text IS the message — it gets no invented verb", async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { kind: 'system', text: 'collab-heron left the room' })] }));
    expect(sysRows(container)).toHaveLength(1);
    expect(container.querySelector('.cs-sys-label')).toBeNull();
    expect(container.querySelector('.cs-sys-text')!.textContent).toBe('collab-heron left the room');
  });

  // The compatibility case: an older engine sends no `kind` at all, and a
  // backfilled row says 'say'. Both must read as an ordinary message.
  it('a message with NO kind renders as an ordinary untinted bubble, same as an explicit say', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2, { kind: 'say' })] }));
    expect(bubbles(container)).toHaveLength(2);
    expect(tones(container)).toEqual(['', '']);
    expect(kindLabels(container)).toEqual([]);
    expect(sysRows(container)).toHaveLength(0);
  });

  it('a system row BREAKS a speaking run rather than being attributed to it', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2, { kind: 'task_claim' }), msg(3)] }));
    // Two separate turns for Crane, not one group of two with a task line inside.
    expect(authorHeaders(container)).toEqual(['Crane', 'Crane']);
    expect(groupSizes(container)).toEqual([1, 1]);
  });
});

describe('CollabPane — the tool trace folds (C27)', () => {
  const TRACE = [
    { tool: 'bash', summary: 'npm run typecheck', status: 'ok' },
    { tool: 'edit', summary: 'store.ts', status: 'error' },
  ];

  it('folded, the row states the count and that something failed', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { trace: TRACE })] }));
    expect(container.querySelector('.cs-trace-count')!.textContent).toBe('2 tools ran');
    expect(container.querySelector('.cs-trace-failed')!.textContent).toBe('1 failed');
    expect(container.querySelectorAll('.cs-trace-row')).toHaveLength(0);
  });

  it('opening it shows every entry — tool, summary and status — and closing hides them again', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { trace: TRACE })] }));
    const head = container.querySelector('.cs-trace-head') as HTMLButtonElement;

    await fireEvent.click(head);
    expect(Array.from(container.querySelectorAll('.cs-trace-tool')).map((n) => n.textContent)).toEqual(['bash', 'edit']);
    expect(Array.from(container.querySelectorAll('.cs-trace-sum')).map((n) => n.textContent))
      .toEqual(['npm run typecheck', 'store.ts']);
    expect(Array.from(container.querySelectorAll('.cs-trace-status')).map((n) => n.textContent)).toEqual(['ok', 'error']);

    await fireEvent.click(head);
    expect(container.querySelectorAll('.cs-trace-row')).toHaveLength(0);
  });

  it('an all-ok trace says nothing about failures', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { trace: [{ tool: 'read', summary: 'sql.ts', status: 'ok' }] })] }));
    expect(container.querySelector('.cs-trace-count')!.textContent).toBe('1 tool ran');
    expect(container.querySelector('.cs-trace-failed')).toBeNull();
  });

  it('no trace and an EMPTY trace both draw no row — an empty list is not "0 tools ran"', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2, { trace: [] })] }));
    expect(container.querySelector('.cs-trace')).toBeNull();
  });

  it('a task row keeps its trace too — which tools ran is a fact about the TURN', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { kind: 'task_done', trace: TRACE })] }));
    expect(container.querySelector('.cs-sys-trace .cs-trace-count')!.textContent).toBe('2 tools ran');
  });
});

describe('CollabPane — the task board', () => {
  it('is collapsed on mount and says what is behind it', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task(), task({ id: 't2', state: 'claimed' }), task({ id: 't3', state: 'done' })] }));
    // One count per STATE (W8): `open` is not "in play" — nobody has claimed it.
    expect(container.querySelector('.tb-summary')!.textContent).toBe(
      '3 tasks · 1 unclaimed · 1 in play · 1 awaiting you',
    );
    expect(taskRows(container)).toHaveLength(0);
  });

  // An engine with no board at all and a board with nothing on it are DIFFERENT
  // facts — "no tasks yet" on a build that cannot have any would be a lie.
  it('tells an engine with no board apart from an empty one', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(container.querySelector('.tb-summary')!.textContent).toBe('no board on this engine');
    await openBoard(container);
    expect(container.querySelector('.tb-empty')!.textContent).toContain('no task board');

    await post(state({ sinceSeq: 0, tasks: [] }));
    expect(container.querySelector('.tb-summary')!.textContent).toBe('nothing on the board yet');
    expect(container.querySelector('.tb-empty')!.textContent).toContain('No tasks yet');
  });

  it('renders each task with its state chip, owner and result preview', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ state: 'done', result: 'store.ts written', owner: 'collab-heron' })] }));
    await openBoard(container);
    // `done` is the AWAITING-REVIEW state — the Accept/Reopen buttons on this
    // very row are what it is waiting for. The wire word stays on the element.
    expect(container.querySelector('.tb-chip')!.textContent).toBe('awaiting review');
    expect(container.querySelector('.tb-chip')!.getAttribute('data-state')).toBe('done');
    expect(container.querySelector('.tb-name')!.textContent).toBe('Wire the store');
    expect(container.querySelector('.tb-owner')!.textContent).toBe('@collab-heron');
    expect(container.querySelector('.tb-result')!.textContent).toBe('store.ts written');
  });

  it('an unowned task says so rather than showing an empty column', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ owner: null })] }));
    await openBoard(container);
    expect(container.querySelector('.tb-owner')!.textContent).toBe('unclaimed');
  });

  it('Add posts collabTaskAdd with the typed title and clears the box', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [] }));
    await openBoard(container);
    const input = screen.getByLabelText('New task title') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '  Ship the wire  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(posts()).toContainEqual({ type: 'collabTaskAdd', collabId: ID, title: 'Ship the wire' });
    expect(input.value).toBe('');
  });

  it('an empty title adds nothing — the control is dead until there is a task', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [] }));
    await openBoard(container);
    await fireEvent.input(screen.getByLabelText('New task title'), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(posts().filter((p) => p.type === 'collabTaskAdd')).toEqual([]);
  });

  // ONLY LEGAL TRANSITIONS ARE DRAWN. Accept/Reopen exist on a done task and
  // nowhere else — claiming is an agent's move, and a disabled button would
  // say "you may do this, later", which is not what the state machine means.
  it('offers Accept and Reopen on a done task, and NOTHING on the other three states', async () => {
    const { container } = render(CollabPane);
    await post(state({
      tasks: [
        task({ id: 't1', state: 'open' }),
        task({ id: 't2', state: 'claimed' }),
        task({ id: 't3', state: 'done' }),
        task({ id: 't4', state: 'accepted' }),
      ],
    }));
    await openBoard(container);
    const rows = taskRows(container);
    expect(rowButtons(rows[0])).toEqual([]);
    expect(rowButtons(rows[1])).toEqual([]);
    expect(rowButtons(rows[2])).toEqual(['Accept', 'Reopen']);
    expect(rowButtons(rows[3])).toEqual([]);
  });

  it('Accept posts collabTaskUpdate for THAT task', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't3', state: 'done' })] }));
    await openBoard(container);
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(posts()).toContainEqual({ type: 'collabTaskUpdate', collabId: ID, taskId: 't3', action: 'accept' });
  });

  // The engine REFUSES a reopen with no note, so the note is asked for before
  // the call rather than after a round trip that was always going to fail.
  it('Reopen asks for the reason first, and only then posts it', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't3', state: 'done' })] }));
    await openBoard(container);

    await fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const note = screen.getByLabelText('Reopen note for Wire the store') as HTMLInputElement;
    const sendBack = screen.getByRole('button', { name: 'Send back' }) as HTMLButtonElement;
    expect(sendBack.disabled).toBe(true);
    await fireEvent.click(sendBack);
    expect(posts().filter((p) => p.type === 'collabTaskUpdate')).toEqual([]);

    await fireEvent.input(note, { target: { value: 'the test still fails' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(posts()).toContainEqual({
      type: 'collabTaskUpdate', collabId: ID, taskId: 't3', action: 'reopen', note: 'the test still fails',
    });
  });

  it('an archived collab has no Add row and no per-task actions', async () => {
    const { container } = render(CollabPane);
    await post(state({
      collab: { id: ID, title: 'Storm plan', createdAt: '', archivedAt: '2026-08-05T11:00:00.000Z', loopBreakerCap: null },
      tasks: [task({ id: 't3', state: 'done' })],
    }));
    await openBoard(container);
    expect(screen.queryByLabelText('New task title')).toBeNull();
    expect(rowButtons(taskRows(container)[0])).toEqual([]);
  });

  // Engine-authoritative: nothing is spliced in locally, so a refused mutation
  // cannot leave an accepted task on screen. Every op re-polls.
  it('every board op re-polls rather than editing the list in place', async () => {
    const { container } = render(CollabPane);
    await post(state({ tasks: [task({ id: 't3', state: 'done' })] }));
    await openBoard(container);
    const before = polls().length;
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(polls().length).toBeGreaterThan(before);
    expect(container.querySelector('.tb-chip')!.getAttribute('data-state')).toBe('done');
  });
});

describe('CollabPane — the cost ledger (C13)', () => {
  it('totals the spend across agents in the board footer', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    await openBoard(container);
    expect(container.querySelector('.tb-totals')!.textContent)
      .toBe('Spend across 2 agents: $0.30 · 14.0k in · 25.0k out');
  });

  // labyrinthUsage discipline: an engine that sent no ledger says so. "$0"
  // would be a measurement, and this is an absence.
  it('says "no data yet" rather than inventing a zero', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await openBoard(container);
    expect(container.querySelector('.tb-totals')!.textContent).toBe('Spend: no data yet.');
  });

  it('asks for the per-turn entries when the section OPENS, not on every poll', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    expect(posts().filter((p) => p.type === 'requestCollabLedger')).toEqual([]);
    await openBoard(container);
    expect(posts()).toContainEqual({ type: 'requestCollabLedger', collabId: ID });
  });

  it('renders each entry with its agent, model and cost — and names the asker of a nested turn', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    await openBoard(container);
    await post({
      type: 'collabLedgerData',
      collabId: ID,
      totals: TOTALS,
      entries: [
        { id: 'e1', agentSlug: 'collab-heron', model: 'lmstudio/qwen3', tokensInput: 2000, tokensOutput: 5000, cost: 0.05, askedBy: 'collab-crane', createdAt: '2026-08-05T10:05:00.000Z' },
        { id: 'e2', agentSlug: 'collab-crane', model: 'lmstudio/qwen3', tokensInput: 12000, tokensOutput: 20000, cost: 0.25, askedBy: null, createdAt: '2026-08-05T10:00:00.000Z' },
      ],
    });
    const rows = Array.from(container.querySelectorAll('.tb-ledger-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.tb-ledger-agent')!.textContent).toBe('collab-heron (asked by collab-crane)');
    expect(rows[1].querySelector('.tb-ledger-agent')!.textContent).toBe('collab-crane');
    expect(rows[0].querySelector('.tb-ledger-model')!.textContent).toBe('lmstudio/qwen3');
  });

  // Asked and answered with nothing is NOT the same as never having asked.
  it('an empty ledger reply says no turn has been billed yet', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    await openBoard(container);
    await post({ type: 'collabLedgerData', collabId: ID, entries: [], totals: TOTALS });
    expect(container.querySelector('.tb-foot .tb-empty')!.textContent).toBe('No per-turn ledger yet.');
  });

  it('a ledger for ANOTHER collab is dropped — the host fans every reply out to every tab', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    await openBoard(container);
    await post({
      type: 'collabLedgerData',
      collabId: 'collab-other',
      entries: [{ id: 'x', agentSlug: 'collab-ghost', model: 'm', tokensInput: 1, tokensOutput: 1, cost: 1, askedBy: null, createdAt: '' }],
      totals: [],
    });
    expect(container.querySelectorAll('.tb-ledger-row')).toHaveLength(0);
    expect(container.querySelector('.tb-totals')!.textContent).toContain('Spend across 2 agents');
  });

  it('per-agent chips ride the roster context drawer, and say "no data yet" without a ledger', async () => {
    const { container } = render(CollabPane);
    await post(state({ costTotals: TOTALS }));
    await fireEvent.click(container.querySelectorAll('.chip')[0]);
    expect(Array.from(container.querySelectorAll('.cost-slug')).map((n) => n.textContent))
      .toEqual(['collab-crane', 'collab-heron']);
    expect(container.querySelector('.cost-chip')!.className).toContain('is-open');

    cleanup();
    const second = render(CollabPane);
    await post(state());
    await fireEvent.click(second.container.querySelectorAll('.chip')[0]);
    expect(second.container.querySelector('.cost-none')!.textContent).toBe('Spend: no data yet.');
  });
});

describe('CollabPane — STOP and the hop budget (C21)', () => {
  it('Stop posts collabStop for this collab', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await fireEvent.click(container.querySelector('.stop-btn') as HTMLButtonElement);
    expect(posts()).toContainEqual({ type: 'collabStop', collabId: ID });
  });

  it('...and is dead on an archived collab, which is already quiet', async () => {
    const { container } = render(CollabPane);
    await post(state({
      collab: { id: ID, title: 'Storm plan', createdAt: '', archivedAt: '2026-08-05T11:00:00.000Z', loopBreakerCap: null },
    }));
    expect((container.querySelector('.stop-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a spent budget gets the M4 wording', async () => {
    const { container } = render(CollabPane);
    await post(state({ suspended: true, hopState: { remaining: 0, cap: 6 } }));
    expect(container.querySelector('.suspend-text')!.textContent)
      .toContain('hop budget spent — waiting for you');
  });

  // An older engine sends no hopState at all, and must keep the banner it
  // earned rather than being given a hop count nobody reported.
  it("an engine with no hopState keeps today's loop-breaker wording", async () => {
    const { container } = render(CollabPane);
    await post(state({ suspended: true }));
    expect(container.querySelector('.suspend-text')!.textContent).toContain('hit the loop breaker');
    expect(container.querySelector('.suspend-text')!.textContent).not.toContain('hop budget');
    expect(container.querySelector('.hop-text')).toBeNull();
  });

  // M4.2 UAT: the read-out moved under the composer and became a FRACTION —
  // "3 hops left" says how much is left, "hops 3/6" says that AND how much
  // there ever was, which is the number you act on when deciding to raise the
  // cap. Same field, same poll, one sentence instead of two.
  it('what is LEFT of the budget is stated against what it started with', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: 3, cap: 6 } }));
    expect(container.querySelector('.hop-text')!.textContent).toBe('hops 3/6');
    await post(state({ sinceSeq: 0, hopState: { remaining: 1, cap: 6 } }));
    expect(container.querySelector('.hop-text')!.textContent).toBe('hops 1/6');
  });

  // remaining: null means the budget is OFF and must never be coalesced with a
  // number — "0 hops left" would say the opposite of what the engine reported.
  it('a budget that is OFF says so instead of counting down from nothing', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: null, cap: 0 } }));
    expect(container.querySelector('.hop-text')!.textContent).toBe('hop budget off');
  });

  it('no collab is suspended by default, so neither banner is drawn', async () => {
    const { container } = render(CollabPane);
    await post(state({ hopState: { remaining: 6, cap: 6 } }));
    expect(container.querySelector('.suspend-text')).toBeNull();
  });
});

describe('CollabPane — the standing objective', () => {
  it('renders it above the controls when the collab has one', async () => {
    const { container } = render(CollabPane);
    await post(state({ objective: 'Ship the wire by Friday' }));
    expect(container.querySelector('.objective-text')!.textContent).toBe('Ship the wire by Friday');
  });

  it('takes it off the collab summary too', async () => {
    const { container } = render(CollabPane);
    await post(state({
      collab: { id: ID, title: 'Storm plan', createdAt: '', loopBreakerCap: null, objective: 'Ship it' },
    }));
    expect(container.querySelector('.objective-text')!.textContent).toBe('Ship it');
  });

  // X2 (report 1.5 / S8): the row used to vanish without an objective, which
  // left the ONE state that needs the control with no control on it. It now
  // stands, says none is set, and offers the editor.
  it('without one, the row states the absence and offers the way to set it', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(container.querySelector('.objective-text')).toBeNull();
    expect(container.querySelector('.objective-none')!.textContent).toBe('none set');
    expect(screen.getByRole('button', { name: /Set an objective/i })).toBeInTheDocument();
  });

  it('editing it in place posts collabSetObjective for THIS collab', async () => {
    render(CollabPane);
    await post(state({ objective: 'Ship it' }));
    await fireEvent.click(screen.getByRole('button', { name: /Edit the objective/i }));
    const box = screen.getByRole('textbox', { name: /Collab objective/i });
    await fireEvent.input(box, { target: { value: 'Ship it by Friday' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(posts()).toContainEqual({ type: 'collabSetObjective', collabId: ID, objective: 'Ship it by Friday' });
  });

  it('an archived collab offers no objective editor — nothing more can be written to it', async () => {
    render(CollabPane);
    await post(state({ collab: { id: ID, title: 'Storm plan', createdAt: '', loopBreakerCap: null, archivedAt: '2026-08-06T10:00:00.000Z' }, objective: 'Ship it' }));
    expect(screen.queryByRole('button', { name: /the objective/i })).toBeNull();
  });
});

// X2 (report S2): a room created empty now opens with a guided card. The M3
// scar it is written against is a control DISABLED by state that had not
// arrived, so what is asserted at the pane level is the opposite claim: with
// the card on screen, every other control in the room still works. Each case
// checks the card is actually up first — otherwise it would pass vacuously the
// day the card stops rendering.
describe('CollabPane — the setup card blocks nothing', () => {
  const empty = () => state({ participants: [], agents: [], lead: null });
  const card = (c: HTMLElement) => c.querySelector('.sc-card');

  // The composer's `disabled` is asserted directly, not just inferred from a
  // post landing: fireEvent dispatches straight at the node, so a disabled box
  // would still "send" in jsdom and the gate would go unnoticed.
  it('the composer is not disabled, and still posts, in a room the card is guiding', async () => {
    const { container } = render(CollabPane);
    await post(empty());
    expect(card(container)).not.toBeNull();

    const box = container.querySelector('.input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    await fireEvent.input(box, { target: { value: 'anyone home' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts()).toContainEqual({ type: 'collabPost', collabId: ID, text: 'anyone home' });
  });

  it('the composer’s slash commands still run with the card up', async () => {
    const { container } = render(CollabPane);
    await post(empty());
    expect(card(container)).not.toBeNull();

    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/invite collab-falcon' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts()).toContainEqual({ type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-falcon' });
  });

  it('inviting from the card uses the same wire as every other invite path', async () => {
    const { container } = render(CollabPane);
    await post(empty());
    await post({ type: 'collabAgents', agents: [{ slug: 'collab-falcon', displayName: 'Falcon' }], glyphs: {} });
    expect(card(container)).not.toBeNull();

    await fireEvent.click(screen.getByRole('checkbox', { name: /Falcon/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
    expect(posts()).toContainEqual({ type: 'collabAddParticipant', collabId: ID, agentSlug: 'collab-falcon' });
  });

  it('dismissing the card leaves the room working exactly as before', async () => {
    const { container } = render(CollabPane);
    await post(empty());
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(card(container)).toBeNull();

    const box = container.querySelector('.input') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    await fireEvent.input(box, { target: { value: 'still here' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts()).toContainEqual({ type: 'collabPost', collabId: ID, text: 'still here' });
  });

  it('a room that already has a roster is never greeted with the card', async () => {
    const { container } = render(CollabPane);
    await post(state());
    expect(card(container)).toBeNull();
  });
});

// X2 (report 1.5 / S8): the lead used to be settable only with `/lead <slug>`
// in the composer. The star on every other chip is that control now.
describe('CollabPane — setting the lead from a chip', () => {
  it('posts collabSetLead for the agent whose star was clicked', async () => {
    render(CollabPane);
    await post(state({ lead: 'collab-crane' }));
    await fireEvent.click(screen.getByRole('button', { name: /Make Heron the lead/i }));
    expect(posts()).toContainEqual({ type: 'collabSetLead', collabId: ID, agentSlug: 'collab-heron' });
  });

  it('the same wire the /lead command uses — one path, one refusal surface', async () => {
    const { container } = render(CollabPane);
    await post(state({ lead: 'collab-crane' }));
    const box = container.querySelector('.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/lead collab-heron' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(posts().filter((p) => p.type === 'collabSetLead')).toEqual([
      { type: 'collabSetLead', collabId: ID, agentSlug: 'collab-heron' },
    ]);
  });
});

// The engine's `no-lead` notice (report S3/1.1). A post into a room with no
// lead is STORED and wakes nobody, so the room went silent with nothing on any
// surface saying why. The line below is the whole fix, and these are the two
// halves that matter: it appears when the engine said so, and it does not
// appear when the message actually reached someone.
describe('CollabPane — the no-lead notice', () => {
  const noticeText = (container: HTMLElement) => container.querySelector('.notice-banner')?.textContent ?? null;

  it('renders one line when a post reached nobody', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({ type: 'collabPosted', collabId: ID, seq: 1, notice: 'no-lead' });
    expect(noticeText(container)).toBe('Nobody is in this collab yet — invite an agent.');
  });

  it('renders nothing when the post reached a lead', async () => {
    const { container } = render(CollabPane);
    await post(state({ lead: 'collab-crane' }));
    await post({ type: 'collabPosted', collabId: ID, seq: 1 });
    expect(noticeText(container)).toBeNull();
  });

  it('drops another collab\u2019s notice — every reply is fanned out to every pane', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({ type: 'collabPosted', collabId: 'other-collab', seq: 1, notice: 'no-lead' });
    expect(noticeText(container)).toBeNull();
  });

  it('clears itself once a lead exists, instead of standing over a room that now has one', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await post({ type: 'collabPosted', collabId: ID, seq: 1, notice: 'no-lead' });
    expect(noticeText(container)).not.toBeNull();
    await post(state({ lead: 'collab-crane' }));
    expect(noticeText(container)).toBeNull();
  });
});

// W3 wave 3 (report 2.4 / 2.5) — SUPERVISION IN THE ROOM. Wave 1 put four
// per-member methods on the engine; these are the wires that reach them, and
// the three properties that make them safe to expose:
//
//   1. A per-agent stop posts the NARROW method and nothing else. The room's
//      own Stop (`collabStop`, which spends the whole hop budget) must not be
//      one keystroke away from it.
//   2. The outcome the engine answers with is rendered, honestly, on the chip
//      it is about — including the case where nothing was stopped at all.
//   3. The composer preview never becomes a step in sending.
describe('CollabPane — per-agent supervision', () => {
  const working = () => state({
    agents: [
      { slug: 'collab-crane', state: 'running' },
      { slug: 'collab-heron', state: 'queued' },
    ],
  });

  it('stops ONE agent — the narrow method, that slug, and no room-wide stop', async () => {
    render(CollabPane);
    await post(working());
    await fireEvent.click(screen.getByRole('button', { name: /Stop Heron/i }));

    const stops = posts().filter((p) => p.type === 'collabStopAgent' || p.type === 'collabStop');
    expect(stops).toEqual([{ type: 'collabStopAgent', collabId: ID, agentSlug: 'collab-heron' }]);
  });

  it('leaves the room running — every other chip keeps its ring', async () => {
    const { container } = render(CollabPane);
    await post(working());
    await fireEvent.click(screen.getByRole('button', { name: /Stop Heron/i }));
    expect(ringStates(container)).toEqual(['running', 'queued']);
  });

  it('reports what the stop actually did, on that chip', async () => {
    render(CollabPane);
    await post(working());
    await post({ type: 'collabStopAgentResult', collabId: ID, agentSlug: 'collab-heron', interrupted: false, dequeued: true });
    expect(screen.getByText(/Took Heron out of the queue/i)).toBeInTheDocument();
  });

  // The honest case. `collab_stop_agent` answers `interrupted:false` for an
  // agent running NESTED inside another's ask, and for one that was simply
  // idle — "Stopped." would be a claim the user cannot check.
  it('says an agent was already idle rather than claiming a stop', async () => {
    render(CollabPane);
    await post(working());
    await post({ type: 'collabStopAgentResult', collabId: ID, agentSlug: 'collab-crane', interrupted: false, dequeued: false });
    expect(screen.getByText(/already idle/i)).toBeInTheDocument();
  });

  it('drops a stop outcome answered for another collab', async () => {
    render(CollabPane);
    await post(working());
    await post({ type: 'collabStopAgentResult', collabId: 'collab-2', agentSlug: 'collab-crane', interrupted: true, dequeued: true });
    expect(screen.queryByText(/Stopped Crane/i)).toBeNull();
  });

  it('redirects one agent with the typed correction', async () => {
    render(CollabPane);
    await post(state());
    await fireEvent.click(screen.getByRole('button', { name: /Redirect Crane/i }));
    await fireEvent.input(screen.getByRole('textbox', { name: /Correction for Crane/i }), {
      target: { value: 'use the other table' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Send correction to Crane/i }));

    expect(posts().filter((p) => p.type === 'collabRedirect')).toEqual([
      { type: 'collabRedirect', collabId: ID, agentSlug: 'collab-crane', text: 'use the other table' },
    ]);
  });

  // F13: the wave-2 needs-a-model reason has to arrive somewhere a human is
  // already looking, not behind a 14px badge.
  it('shows an unpinned agent failing in the room, with the pick-a-model text', async () => {
    const { container } = render(CollabPane);
    await post(state({
      agents: [
        { slug: 'collab-crane', state: 'idle', lastError: '@collab-crane has no model — pick one in its agent definition' },
        { slug: 'collab-heron', state: 'idle' },
      ],
    }));
    expect(ringStates(container)).toEqual(['error', 'idle']);
    expect(container.querySelector('.cs-failure')).not.toBeNull();
    expect(container.textContent ?? '').toContain('pick one in its agent definition');
  });
});

describe('CollabPane — a verdict on a finished task', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: 'clbt_1', title: 'the migration', owner: 'collab-crane', state: 'done',
    createdBy: 'collab-heron', result: 'built', note: null, originSeq: 3,
    createdAt: 'x', updatedAt: 'y', ...over,
  });
  const board = () => state({
    messages: [msg(4, { kind: 'task_done', taskId: 'clbt_1', text: 'built the migration' })],
    tasks: [task()],
  });

  it('approves the task from the room row', async () => {
    render(CollabPane);
    await post(board());
    await fireEvent.click(screen.getByRole('button', { name: /Approve/i }));
    expect(posts().filter((p) => p.type === 'collabReview')).toEqual([
      { type: 'collabReview', collabId: ID, taskId: 'clbt_1', verdict: 'approve' },
    ]);
  });

  it('sends a task back with the reason the owner will read', async () => {
    render(CollabPane);
    await post(board());
    await fireEvent.click(screen.getByRole('button', { name: /Send back/i }));
    await fireEvent.input(screen.getByLabelText(/Why is it going back/i), { target: { value: 'the index is missing' } });
    await fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    expect(posts().filter((p) => p.type === 'collabReview')).toEqual([
      { type: 'collabReview', collabId: ID, taskId: 'clbt_1', verdict: 'reject', note: 'the index is missing' },
    ]);
  });

  // The engine reopens the task and writes the note into the row every agent
  // then reads. This is the RENDERED truth of that, on the next poll.
  it('shows the reopened row with the note, and drops the verdict controls', async () => {
    const { container } = render(CollabPane);
    await post(board());
    await post(state({
      messages: [
        msg(4, { kind: 'task_done', taskId: 'clbt_1', text: 'built the migration' }),
        msg(5, { authorId: 'user', authorKind: 'human', kind: 'task_reopen', taskId: 'clbt_1', text: 'reopened task: the migration — the index is missing' }),
      ],
      tasks: [task({ state: 'claimed', note: 'the index is missing' })],
    }));
    expect(container.textContent ?? '').toContain('the index is missing');
    expect(container.querySelector('.cr-verdict')).toBeNull();
  });
});

describe('CollabPane — the composer preview (C14)', () => {
  it('asks who a draft would wake, and not on the send path', async () => {
    vi.useFakeTimers();
    render(CollabPane);
    await post(state());
    const boxEl = screen.getByRole('textbox');
    await fireEvent.input(boxEl, { target: { value: '@collab-heron take it' } });

    // Nothing yet: the debounce has not fired, and a send would not wait for it.
    expect(posts().filter((p) => p.type === 'collabPreview')).toEqual([]);
    vi.advanceTimersByTime(400);
    await tick();
    expect(posts().filter((p) => p.type === 'collabPreview')).toEqual([
      { type: 'collabPreview', collabId: ID, mentions: ['collab-heron'] },
    ]);
    vi.useRealTimers();
  });

  it('posts the message even while a preview is still pending', async () => {
    vi.useFakeTimers();
    render(CollabPane);
    await post(state());
    const boxEl = screen.getByRole('textbox');
    await fireEvent.input(boxEl, { target: { value: '@collab-heron take it' } });
    await fireEvent.keyDown(boxEl, { key: 'Enter' });

    expect(posts().filter((p) => p.type === 'collabPost')).toEqual([
      { type: 'collabPost', collabId: ID, text: '@collab-heron take it', mentions: ['collab-heron'] },
    ]);
    vi.useRealTimers();
  });

  it('renders the answer under the box', async () => {
    render(CollabPane);
    await post(state());
    await post({ type: 'collabPreviewData', collabId: ID, wake: ['collab-crane', 'collab-heron'] });
    expect(screen.getByText('Will wake: Crane, Heron')).toBeInTheDocument();
  });
});
