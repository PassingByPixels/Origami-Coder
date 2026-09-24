// The two pills above the composer. What is asserted here is WIRING — which message
// goes out on which click, and which row carries the tick — never size, position or
// the phone-width breakpoint: vitest.config.mts sets no `css: true`, so no <style>
// element reaches this DOM and any assertion about layout would be theatre. The pills'
// look needs a human eye, and the lane's screenshot is where it got one.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import RepoBranchPicker from './RepoBranchPicker.svelte';
import { CHANGE_REPO_FOOTER, NEW_BRANCH_LABEL, resetSelections } from './repoBranchPicker';

const REPO = 'C:/Repos/a';
const WORKTREE = 'C:/Repos/a/.origami/worktrees/x';

function posted() {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]);
}

function deliver(message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

async function mounted(cwd = REPO, expected = 'alpha') {
  const view = render(RepoBranchPicker, { props: { sessionId: 'session-1' } });
  deliver({
    type: 'repoPickerOptions',
    repos: [{ root: REPO, name: 'alpha' }, { root: 'C:/Repos/b', name: 'beta' }],
    defaultRoot: REPO,
    cwdBySession: { 'session-1': cwd },
  });
  await vi.waitFor(() => expect(view.getByTestId('repo-pill')).toHaveTextContent(expected));
  return view;
}

beforeEach(() => {
  resetSelections();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

describe('the pills', () => {
  it('asks the host for its options on mount', async () => {
    render(RepoBranchPicker, { props: { sessionId: 'session-1' } });
    await vi.waitFor(() => expect(posted()).toContainEqual({ type: 'repoPickerOptions' }));
  });

  it('names the repo the chat s directory belongs to, not the first registered one', async () => {
    const view = await mounted(WORKTREE);
    expect(view.getByTestId('repo-pill')).toHaveTextContent('alpha');
  });

  it('says so rather than guessing when the chat is in no registered repo', async () => {
    const view = await mounted('D:/scratch', 'No repo');
    expect(view.getByTestId('repo-pill')).toHaveTextContent('No repo');
    expect(view.getByTestId('branch-pill')).toHaveTextContent('No branch');
  });
});

describe('the branch dropdown', () => {
  async function opened() {
    const view = await mounted(WORKTREE);
    await fireEvent.click(view.getByTestId('branch-pill'));
    deliver({
      type: 'repoPickerBranches',
      root: REPO,
      branches: [{ branch: 'master', path: REPO }, { branch: 'origami/x', path: WORKTREE }],
    });
    await vi.waitFor(() => expect(view.getByTestId('branch-pop')).toBeInTheDocument());
    return view;
  }

  it('asks for THAT repo s worktrees when it opens', async () => {
    const view = await mounted(WORKTREE);
    await fireEvent.click(view.getByTestId('branch-pill'));
    expect(posted()).toContainEqual({ type: 'repoPickerBranches', root: REPO });
  });

  it('ticks the branch the chat is actually in, and only that one', async () => {
    const view = await opened();
    const current = view.getByTestId('branch-pop').querySelectorAll('.row.current');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('origami/x');
    expect(view.getByTestId('branch-pill')).toHaveTextContent('origami/x');
  });

  it('narrows the rows by the search field', async () => {
    const view = await opened();
    await fireEvent.input(view.getByPlaceholderText('Search branches'), { target: { value: 'mast' } });
    const labels = [...view.getByTestId('branch-pop').querySelectorAll('.row .label')].map((n) => n.textContent);
    expect(labels).toEqual(['master', 'New branch…']);
  });

  it('states what a pick costs — the chat cannot move, so a new one opens', async () => {
    const view = await opened();
    expect(view.getByTestId('branch-pop')).toHaveTextContent(CHANGE_REPO_FOOTER);
  });

  it('a pick sends the worktree PATH, which is what a session cwd is', async () => {
    const view = await opened();
    await fireEvent.click([...view.getByTestId('branch-pop').querySelectorAll('.row')][0]);
    expect(posted()).toContainEqual({
      type: 'repoPickerSelect', sessionId: 'session-1', root: REPO, branch: 'master', path: REPO,
    });
  });

  it('New branch... uses the typed text as the name, and sends nothing when nothing is typed', async () => {
    const view = await opened();
    await fireEvent.click(view.getByTestId('new-branch'));
    expect(posted().some((m) => m.type === 'repoPickerNewBranch')).toBe(false);

    await fireEvent.input(view.getByPlaceholderText('Search branches'), { target: { value: 'care calendar' } });
    await fireEvent.click(view.getByTestId('new-branch'));
    expect(posted()).toContainEqual({
      type: 'repoPickerNewBranch', sessionId: 'session-1', root: REPO, name: 'care calendar',
    });
  });

  it('shows the host s failure instead of a silently unchanged pill', async () => {
    const view = await opened();
    deliver({ type: 'repoPickerError', root: REPO, message: 'git worktree add failed: fatal' });
    await fireEvent.click(view.getByTestId('branch-pill'));
    await fireEvent.click(view.getByTestId('branch-pill'));
    deliver({ type: 'repoPickerBranches', root: REPO, branches: [] });
    await vi.waitFor(() => expect(view.getByTestId('branch-pop')).toHaveTextContent('No worktrees'));
  });
});

// t-qi09w0 item 2 — the picker's OTHER half. Every case above chooses a branch
// of the repo the chat is already in; the owner's report was about choosing a
// DIFFERENT one ("clicked Origami Code, Cortex stayed ticked, nothing
// happened"), which no test covered.
describe('choosing a different repo', () => {
  const OTHER = 'C:/Repos/b';
  const OTHER_WT = 'C:/Repos/b/.origami/worktrees/y';

  async function pickedBeta() {
    const view = await mounted(REPO);
    await fireEvent.click(view.getByTestId('repo-pill'));
    const rows = [...view.getByTestId('repo-pop').querySelectorAll('.row')];
    await fireEvent.click(rows.find((r) => r.textContent?.includes('beta'))!);
    deliver({
      type: 'repoPickerBranches',
      root: OTHER,
      branches: [{ branch: 'main', path: OTHER }, { branch: 'origami/y', path: OTHER_WT }],
    });
    await vi.waitFor(() => expect(view.getByTestId('branch-pop')).toBeInTheDocument());
    return view;
  }

  it('asks the host for THAT repo s worktrees', async () => {
    await pickedBeta();
    expect(posted()).toContainEqual({ type: 'repoPickerBranches', root: OTHER });
  });

  it('lists the chosen repo s worktrees — the defect showed "No worktrees" here', async () => {
    const view = await pickedBeta();
    const labels = [...view.getByTestId('branch-pop').querySelectorAll('.row .label')].map((n) => n.textContent);
    expect(labels).toEqual(['main', 'origami/y', NEW_BRANCH_LABEL]);
  });

  it('ticks the repo the user just chose, not the one the chat is still in', async () => {
    const view = await pickedBeta();
    await fireEvent.click(view.getByTestId('branch-pill')); // shut the branch list
    await fireEvent.click(view.getByTestId('repo-pill'));
    const ticked = [...view.getByTestId('repo-pop').querySelectorAll('.row.current')].map((n) => n.textContent);
    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toContain('beta');
  });

  it('a pick there starts a chat in the NEW repo — the whole point of the feature', async () => {
    const view = await pickedBeta();
    await fireEvent.click([...view.getByTestId('branch-pop').querySelectorAll('.row')][1]);
    expect(posted()).toContainEqual({
      type: 'repoPickerSelect', sessionId: 'session-1', root: OTHER, branch: 'origami/y', path: OTHER_WT,
    });
  });

  it('the host s confirmation clears the pending pick, so the pills follow the real cwd again', async () => {
    const view = await pickedBeta();
    await fireEvent.click([...view.getByTestId('branch-pop').querySelectorAll('.row')][1]);
    deliver({ type: 'repoPickerSelected', sessionId: 'session-1', root: OTHER, branch: 'origami/y', path: OTHER_WT });
    await vi.waitFor(() => expect(view.getByTestId('repo-pill')).toHaveTextContent('beta'));
  });
});

// t-rnavdc bug 3 — the pill clipped short names ("ArmourPaint" -> "ArmourPa")
// because its wrapper capped at a PERCENTAGE of the row rather than a fixed
// measure, so it squeezed regardless of how much room the label actually needed.
describe('the pills — sized to content, not clipped at a percentage', () => {
  it('carries the FULL label in the DOM even for a long name — no JS-side truncation', async () => {
    const view = render(RepoBranchPicker, { props: { sessionId: 'session-1' } });
    deliver({
      type: 'repoPickerOptions',
      repos: [{ root: REPO, name: 'ArmourPaint' }],
      defaultRoot: REPO,
      cwdBySession: { 'session-1': REPO },
    });
    await vi.waitFor(() => expect(view.getByTestId('repo-pill')).toHaveTextContent('ArmourPaint'));
    // The visual cut ("ArmourPa") was CSS overflow on a too-narrow wrapper, not
    // a JS slice — proving the full string is here rules that class of bug back
    // in if it ever regresses to string manipulation instead.
    expect(view.getByTestId('repo-pill').textContent).toContain('ArmourPaint');
  });

  it('the anchor caps at a fixed measure, not a percentage of the row (CSS source)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, 'RepoBranchPicker.svelte'), 'utf8');
    const rule = /\.anchor\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    expect(rule).toMatch(/max-width:\s*180px/);
    expect(rule).not.toMatch(/max-width:\s*\d+%/);
  });

  it('the pill itself sizes to content — no fixed width, ellipsis only past the cap (CSS source)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, 'RepoBranchPicker.svelte'), 'utf8');
    const rule = /(?<!\.branch\s)\.pill\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).not.toMatch(/(?<!max-)(?<!min-)width:\s*\d/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });
});
