// bashCard.test.ts — the rewritten BashCard (IN/OUT rails against the TS
// engine's real bash contract) plus ToolCard's shell dispatch + honest exit
// icon. jsdom proves structure and the parse rules, not looks — the visual
// verdict stays with UAT.

import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import BashCard from './BashCard.svelte';
import ToolCard from '../ToolCard.svelte';

describe('BashCard — IN/OUT rails', () => {
  it('shows the command under IN and the output under OUT', () => {
    render(BashCard, {
      result: 'PASS 12 tests',
      title: 'npm test',
      status: 'completed',
      shell: { command: 'npm test', exit: 0 },
    });
    expect(screen.getByText('IN')).toBeInTheDocument();
    expect(screen.getByText('OUT')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('PASS 12 tests')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
  });

  it('falls back to the title as the command when shell facts are absent', () => {
    render(BashCard, { result: 'hi', title: 'echo hi', status: 'completed' });
    expect(screen.getByText('echo hi')).toBeInTheDocument();
    expect(screen.queryByText(/^exit/)).toBeNull();
  });

  it('shows a red exit chip on non-zero and "killed" on exit null', () => {
    render(BashCard, { result: 'err', title: 'a', status: 'completed', shell: { exit: 2 } });
    expect(screen.getByText('exit 2')).toBeInTheDocument();
    render(BashCard, { result: '', title: 'b', status: 'completed', shell: { exit: null } });
    expect(screen.getByText('killed')).toBeInTheDocument();
  });

  it('strips the truncation banner into a click-to-open chip', () => {
    const result = '...output truncated...\n\nFull output saved to: C:\\tmp\\full.txt\n\ntail of output';
    render(BashCard, { result, title: 'big', status: 'completed', shell: { exit: 0, truncated: true } });
    expect(screen.getByText('tail of output')).toBeInTheDocument();
    expect(screen.queryByText(/Full output saved to/)).toBeNull();
    const chip = screen.getByText('truncated — open full output');
    expect(chip.getAttribute('title')).toContain('C:\\tmp\\full.txt');
  });

  it('splits the <shell_metadata> tail into a footnote', () => {
    const result = 'partial\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 2000 ms.\n</shell_metadata>';
    render(BashCard, { result, title: 't', status: 'completed', shell: { exit: null } });
    expect(screen.getByText('partial')).toBeInTheDocument();
    expect(screen.getByText(/terminated command after exceeding timeout/)).toBeInTheDocument();
    expect(screen.queryByText(/<shell_metadata>/)).toBeNull();
  });

  it('renders the engine\'s "(no output)" as the empty state, not as output', () => {
    render(BashCard, { result: '(no output)', title: 'true', status: 'completed', shell: { exit: 0 } });
    expect(screen.getByText('(no output)')).toBeInTheDocument();
  });

  it('shows running… and "no output yet" while the command runs', () => {
    render(BashCard, { result: '', title: 'sleep 5', status: 'in_progress' });
    expect(screen.getByText('running…')).toBeInTheDocument();
    expect(screen.getByText('no output yet')).toBeInTheDocument();
  });

  it('shows the cwd and timeout chips off the IN facts', () => {
    render(BashCard, {
      result: 'ok',
      title: 'bun test',
      status: 'completed',
      shell: { command: 'bun test', cwd: 'C:\\repo\\pkg', timeout: 300000, exit: 0 },
    });
    expect(screen.getByText('C:\\repo\\pkg')).toBeInTheDocument();
    expect(screen.getByText('timeout 300s')).toBeInTheDocument();
  });
});

// The 30s Kill button shipped in 0.3.58 and then never appeared on a live
// running bash card. The gate was not the timer and not the status: ToolCard
// mounts the card BODY only `{#if expanded}`, and a card starts collapsed, so
// every control rendered inside BashCard was absent from the DOM until someone
// clicked. Every test of it had rendered BashCard directly and so tested the
// one arrangement the user never sees.
//
// These mount ToolCard in its DEFAULT state — no expand click anywhere — which
// is the only arrangement that can prove the control is reachable.
describe('Kill button — reachable on a COLLAPSED running bash card', () => {
  const runningCard = (over: Record<string, unknown> = {}) => ({
    title: 'npm run dev', kind: 'execute', toolName: 'bash', status: 'in_progress',
    result: '', sessionId: 'ses_1', startedAt: Date.now() - 45_000, ...over,
  });

  it('offers Kill without the card ever being expanded', () => {
    render(ToolCard, runningCard());
    // No fireEvent.click on the header. If this needs one, the button is not
    // where a user watching a wedged command can find it.
    expect(screen.getByText('45s elapsed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument();
  });

  // A finished sub-agent's transcript replays its cards, and the replay stamps
  // them when it REBUILDS them — so "elapsed" there is measured from now and
  // reads 0s for a command that ran an hour ago, while "running for a while"
  // claims a present tense the card does not have. Both are suppressed in
  // read-only. Without this the transcript states two things that are false.
  it('states no liveness at all in a read-only transcript', () => {
    render(ToolCard, runningCard({ readOnly: true }));
    expect(screen.queryByText('45s elapsed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
    // The card itself must still be there — read-only hides the CLAIMS, not the
    // command. A transcript that drops the card renders nothing worth reading.
    expect(screen.getByText('npm run dev')).toBeInTheDocument();
  });

  // The two liveness readings live behind SEPARATE gates and only one of them
  // is reachable at a time — past the stuck threshold the shell strip's own
  // "Ns elapsed" is suppressed in favour of the stuck strip's. So a card UNDER
  // the threshold is the only way to exercise the other gate; without this case
  // the shell-strip gate could be deleted with the suite still green.
  it('states no liveness on a YOUNG read-only card either', () => {
    const young = { startedAt: Date.now() - 5_000, shell: { command: 'npm run dev', state: 'foreground', exit: null } };
    render(ToolCard, runningCard({ ...young, readOnly: true }));
    expect(screen.queryByText('5s elapsed')).toBeNull();
  });

  it('appears once a card that started ordinary crosses 30s on the clock', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      render(ToolCard, runningCard({ startedAt: started }));
      expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
      // The card was mounted fresh and young; only the passage of time may
      // reveal the control.
      await vi.advanceTimersByTimeAsync(31_000);
      expect(screen.getByRole('button', { name: 'Kill' })).toBeInTheDocument();
      expect(screen.getByText(/^3[0-9]s elapsed$/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing about age on a command that has only just started', () => {
    render(ToolCard, runningCard({ startedAt: Date.now() - 5_000 }));
    expect(screen.getByText(/5s elapsed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
  });

  it('never offers Kill on a command that already finished', () => {
    render(ToolCard, runningCard({ status: 'completed', shell: { exit: 0 }, startedAt: Date.now() - 600_000 }));
    expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
    expect(screen.getByText(/600s elapsed/)).toBeInTheDocument();
  });

  it('never offers Kill on a non-shell tool, however long it has been going', () => {
    render(ToolCard, runningCard({ kind: 'read', toolName: 'read', title: 'read notes.md' }));
    expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
  });

  it('Kill posts the extension\'s existing session cancel for THIS session', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ToolCard, runningCard({ sessionId: 'ses_stuck', startedAt: Date.now() - 120_000 }));
    await fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'cancel', sessionId: 'ses_stuck' });
  });
});

describe('Shell observability — collapsed running card', () => {
  it('shows foreground state and elapsed time immediately', () => {
    render(ToolCard, {
      title: 'Run tests', kind: 'execute', toolName: 'bash', status: 'in_progress', result: '',
      startedAt: Date.now() - 5_000, sessionId: 'ses_1', shell: { command: 'npm test', state: 'foreground' },
    });
    expect(screen.getByText('foreground')).toBeInTheDocument();
    expect(screen.getByText(/5s elapsed/)).toBeInTheDocument();
  });

  it('shows last-output age only after output exists', () => {
    render(ToolCard, {
      title: 'Serve app', kind: 'execute', toolName: 'bash', status: 'in_progress', result: 'ready',
      startedAt: Date.now() - 10_000,
      shell: { command: 'npm run dev', state: 'background', background: true, jobId: 'job_1', lastOutputAt: Date.now() - 3_000 },
    });
    expect(screen.getByText('background')).toBeInTheDocument();
    expect(screen.getByText(/output 3s ago/)).toBeInTheDocument();
  });

  it('uses Stop with the job id for background work and keeps Kill for foreground work', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const view = render(ToolCard, {
      title: 'Serve app', kind: 'execute', toolName: 'bash', status: 'in_progress', result: '',
      startedAt: Date.now() - 1_000, sessionId: 'ses_1',
      shell: { command: 'npm run dev', state: 'background', background: true, jobId: 'job_42' },
    });
    expect(screen.queryByRole('button', { name: 'Kill' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'stopBackgroundShell', sessionId: 'ses_1', jobId: 'job_42',
    });
    view.unmount();
  });

  it('keeps final state, elapsed time, and output age visible after completion', () => {
    const now = Date.now();
    render(ToolCard, {
      title: 'Build package', kind: 'execute', toolName: 'bash', status: 'completed', result: 'done',
      startedAt: now - 10_000,
      shell: { command: 'npm run build', state: 'promoted', background: true, jobId: 'job_9', lastOutputAt: now - 2_000 },
    });
    expect(screen.getByText('promoted')).toBeInTheDocument();
    expect(screen.getByText(/10s elapsed/)).toBeInTheDocument();
    expect(screen.getByText(/output 2s ago/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});

// The card's Kill button and the extension host agree on ONE string. Nothing in
// the type system spans that gap: rename the host's case and the button keeps
// posting happily into a handler that no longer exists, which is a Kill that
// silently does nothing on a command the user is watching hang.
describe('Kill wiring — the message the card posts is one the host still handles', () => {
  const panel = readFileSync(join(__dirname, '../../../../src/dashboard/DashboardPanel.ts'), 'utf-8');

  it('DashboardPanel still routes a cancel message to the ACP session cancel', () => {
    expect(panel).toMatch(/case 'cancel': \{/);
    expect(panel).toMatch(/session\.client\.cancel\(\)/);
  });

  it('ToolCard posts exactly that message shape', () => {
    const card = readFileSync(join(__dirname, '../ToolCard.svelte'), 'utf-8');
    expect(card).toMatch(/postMessage\(\{ type: 'cancel', sessionId \}\)/);
  });

  // The real render path is the only place these two props are supplied.
  // Without them the control is dead on every real card while every test above
  // still passes, because a test can always hand a component props the app
  // never sends.
  //
  // That path is now TWO hops: the message loop moved to ChatTranscript.svelte
  // so a read-only transcript can share the renderer, and ChatPane feeds it the
  // session id. Both hops are asserted — checking only the leaf would let the
  // pane quietly stop passing `sessionId` with the suite still green, which is
  // the same dead-control failure this guard exists to catch.
  it('the real render path still feeds ToolCard the session and the start stamp', () => {
    const transcript = readFileSync(join(__dirname, '../ChatTranscript.svelte'), 'utf-8');
    expect(transcript).toMatch(/sessionId=\{sessionId\} startedAt=\{msg\.timestamp\}/);
    const pane = readFileSync(join(__dirname, '../../panes/ChatPane.svelte'), 'utf-8');
    expect(pane).toMatch(/sessionId=\{cellSession\.id\}/);
  });
});

describe('ToolCard — shell dispatch + honest exit', () => {
  it('dispatches kind "execute" to the IN/OUT card even without a tool name', async () => {
    render(ToolCard, { title: 'git status', kind: 'execute', toolName: '', status: 'completed', result: 'clean' });
    // The body renders only once expanded — click the header first.
    await fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('IN')).toBeInTheDocument();
    expect(screen.getByText('OUT')).toBeInTheDocument();
  });

  it('renders ✗ (not ✓) on a completed bash call whose exit is non-zero', () => {
    render(ToolCard, {
      title: 'npm test', kind: 'execute', toolName: 'bash', status: 'completed',
      result: 'FAIL', shell: { exit: 1 },
    });
    const cross = screen.getByTitle('exit 1');
    expect(cross.textContent).toBe('✗');
    expect(screen.queryByText('✓')).toBeNull();
  });

  it('keeps the ✓ on exit 0', () => {
    render(ToolCard, {
      title: 'npm test', kind: 'execute', toolName: 'bash', status: 'completed',
      result: 'PASS', shell: { exit: 0 },
    });
    expect(screen.getByText('✓')).toBeInTheDocument();
  });
});
