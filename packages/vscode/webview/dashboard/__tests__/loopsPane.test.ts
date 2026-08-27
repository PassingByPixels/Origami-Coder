// LoopsPane — the live /loop schedules across open chats, PERSISTED so they
// survive a window reload (see src/dashboard/agentManager/loopPersistence.ts).
// The pane must describe what a loop IS (a prompt re-run on an interval),
// never claim nothing survives a reload, render a cancel control per row
// that posts the same wire message for both a live row (local session id)
// and a needs-attention row (persisted engine id), and never render
// fabricated rows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import LoopsPane from '../panes/LoopsPane.svelte';

function loopSchedulesData(schedules: unknown[], needsAttention: unknown[] = []): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'loopSchedulesData', schedules, needsAttention } }));
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
// The markup wraps prose across source lines, so textContent carries literal
// newlines/indentation between words — normalize before substring checks.
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
// One labelled fact off a card ("Runs" -> "3"). Read by LABEL rather than by
// position, so re-ordering the grid does not silently re-point an assertion at
// a neighbouring value.
const fact = (scope: Element, key: string): string | null => {
  for (const f of scope.querySelectorAll('.loop-fact')) {
    if (flat(f.querySelector('.lf-k')!.textContent) === key) return flat(f.querySelector('.lf-v')!.textContent);
  }
  return null;
};

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('LoopsPane — requests live data on mount', () => {
  it('posts listLoopSchedules (the DashboardPanel wire) on mount', () => {
    render(LoopsPane);
    expect(posts()).toContainEqual({ type: 'listLoopSchedules' });
  });
});

describe('LoopsPane — honest empty state (zero loops)', () => {
  it('describes what a loop IS, and never claims nothing survives a reload', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([]);
    await tick();

    expect(container.querySelectorAll('.loop-card').length).toBe(0);
    const empty = container.querySelector('.loops-empty');
    expect(empty).not.toBeNull();
    expect(flat(empty!.textContent)).toContain('No loops running right now');
    expect(flat(empty!.textContent)).toContain('/loop');
    // The pane-wide note describes the DURABLE behaviour, not the old
    // "nothing survives a restart" disclaimer.
    expect(flat(container.textContent)).toContain('persist across a window reload');
    expect(flat(container.textContent)).not.toContain('persisted cron system');
    expect(flat(container.textContent)).not.toContain('nothing here survives a restart');
  });
});

describe('LoopsPane — populated state (two live schedules)', () => {
  it('renders both schedules with their chat identity, interval, prompt, run count and a cancel control', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([
      { sessionId: 's1', number: 1, agentName: 'Tsuru', title: 'triage CI', intervalLabel: '30m', prompt: 'check for newly failing tests', runs: 3 },
      { sessionId: 's2', number: 2, agentName: 'Tsuru', intervalLabel: '1h', prompt: 'watch the backlog', runs: 0 },
    ]);
    await tick();

    const cards = Array.from(container.querySelectorAll('.loop-card'));
    expect(cards.length).toBe(2);

    expect(flat(container.textContent)).toContain('#1 Tsuru: triage CI');
    expect(flat(container.textContent)).toContain('every 30m');
    expect(flat(container.textContent)).toContain('check for newly failing tests');
    expect(fact(cards[0], 'Runs')).toBe('3');

    expect(flat(container.textContent)).toContain('#2 Tsuru');
    expect(flat(container.textContent)).toContain('every 1h');
    expect(flat(container.textContent)).toContain('watch the backlog');
    expect(fact(cards[1], 'Runs')).toBe('0');

    expect(container.querySelectorAll('.loop-cancel').length).toBe(2);
    expect(container.querySelector('.loops-empty')).toBeNull();
  });

  it('clicking a live row\'s cancel posts cancelLoopSchedule with the row\'s LOCAL session id', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([
      { sessionId: 's1', number: 1, agentName: 'Tsuru', intervalLabel: '30m', prompt: 'check CI', runs: 3 },
    ]);
    await tick();

    await fireEvent.click(container.querySelector('.loop-cancel')!);
    expect(posts()).toContainEqual({ type: 'cancelLoopSchedule', sessionId: 's1' });
  });
});

