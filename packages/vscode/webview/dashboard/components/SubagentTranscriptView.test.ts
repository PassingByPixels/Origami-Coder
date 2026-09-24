// SubagentTranscriptView.test.ts — the read-only sub-agent transcript, end to
// end through the wire it actually uses.
//
// What it must get right, and what used to be impossible to check: the panel
// asks for ONE child, ignores a reply for any other, and draws the answer with
// the CHAT's renderer rather than a lookalike — so a tool call the sub-agent
// made shows up as the same card the parent chat would have drawn. And it must
// draw the read-only version of it: the rewind control that rolls the working
// tree back has no business on a transcript from an hour ago.
//
// jsdom has no layout and this suite loads no <style>, so nothing here asserts
// size, overlap or visibility — only which nodes exist and what they post.

import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentTranscriptView from './SubagentTranscriptView.svelte';

const CHILD = 'ses_child_1';
const post = () => globalThis.__vscodeApiMock.postMessage;
const reply = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', { data }));

/** The engine's projection as it reaches the webview: replay-log rows. */
const ENTRIES = [
  { kind: 'user', text: 'audit the bundle', timestamp: 0 },
  {
    kind: 'tool', text: 'src/foo.ts', timestamp: 0,
    tool: {
      call: { toolCallId: 'c1', title: 'src/foo.ts', kind: 'edit', status: 'completed', toolName: 'apply_patch', path: 'src/foo.ts' },
      result: { toolCallId: 'c1', status: 'completed', content: 'edited 1 hunk', title: 'src/foo.ts', path: 'src/foo.ts' },
    },
  },
  { kind: 'agent', text: 'done — see src/foo.ts:12', timestamp: 0 },
];

/** A child that stopped with a background shell still registered — the one
 *  shape in this panel that renders a host-facing control at all. */
const BACKGROUND_JOB = {
  kind: 'tool', text: 'bash: npm run watch', timestamp: 0,
  tool: {
    call: { toolCallId: 'c9', title: 'bash: npm run watch', kind: 'bash', status: 'in_progress', toolName: 'bash', rawInput: { command: 'npm run watch' } },
    result: { toolCallId: 'c9', status: 'in_progress', content: '', toolName: 'bash', rawOutputMeta: { state: 'background', jobId: 'job-7' } },
  },
};

function mount() {
  const { container } = render(SubagentTranscriptView, {
    sessionId: CHILD, title: 'task: audit the bundle', onClose: () => {},
  });
  return container;
}

