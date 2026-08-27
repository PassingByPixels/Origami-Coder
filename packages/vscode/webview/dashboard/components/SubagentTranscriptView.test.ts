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

  it('closes on the header control and posts nothing while doing it', async () => {
    const onClose = vi.fn();
    const { container } = render(SubagentTranscriptView, { sessionId: CHILD, title: 't', onClose });
    post().mockReset();
    await fireEvent.click(container.querySelector('.sat-close') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
    expect(post()).not.toHaveBeenCalled();
  });
});