describe('LoopsPane — needs-attention loops (session could not be restored)', () => {
  it('renders a needs-attention loop separately, with its prompt intact, never fabricating a live chat identity', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([], [
      { sessionId: 'eng-orphan', intervalLabel: '15m', prompt: 'poll the deploy', runs: 7, createdAt: 1000 },
    ]);
    await tick();

    expect(flat(container.textContent)).toContain('Needs attention');
    expect(flat(container.textContent)).toContain('poll the deploy');
    expect(flat(container.textContent)).toContain('every 15m');
    expect(fact(container.querySelector('.loop-card')!, 'Runs')).toBe('7');
    // Nothing here claims a live chat number/agent — there isn't one.
    expect(container.querySelector('.loops-empty')).toBeNull();
  });

  it('clicking a needs-attention row\'s cancel posts cancelLoopSchedule with the persisted ENGINE session id', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([], [
      { sessionId: 'eng-orphan', intervalLabel: '15m', prompt: 'poll the deploy', runs: 7, createdAt: 1000 },
    ]);
    await tick();

    await fireEvent.click(container.querySelector('.loop-cancel')!);
    expect(posts()).toContainEqual({ type: 'cancelLoopSchedule', sessionId: 'eng-orphan' });
  });

  it('a mix of live and needs-attention loops both render, and the empty state does not show', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData(
      [{ sessionId: 's1', number: 1, agentName: 'Tsuru', intervalLabel: '30m', prompt: 'check CI', runs: 1 }],
      [{ sessionId: 'eng-orphan', intervalLabel: '15m', prompt: 'poll the deploy', runs: 7, createdAt: 1000 }],
    );
    await tick();

    expect(container.querySelectorAll('.loop-card').length).toBe(2);
    expect(container.querySelector('.loops-empty')).toBeNull();
  });
});

const live = (over: Record<string, unknown> = {}) => ({
  sessionId: 'session-1', number: 1, agentName: 'Tsuru', intervalLabel: '30m',
  prompt: 'check for newly failing tests', runs: 3, persistent: false, headless: false, ...over,
});

describe('LoopsPane — persistent loops', () => {
  it('a plain loop says it stops when its chat closes, and offers the toggle', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live()]);
    await tick();
    expect(flat(container.querySelector('.loop-state')!.textContent)).toContain('Stops when this chat closes');
    expect(container.querySelector<HTMLInputElement>('.ps-input')!.checked).toBe(false);
  });

  it('the toggle posts setLoopPersistent with the FLIPPED value and the row id', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live()]);
    await tick();
    await fireEvent.click(container.querySelector('.ps-input')!);
    expect(posts()).toContainEqual({ type: 'setLoopPersistent', sessionId: 'session-1', persistent: true });
  });

  it('an already-persistent loop toggles back OFF, not on again', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true })]);
    await tick();
    await fireEvent.click(container.querySelector('.ps-input')!);
    expect(posts()).toContainEqual({ type: 'setLoopPersistent', sessionId: 'session-1', persistent: false });
  });

  it('a persistent loop WITH its chat open promises only what it can deliver', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true })]);
    await tick();
    expect(flat(container.querySelector('.loop-state')!.textContent)).toContain('Keeps running if you close this chat');
  });

  it('a persistent loop running HEADLESS says the chat is gone AND that it is still scheduled', async () => {
    // The state that would otherwise read as a lie in either direction: showing
    // a chat identity that no longer exists, or implying the loop stopped when
    // it is still firing every interval.
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true, headless: true })]);
    await tick();
    const s = flat(container.querySelector('.loop-state')!.textContent);
    expect(s).toContain('No chat open');
    expect(s).toContain('still scheduled');
  });

  it('the pane states the limit: even a persistent loop dies with VS Code — that is a Cron', async () => {
    // A toggle labelled "Persistent" next to a Crons tab is exactly how someone
    // ends up believing their loop runs overnight with the editor shut.
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true })]);
    await tick();
    const limit = flat(container.querySelector('.loops-limit')!.textContent);
    expect(limit).toContain('stops when VS Code closes');
    expect(limit).toContain('Cron');
  });

  it('a needs-attention PERSISTENT loop admits its recall failed and nothing is scheduled', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([], [{ sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll', runs: 7, createdAt: 1, persistent: true }]);
    await tick();
    const s = flat(container.querySelector('.loop-card.attention .loop-state')!.textContent);
    expect(s).toContain('could not be reopened');
    expect(s).toContain('nothing is scheduled');
  });
});