describe('SubagentTranscriptView — asks for one child and draws its chat', () => {
  beforeEach(() => post().mockReset());

  it('requests the CHILD session on mount', () => {
    mount();
    expect(post()).toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: CHILD });
  });

  it('renders the reply with the chat’s own row components', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
    await tick();
    // The tool step is a real ToolCard, not a line of log text — the whole
    // point of the change ("instead of a log.txt").
    expect(c.querySelector('.tool-card')).not.toBeNull();
    expect(c.querySelector('.row.user')?.textContent).toContain('audit the bundle');
    expect(c.querySelector('.row.agent')?.textContent).toContain('done');
  });

  // t-gvz8t0. The child's thought reaches this panel as a `thought` row, and it
  // must be drawn by the main chat's own ThoughtPill — a collapsed block — and
  // never as the child's reply. Before this the engine dropped reasoning
  // entirely, so a child that thought for two minutes then answered had a
  // transcript with the two minutes missing.
  it('draws a child’s THOUGHT as the chat’s collapsed thought block, never as its reply', async () => {
    const c = mount();
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false,
      entries: [
        { kind: 'thought', text: 'weighing two approaches', timestamp: 0 },
        { kind: 'agent', text: 'done — see src/foo.ts:12', timestamp: 0 },
      ],
    });
    await tick();

    const pill = c.querySelector('details.thought-block');
    expect(pill, 'the thought must render as ThoughtPill').not.toBeNull();
    expect(pill!.querySelector('.thought-text')?.textContent).toBe('weighing two approaches');
    // Collapsed, like every thought block in the chat.
    expect((pill as HTMLDetailsElement).open).toBe(false);
    // ...and the agent row beside it holds ONLY the child's real answer.
    const agent = c.querySelector('.row.agent')?.textContent ?? '';
    expect(agent).toContain('done');
    expect(agent).not.toContain('weighing two approaches');
  });

  it('IGNORES a reply for a different child', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: 'ses_someone_else', found: true, entries: ENTRIES });
    await tick();
    // Still the loading state: a stale or concurrent answer must not overwrite
    // the panel the user is actually looking at.
    expect(c.querySelector('.tool-card')).toBeNull();
    expect(c.textContent).toContain('Loading transcript');
  });

  it('says a vanished child is GONE, not empty', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: false, running: false, truncated: false, entries: [] });
    await tick();
    expect(c.textContent).toContain('no longer in the store');
  });

  it('distinguishes an empty child from a missing one', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: [] });
    await tick();
    expect(c.textContent).toContain('has not written anything yet');
    // A partial transcript must never LOOK finished.
    expect(c.textContent).toContain('still running');
  });

  it('passes READ-ONLY all the way down to the tool cards', async () => {
    // Proven on a control that can actually appear here, and only here.
    // A rewind button needs an `engineMsgId`, which the replay-log path never
    // carries, so asserting ITS absence would pass with `readOnly` deleted —
    // ChatTranscript.test.ts owns that one. This is a child that died with a
    // BACKGROUND shell still registered: the card comes back unsettled, and
    // the live chat renders Stop on it, which kills a job by id in whatever
    // session is running now.
    const c = mount();
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false,
      entries: [BACKGROUND_JOB],
    });
    await tick();
    expect(c.querySelector('.tool-card'), 'the card renders').not.toBeNull();
    expect(c.querySelector('.tool-stuck-kill'), 'Stop kills a job in the LIVE session').toBeNull();
  });

  it('still opens a file the sub-agent touched', async () => {
    const c = mount();
    post().mockReset();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
    await tick();
    const link = c.querySelector('a.file-link') as HTMLElement;
    await fireEvent.click(link);
    expect(post()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'src/foo.ts', line: 12 });
  });

  it('re-reads on demand — the ⟳ asks for the SAME child again', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: [] });
    await tick();
    post().mockReset();
    await fireEvent.click(c.querySelector('.sat-refresh') as HTMLElement);
    expect(post()).toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: CHILD });
  });

  it('a refresh REPLACES what is drawn — a running child grows between reads', async () => {
    // The whole point for a live child: the first read can be empty (spawned,
    // nothing written back yet) and the next one carries real work.
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: [] });
    await tick();
    expect(c.textContent).toContain('has not written anything yet');
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: ENTRIES });
    await tick();
    expect(c.querySelector('.tool-card'), 'the newer read is drawn').not.toBeNull();
    expect(c.textContent).not.toContain('has not written anything yet');
  });

  it('POLLS while the child is unsettled, and stops once it settles', async () => {
    // The half a manual button cannot cover: a run watched for minutes must
    // move on its own. And the timer must be a consequence of `running`, not a
    // standing interval per panel the user ever opened.
    vi.useFakeTimers();
    try {
      mount();
      reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: [] });
      await tick();
      post().mockReset();
      await vi.advanceTimersByTimeAsync(9000);
      const whileRunning = post().mock.calls.length;
      expect(whileRunning, 'a live child is re-read without being asked').toBeGreaterThan(0);

      reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
      await tick();
      post().mockReset();
      await vi.advanceTimersByTimeAsync(30000);
      expect(post(), 'a settled transcript cannot change — no timer over it').not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // t-tydjkm. A reply that never arrives (dropped on the way, or an engine that
  // never answers) must not leave the panel on "Loading transcript…" for ever.
  it('leaves the loading state with a visible error when no reply ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const c = mount();
      await vi.advanceTimersByTimeAsync(5000);
      expect(c.textContent, 'a slow read is still allowed to be loading').toContain('Loading transcript');
      await vi.advanceTimersByTimeAsync(30000);
      expect(c.textContent).not.toContain('Loading transcript');
      expect(c.querySelector('.sat-empty')?.textContent).toMatch(/no answer/i);
      // A late reply still draws: the timeout is a state, not a closed door.
      reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
      await tick();
      expect(c.querySelector('.tool-card')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lost earlier-block reply frees the control again instead of spinning for ever', async () => {
    vi.useFakeTimers();
    try {
      const c = mount();
      reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES, hasMore: true, cursor: 'cur_1' });
      await tick();
      const button = () => c.querySelector('.sat-earlier button') as HTMLButtonElement;
      await fireEvent.click(button());
      expect(button().disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(35000);
      expect(button().disabled).toBe(false);
      expect(c.querySelector('.tool-card'), 'rows on screen stay on screen').not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on the header control and posts nothing while doing it', async () => {
    const onClose = vi.fn();
    const { container } = render(SubagentTranscriptView, { sessionId: CHILD, title: 't', onClose });
    post().mockReset();
    await fireEvent.click(container.querySelector('.sat-close') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
    expect(post()).not.toHaveBeenCalled();
  });
});