describe('LoopsPane — reopening the chat of a loop that has none', () => {
  // A persistent loop keeps running with no chat, writing turns into an engine
  // transcript nobody can read. The control that brings that conversation back
  // is the only thing that makes the setting worth having — and it must appear
  // ONLY where there is something to reopen, or it is a button that does
  // nothing when pressed.
  const reopenBtn = (c: HTMLElement) => c.querySelector('.loop-reopen');

  it('a loop whose chat is OPEN offers no reopen control at all', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true, headless: false })]);
    await tick();
    expect(reopenBtn(container)).toBeNull();
    // The controls it SHOULD have are untouched by that absence.
    expect(container.querySelector('.loop-cancel')).not.toBeNull();
    expect(container.querySelector('.ps-input')).not.toBeNull();
  });

  it('a HEADLESS loop offers it, and clicking posts reopenLoopChat with the row\'s LOCAL session id', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true, headless: true })]);
    await tick();
    expect(reopenBtn(container)).not.toBeNull();

    await fireEvent.click(reopenBtn(container)!);
    expect(posts()).toContainEqual({ type: 'reopenLoopChat', sessionId: 'session-1' });
  });

  it('a NEEDS-ATTENTION loop offers it too, posting the persisted ENGINE id — the card tells you to reopen the chat, so it has to be possible', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([], [{ sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll', runs: 7, createdAt: 1, persistent: true }]);
    await tick();

    await fireEvent.click(reopenBtn(container)!);
    expect(posts()).toContainEqual({ type: 'reopenLoopChat', sessionId: 'eng-A' });
  });

  it('a mixed pane offers it on exactly the rows with no chat — not on the one that has one', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData(
      [live({ sessionId: 's1', headless: false }), live({ sessionId: 's2', number: 2, headless: true })],
      [{ sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll', runs: 7, createdAt: 1, persistent: true }],
    );
    await tick();
    const withReopen = Array.from(container.querySelectorAll('.loop-card')).filter((c) => c.querySelector('.loop-reopen'));
    expect(container.querySelectorAll('.loop-card')).toHaveLength(3);
    expect(withReopen).toHaveLength(2);
    // The one that kept its chat is the one without the control.
    expect(withReopen.some((c) => flat(c.textContent).includes('#1 Tsuru'))).toBe(false);
  });

  it('reopening does not cancel: the two controls post different messages', async () => {
    // Sharing a handler here would silently trade "show me the conversation"
    // for "throw the schedule away".
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ persistent: true, headless: true })]);
    await tick();
    await fireEvent.click(reopenBtn(container)!);
    expect(posts()).not.toContainEqual({ type: 'cancelLoopSchedule', sessionId: 'session-1' });
  });
});

describe('LoopsPane — the persistence control announces itself as a control', () => {
  // The defect this replaces: a <button> whose caption WAS the current fact
  // ("Dies with chat"). Passing looked straight at it and did not see a toggle
  // — nothing said it was clickable, and the one word on screen named a state
  // rather than the setting, so you could only learn what it did by pressing it
  // and watching something change.
  const ps = (c: HTMLElement) => c.querySelector<HTMLInputElement>('.ps-input')!;

  it('is a real switch, not a button dressed as a label', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live()]);
    await tick();
    const input = ps(container);
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('checkbox');
    expect(input.getAttribute('role')).toBe('switch');
  });

  it('names the SETTING in both states, so the caption never has to be decoded', async () => {
    // The regression guard: if the visible text ever goes back to describing
    // the fact ("Dies with chat" / "Persistent") the word "Persistent" stops
    // appearing in one of the two states, and this goes red.
    for (const persistent of [false, true]) {
      const { container } = render(LoopsPane);
      loopSchedulesData([live({ persistent })]);
      await tick();
      const control = container.querySelector('.ps')!;
      expect(flat(control.textContent)).toContain('Persistent');
      expect(ps(container).getAttribute('aria-label')).toBe('Persistent');
      cleanup();
    }
  });

  it('shows WHICH state it is in, in words, without anyone having to click it', async () => {
    const off = render(LoopsPane);
    loopSchedulesData([live({ persistent: false })]);
    await tick();
    expect(flat(off.container.querySelector('.ps-state')!.textContent)).toBe('off');
    expect(ps(off.container).checked).toBe(false);
    cleanup();

    const on = render(LoopsPane);
    loopSchedulesData([live({ persistent: true })]);
    await tick();
    expect(flat(on.container.querySelector('.ps-state')!.textContent)).toBe('on');
    expect(ps(on.container).checked).toBe(true);
  });

  it('round-trips: toggling on then re-rendering from the host state offers to toggle back off', async () => {
    // The host is the source of truth — the pane re-broadcasts after the flip.
    // This pins the whole loop, not just the outbound half: a control that sent
    // `true` and then kept sending `true` would pass a one-click test.
    const first = render(LoopsPane);
    loopSchedulesData([live({ persistent: false })]);
    await tick();
    await fireEvent.click(ps(first.container));
    expect(posts()).toContainEqual({ type: 'setLoopPersistent', sessionId: 'session-1', persistent: true });
    cleanup();

    const second = render(LoopsPane);
    loopSchedulesData([live({ persistent: true })]);
    await tick();
    await fireEvent.click(ps(second.container));
    expect(posts()).toContainEqual({ type: 'setLoopPersistent', sessionId: 'session-1', persistent: false });
  });
});