// t-krxap7 — selective loading. The leaf's own rules are subagentPaging.test.ts;
// this is the wiring: does the panel SEND what the rules allow, and does an
// earlier block end up ABOVE the rows already on screen rather than below them.
describe('SubagentTranscriptView — load earlier steps', () => {
  beforeEach(() => post().mockReset());

  const older = [{ kind: 'user', text: 'the brief', timestamp: 0 }];

  /** The newest page, with one older block behind it. */
  async function opened(container: HTMLElement) {
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false,
      truncated: false, entries: ENTRIES, hasMore: true, cursor: 'cur_1',
    });
    await tick();
    return container;
  }

  it('offers no control when the whole transcript arrived in one page', async () => {
    const container = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES, hasMore: false });
    await tick();
    expect(container.querySelector('.sat-earlier')).toBeNull();
  });

  it('asks for the previous block with the cursor the engine gave', async () => {
    const container = await opened(mount());
    post().mockReset();

    await fireEvent.click(container.querySelector('.sat-earlier button') as HTMLElement);

    expect(post()).toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: CHILD, before: 'cur_1' });
  });

  // The guard that matters: one click, one request, even when a second trigger
  // (the scroll-top observer) fires before the reply lands.
  it('sends ONE request when the control is activated twice before the reply', async () => {
    const container = await opened(mount());
    post().mockReset();
    const button = container.querySelector('.sat-earlier button') as HTMLElement;

    await fireEvent.click(button);
    await fireEvent.click(button);

    expect(post()).toHaveBeenCalledTimes(1);
  });

  it('PREPENDS the earlier block and leaves the loaded rows in place', async () => {
    const container = await opened(mount());
    // Read the SCROLLER, not the panel: the header repeats the title, and an
    // assertion over the whole panel would match that instead of a row.
    const body = () => (container.querySelector('.sat-body') as HTMLElement).textContent ?? '';
    expect(body()).toContain('audit the bundle');

    await fireEvent.click(container.querySelector('.sat-earlier button') as HTMLElement);
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false,
      truncated: false, entries: older, before: 'cur_1', hasMore: false,
    });
    await tick();

    const after = body();
    expect(after).toContain('the brief');
    expect(after).toContain('audit the bundle');
    // Above, not below: the earlier block is older than everything on screen.
    expect(after.indexOf('the brief')).toBeLessThan(after.indexOf('audit the bundle'));
    // Head reached — the control is withdrawn rather than left offering nothing.
    expect(container.querySelector('.sat-earlier')).toBeNull();
  });

  it('draws a repeated reply for a block already on screen only once', async () => {
    const container = await opened(mount());
    await fireEvent.click(container.querySelector('.sat-earlier button') as HTMLElement);
    const page = {
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false,
      truncated: false, entries: older, before: 'cur_1', hasMore: true, cursor: 'cur_2',
    };

    reply(page);
    await tick();
    reply(page);
    await tick();

    const text = (container.querySelector('.sat-body') as HTMLElement).textContent ?? '';
    expect(text.split('the brief').length - 1).toBe(1);
  });

  it('stops the running-child poll once the reader has paged back', async () => {
    vi.useFakeTimers();
    try {
      const container = mount();
      reply({
        type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true,
        truncated: false, entries: ENTRIES, hasMore: true, cursor: 'cur_1',
      });
      await tick();
      await fireEvent.click(container.querySelector('.sat-earlier button') as HTMLElement);
      reply({
        type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false,
        truncated: false, entries: older, before: 'cur_1', hasMore: false,
      });
      await tick();
      post().mockReset();

      await vi.advanceTimersByTimeAsync(30000);

      expect(post(), 'a poll here would rebuild from the newest page and drop the history').not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// t-q90v2v — chat-pane parity: scroll-anchor pill, streaming colour, and the
// A2 empty-state gate, reused from the same leaves the main chat pane wires.
describe('SubagentTranscriptView — A2 parity', () => {
  beforeEach(() => post().mockReset());

  function scrollAway(el: HTMLElement) {
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 2000, writable: true, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, writable: true, configurable: true });
    fireEvent.scroll(el);
  }

  // Rebuilt (not appended) on each read, like a real poll: the growth after
  // scrolling away is a SECOND reply carrying one more row than the first.
  const GROWN = [...ENTRIES, { kind: 'agent', text: 'follow-up note', timestamp: 0 }];

  it('shows the scroll-anchor pill with per-family counts once the reader scrolls away', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
    await tick();
    expect(c.querySelector('.anchor-pill')).toBeNull();

    scrollAway(c.querySelector('.sat-body') as HTMLElement);
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: GROWN });
    await tick();
    const pill = c.querySelector('.anchor-pill');
    expect(pill, 'pill shows once new rows arrived after the reader scrolled away').not.toBeNull();
    expect(pill?.textContent).toContain('message');
  });

  it('jumping the pill re-sticks and clears it, the same click behaviour as the main chat', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
    await tick();
    scrollAway(c.querySelector('.sat-body') as HTMLElement);
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: GROWN });
    await tick();
    const jump = c.querySelector('.anchor-pill') as HTMLElement;
    expect(jump).not.toBeNull();
    await fireEvent.click(jump);
    expect(c.querySelector('.anchor-pill')).toBeNull();
  });

  it('colours the newest reply while the child is still running, same as the live main chat', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: true, truncated: false, entries: ENTRIES });
    await tick();
    expect(c.querySelector('.row.agent.is-live')).not.toBeNull();
  });

  it('a settled transcript never shows a live-coloured row', async () => {
    const c = mount();
    reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries: ENTRIES });
    await tick();
    expect(c.querySelector('.row.agent.is-live')).toBeNull();
  });

  // The acceptance case: only tool cards, no user/agent prose — must read as
  // content, never as the empty state (chatEmptyGate.ts's hasConversation).
  it('a transcript holding only tool cards shows no empty state', async () => {
    const c = mount();
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false,
      entries: [ENTRIES[1]], // the tool step alone
    });
    await tick();
    expect(c.querySelector('.tool-card')).not.toBeNull();
    expect(c.textContent).not.toContain('has not written anything yet');
  });

  // The other half of the same gate: scaffold rows alone (no real content)
  // must still show the empty state, which a bare `messages.length === 0`
  // check would miss.
  it('scaffold-only rows (no real content) still show the empty state', async () => {
    const c = mount();
    reply({
      type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false,
      entries: [{ kind: 'system', text: 'session bookkeeping', timestamp: 0 }],
    });
    await tick();
    expect(c.textContent).toContain('has not written anything yet');
  });
});