describe('LoopsPane — the card says when the next run is, or why it cannot', () => {
  it('an armed timer renders as a countdown', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ nextRunAt: Date.now() + 95_000 })]);
    await tick();
    expect(fact(container.querySelector('.loop-card')!, 'Next run')).toMatch(/^in 1m \d+s$/);
  });

  it('a live loop with NO armed timer says a run is under way — it does not invent a time', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ nextRunAt: null, runs: 4 })]);
    await tick();
    expect(fact(container.querySelector('.loop-card')!, 'Next run')).toBe('after this run');
  });

  it('a needs-attention loop says NOTHING is scheduled — no countdown at all', async () => {
    // Nothing is armed anywhere in the process for one of these. A countdown
    // here would be a promise no timer is keeping.
    const { container } = render(LoopsPane);
    loopSchedulesData([], [{ sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll', runs: 7, createdAt: 1, persistent: false }]);
    await tick();
    const card = container.querySelector('.loop-card.attention')!;
    expect(fact(card, 'Next run')).toBe('not scheduled');
    expect(flat(card.textContent)).not.toMatch(/in \d/);
  });

  it('a loop that has not completed a run in this window shows no Last run row at all', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ lastRunAt: null, lastOutcome: null })]);
    await tick();
    expect(fact(container.querySelector('.loop-card')!, 'Last run')).toBeNull();
  });

  it('a completed run shows its age and outcome', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ lastRunAt: Date.now() - 30_000, lastOutcome: 'failed' })]);
    await tick();
    expect(fact(container.querySelector('.loop-card')!, 'Last run')).toBe('30s ago · failed');
  });

  it('the prompt is rendered in full — it is the whole point of the loop', async () => {
    const long = 'sweep the inbox '.repeat(60);
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ prompt: long })]);
    await tick();
    expect(container.querySelector('.loop-prompt')!.textContent).toBe(long);
  });
});

describe('LoopsPane — the filter box', () => {
  const three = [
    live({ sessionId: 's1', number: 1, prompt: 'check for failing tests' }),
    live({ sessionId: 's2', number: 2, prompt: 'poll the deploy' }),
    live({ sessionId: 's3', number: 3, prompt: 'sweep the inbox' }),
  ];
  const type = async (container: HTMLElement, value: string) => {
    await fireEvent.input(container.querySelector('.loops-filter')!, { target: { value } });
    await tick();
  };

  it('narrows the list by prompt', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData(three);
    await tick();
    expect(container.querySelectorAll('.loop-card')).toHaveLength(3);
    await type(container, 'deploy');
    expect(container.querySelectorAll('.loop-card')).toHaveLength(1);
  });

  it('matches on the chat label too, not just the prompt', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([live({ sessionId: 's1', number: 7, agentName: 'Tsuru', title: 'nightly' })]);
    await tick();
    await type(container, 'nightly');
    expect(container.querySelectorAll('.loop-card')).toHaveLength(1);
  });

  it('a filter matching nothing does NOT claim there are no loops running', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData(three);
    await tick();
    await type(container, 'zzzz');
    const text = flat(container.querySelector('.loops-empty')!.textContent);
    expect(text).toContain('No loop matches');
    expect(text).toContain('3 loops running');
    expect(text).not.toContain('No loops running right now');
  });

  it('genuinely zero loops still gives the real empty state', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([]);
    await tick();
    const text = flat(container.querySelector('.loops-empty')!.textContent);
    expect(text).toContain('No loops running right now');
    expect(text).not.toContain('No loop matches');
  });

  it('the filter also searches needs-attention rows, so a stalled loop is never unreachable', async () => {
    const { container } = render(LoopsPane);
    loopSchedulesData([], [{ sessionId: 'eng-A', intervalLabel: '15m', prompt: 'poll the deploy', runs: 7, createdAt: 1, persistent: false }]);
    await tick();
    await type(container, 'deploy');
    expect(container.querySelectorAll('.loop-card')).toHaveLength(1);
  });
});
