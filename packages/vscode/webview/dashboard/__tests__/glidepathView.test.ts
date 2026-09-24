// The Glidepath view, rendered.
//
// jsdom draws no pixels, so nothing here can prove the LOOK — that is the
// owner's eyeball test. What it can prove is that the view says the same thing
// the math computed: the guard's reason reaches the card, a window with no
// period is kept off the axis and said so, the Data tab shows where each length
// came from, the crosshair says "no reading" outside the measured span, and
// hovering one connection fades the rest.
//
// The failure this file exists to catch is the one that drove the round: a
// confident number on screen that the readings do not support.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const RESET = 1_787_000_000_000;
const START = RESET - WEEK;
const NOW = START + 3.5 * DAY;

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

/** Half-hourly readings from `fromDay`, climbing `step` each reading. */
const dense = (fromDay: number, hours: number, from: number, step: number) => {
  const out: Array<{ t: number; pct: number }> = [];
  for (let i = 0; i <= hours * 2; i += 1) out.push({ t: START + fromDay * DAY + i * 0.5 * HOUR, pct: from + i * step });
  return out;
};

/**
 * Five connections covering every state the view has to hold honestly:
 * a projected week, a projected month, a window the guard is still holding, and
 * a window whose period nobody stated.
 */
const FIXTURE = {
  // 3.5 days of readings on a stated week: the guard is open.
  'claude-code': {
    windows: {
      '7d': { resetsAt: RESET, lengthMs: WEEK, samples: dense(0, 84, 2, 0.35) },
      '5h': { resetsAt: NOW + HOUR, lengthMs: 5 * HOUR, samples: [{ t: NOW - HOUR, pct: 30 }, { t: NOW, pct: 62 }] },
    },
  },
  // A MONTH, stated as both ends, drawn beside the weeks on the same axis.
  'github-copilot': {
    windows: {
      'Premium requests': { resetsAt: START + MONTH, startsAt: START, samples: dense(0, 84, 1, 0.05) },
    },
  },
  // THE GROK CASE. A reset time and no period at all: no axis, no projection.
  xai: { windows: { Credits: { resetsAt: RESET, samples: [{ t: NOW - 2 * HOUR, pct: 12 }, { t: NOW, pct: 14 }] } } },
  // Two hours of readings on a stated week: a percentage, but nothing forecast.
  openai: { windows: { Weekly: { resetsAt: RESET, lengthMs: WEEK, samples: dense(3, 2, 40, 0.5) } } },
};

async function openGlidepath(data?: Record<string, unknown>) {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: [] });
  await tick();
  const pill = [...rendered.container.querySelectorAll('.lab-pill')].find((b) => b.textContent?.includes('Glidepath'))!;
  await fireEvent.click(pill);
  await tick();
  if (data) {
    send({ type: 'glidepathData', now: NOW, capable: ['claude-code', 'openai'], ...data });
    await tick();
  }
  return rendered;
}

const cardNamed = (container: Element, name: string) =>
  [...container.querySelectorAll('.gp-mini')].find((c) => flat(c.querySelector('.gp-mini-name')!.textContent) === name)!;
const tabNamed = (container: Element, name: string) =>
  [...container.querySelectorAll('.gp-tab')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement;

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  try { localStorage.clear(); } catch { /* a host that refuses storage is the point of the guard */ }
});
afterEach(() => cleanup());

describe('the two pills', () => {
  it('opens on Labyrinth, with the map on screen and no glide path', () => {
    const { container } = render(LabyrinthPane);
    const pills = container.querySelectorAll('.lab-pill');
    expect(pills).toHaveLength(2);
    expect(pills[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.gp-root')).toBeNull();
  });

  it('switching to Glidepath asks the host for a pass and swaps the view', async () => {
    const { container } = await openGlidepath();
    expect(posts()).toContainEqual({ type: 'glidepathRequest' });
    expect(container.querySelector('.gp-root')).not.toBeNull();
    // The map is HIDDEN, not unmounted — the run the user had open survives.
    expect(container.querySelector('.lab-pane')!.classList.contains('lab-off')).toBe(true);
  });
});

describe('nothing recorded yet', () => {
  it('says so, and names the connections that CAN report', async () => {
    const { container } = await openGlidepath({ providers: {} });
    const text = flat(container.querySelector('.gp-nothing')!.textContent);
    expect(text).toContain('No metered connections reporting yet');
    expect(text).toContain('Claude, ChatGPT');
    expect(container.querySelector('.gp-hero')).toBeNull();
  });

  it('distinguishes "nothing can report" from "nothing recorded yet"', async () => {
    const rendered = render(LabyrinthPane);
    const pill = [...rendered.container.querySelectorAll('.lab-pill')].find((b) => b.textContent?.includes('Glidepath'))!;
    await fireEvent.click(pill);
    send({ type: 'glidepathData', now: NOW, capable: [], providers: {} });
    await tick();
    expect(flat(rendered.container.querySelector('.gp-nothing')!.textContent)).toContain('No configured connection can report');
  });
});

describe('the projection guard, on screen', () => {
  it('a window with two hours of readings shows a percentage and no forecast', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const card = flat(cardNamed(container, 'ChatGPT').textContent);
    expect(card).toContain('too early to project — only 2.0 h of readings (provisional at 4 h, firm at 24 h)');
    expect(card).toContain('TOO EARLY');
    // The percentage itself is real and is still shown.
    expect(card).toContain('used');
  });

  it('states the hold under the axis and as a row, and blocks the reasoned tab', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    expect(flat(container.querySelector('.gp-guardnote')!.textContent)).toContain('needs 24 h of readings and 10% of the window');
    const rows = [...container.querySelectorAll('.gp-insrow')].map((r) => flat(r.textContent));
    expect(rows.some((r) => r.includes('Projection paused on'))).toBe(true);
    await fireEvent.click(tabNamed(container, 'Reasoned'));
    await tick();
    expect(flat(container.querySelector('.gp-rsummary')!.textContent)).toContain('less than one full window');
  });

  it('a window that CLEARS the guard draws a projection and carries a badge', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const card = flat(cardNamed(container, 'Claude').textContent);
    expect(card).toMatch(/ON TRACK|AHEAD|BEHIND|TIGHT/);
    expect(container.querySelectorAll('.gp-hero .gp-proj').length).toBeGreaterThan(0);
  });
});

describe('a provisional projection, on screen', () => {
  // Six hours of readings on a stated week. Under the old rule this card said
  // TOO EARLY and nothing else for a further eighteen hours.
  const SOFT = {
    'claude-code': { windows: { '7d': { resetsAt: RESET, lengthMs: WEEK, samples: dense(2, 6, 40, 1.2) } } },
  };

  it('badges the status with a leading tilde and fades it', async () => {
    const { container } = await openGlidepath({ providers: SOFT });
    const badge = cardNamed(container, 'Claude').querySelector('.gp-st')!;
    expect(flat(badge.textContent)).toBe('~AHEAD');
    expect(badge.classList.contains('gp-provisional')).toBe(true);
    expect(badge.classList.contains('gp-too-early')).toBe(false);
  });

  it('words the card tail as provisional and says when it firms', async () => {
    const { container } = await openGlidepath({ providers: SOFT });
    expect(flat(cardNamed(container, 'Claude').textContent)).toContain(
      'provisional (6.0 h of readings, firms at 24 h)',
    );
  });

  it('draws the projection line faded, and says so under the axis and as a row', async () => {
    const { container } = await openGlidepath({ providers: SOFT });
    const proj = container.querySelectorAll('.gp-hero .gp-proj');
    expect(proj.length).toBe(1);
    expect(proj[0]!.classList.contains('gp-proj-prov')).toBe(true);
    expect(flat(container.querySelector('.gp-guardnote')!.textContent)).toBe(
      'provisional on 1 of 1: under 24 h of readings',
    );
    const rows = [...container.querySelectorAll('.gp-insrow')].map((r) => flat(r.textContent));
    expect(rows.some((r) => r.includes('Provisional projection on 1 of 1'))).toBe(true);
    expect(rows.some((r) => r.includes('Projection paused on'))).toBe(false);
  });

  it('lets the Reasoned tab through and names which connections are provisional', async () => {
    const { container } = await openGlidepath({ providers: SOFT });
    await fireEvent.click(tabNamed(container, 'Reasoned'));
    await tick();
    const summary = flat(container.querySelector('.gp-rsummary')!.textContent);
    expect(summary).not.toContain('less than one full window');
    expect(summary).toContain('Claude');
    expect(summary).toContain('provisionally');
  });

  it('marks the lane provisional in the Data tab', async () => {
    const { container } = await openGlidepath({ providers: SOFT });
    await fireEvent.click(tabNamed(container, 'Data'));
    await tick();
    const row = [...container.querySelectorAll('.gp-dt tbody tr')][0]!;
    const cells = [...row.querySelectorAll('td')].map((td) => flat(td.textContent));
    // The direction survives: the Data tab reads `~AHEAD`, not the bare word.
    expect(cells[11]).toMatch(/^~(AHEAD|ON TRACK|TIGHT|BEHIND)$/);
  });

  it('a lane under the provisional floor is STILL too early, beside a provisional one', async () => {
    const { container } = await openGlidepath({
      providers: {
        ...SOFT,
        openai: { windows: { Weekly: { resetsAt: RESET, lengthMs: WEEK, samples: dense(3, 2, 40, 0.5) } } },
      },
    });
    expect(flat(cardNamed(container, 'ChatGPT').querySelector('.gp-st')!.textContent)).toBe('TOO EARLY');
    expect(flat(cardNamed(container, 'Claude').querySelector('.gp-st')!.textContent)).toBe('~AHEAD');
    // A blocked lane outranks a provisional one under the axis.
    expect(flat(container.querySelector('.gp-guardnote')!.textContent)).toContain('no projection on 1 of 2');
  });
});

describe('a window whose period nobody stated', () => {
  it('is kept OFF the shared axis and says only what was measured', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const card = flat(cardNamed(container, 'Grok').textContent);
    // THE BUG: this used to be drawn at 78% of an assumed month.
    expect(card).toContain('period unknown');
    expect(card).toContain('used 14.0%');
    expect(card).toContain('to reset');
    expect(card).not.toContain('fair');
    // Three lines on the chart, four cards: Grok has a card and no line.
    expect(container.querySelectorAll('.gp-hero .gp-line')).toHaveLength(3);
    expect(container.querySelectorAll('.gp-mini')).toHaveLength(4);
    expect(flat(container.querySelector('.gp-strip')!.textContent)).toContain('1 off the axis (period unknown)');
  });

  it('names it as an insight row, with the setting that fixes it', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const row = [...container.querySelectorAll('.gp-insrow')].map((r) => flat(r.textContent)).find((r) => r.includes('Window period unknown'))!;
    expect(row).toContain('Grok');
    expect(row).toContain('origamicoder.usage.windowLength');
  });

  it('the cadence override puts it back on the axis', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE, windowLengths: { xai: 'weekly' } });
    expect(flat(cardNamed(container, 'Grok').textContent)).not.toContain('period unknown');
    expect(container.querySelectorAll('.gp-hero .gp-line')).toHaveLength(4);
    expect(flat(container.querySelector('.gp-strip')!.textContent)).not.toContain('off the axis');
  });
});

describe('the shared, normalised axis', () => {
  it('every line starts at the origin, and the unmeasured part is DOTTED', async () => {
    // A window is 0% spent at its own start by definition. A line that began at
    // its first reading — here a third of the way in — read as a connection that
    // had used nothing until then.
    const { container } = await openGlidepath({
      providers: { openai: { windows: { Weekly: { resetsAt: NOW + 2.5 * DAY, lengthMs: WEEK, samples: dense(0, 30, 30, 0.3) } } } },
    });
    const lead = container.querySelector('.gp-hero .gp-lead')!;
    // x(0) = 46, y(0%) = 300 — the origin of the plot box.
    expect(lead.getAttribute('d')!.startsWith('M46.00,300.00')).toBe(true);
    expect(container.querySelector('.gp-mini-lead')).not.toBeNull();
    expect(flat(container.querySelector('.gp-legend')!.textContent)).toContain('dotted = before readings began');
  });

  it('a MONTH and a WEEK share the axis, and the legend names which is which', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const lengths = [...container.querySelectorAll('.gp-legend .gp-len')].map((e) => flat(e.textContent));
    expect(lengths).toEqual(['7 d', '30 d', '7 d']);
    // ONE reset wall for all of them, and quarter ticks rather than day numbers.
    expect(container.querySelectorAll('.gp-hero .gp-reset')).toHaveLength(1);
    expect([...container.querySelectorAll('.gp-dl text')].map((e) => flat(e.textContent)))
      .toEqual(['0%', '25%', '50%', '75%', '100%']);
    expect(container.querySelectorAll('.gp-hero .gp-fair')).toHaveLength(1);
  });

  it('has NO single NOW rule — each line ends in its own labelled dot', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    expect(container.querySelector('.gp-now')).toBeNull();
    expect(container.querySelectorAll('.gp-hero .gp-enddot')).toHaveLength(3);
    const labels = [...container.querySelectorAll('.gp-endlab')].map((e) => flat(e.textContent));
    expect(labels.some((l) => l.startsWith('Claude '))).toBe(true);
    // The collision pass keeps them apart even when the values bunch.
    const yy = [...container.querySelectorAll('.gp-endlab')].map((e) => Number(e.getAttribute('y'))).sort((a, b) => a - b);
    for (let i = 1; i < yy.length; i += 1) expect(yy[i]! - yy[i - 1]!).toBeGreaterThanOrEqual(13.9);
  });

  it('carries the coverage note in its own band under the axis', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const note = flat(container.querySelector('.gp-note')!.textContent);
    expect(note).toContain('readings began');
    expect(note).toContain('of history');
  });
});

describe('the crosshair', () => {
  it('reports each connection’s interpolated value, and "no reading" outside its span', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const svg = container.querySelector('.gp-hero') as SVGSVGElement;
    // jsdom gives every element a zero-sized box, so the real pointer geometry
    // is eyeball-only; what is testable is that a move produces a tooltip whose
    // rows say the right KIND of thing for each connection.
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 740, height: 360, right: 740, bottom: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await fireEvent.mouseMove(svg, { clientX: 46 + 0.5 * (690 - 46), clientY: 100 });
    await tick();
    const tip = container.querySelector('.gp-tip')!;
    expect(flat(tip.querySelector('.gp-tip-h')!.textContent)).toBe('50% of window');
    const rows = [...tip.querySelectorAll('.gp-tip-r')].map((r) => flat(r.textContent));
    // Claude's readings cover the first half of its week, so 50% is inside them.
    expect(rows.find((r) => r.startsWith('Claude'))).toMatch(/Claude \d+\.\d%/);
    // Copilot is 12% through its month: nothing was sampled at the half-way mark.
    expect(rows.find((r) => r.startsWith('GitHub Copilot'))).toContain('no reading');
    await fireEvent.mouseLeave(svg);
    await tick();
    expect(container.querySelector('.gp-tip')).toBeNull();
  });
});

describe('hovering one connection out of a bunch', () => {
  it('a legend row, a card and a line all raise the SAME connection', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const claudeCard = cardNamed(container, 'Claude');
    await fireEvent.mouseEnter(claudeCard);
    await tick();
    expect(claudeCard.classList.contains('gp-dim')).toBe(false);
    expect(cardNamed(container, 'Grok').classList.contains('gp-dim')).toBe(true);
    // The chart follows the card: Claude's group stays lit, the others fade.
    const groups = [...container.querySelectorAll('.gp-lanegroup')];
    expect(groups.filter((g) => g.classList.contains('gp-dim'))).toHaveLength(groups.length - 1);
    const legendRows = [...container.querySelectorAll('.gp-legend .gp-lp')].filter((r) => r.querySelector('.gp-st'));
    expect(legendRows.filter((r) => r.classList.contains('gp-dim'))).toHaveLength(legendRows.length - 1);

    await fireEvent.mouseLeave(claudeCard);
    await tick();
    expect(container.querySelectorAll('.gp-dim')).toHaveLength(0);
  });

  it('FOCUSING a card does what hovering it does, so a keyboard reaches it', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    const card = cardNamed(container, 'Grok') as HTMLElement;
    expect(card.getAttribute('tabindex')).toBe('0');
    await fireEvent.focus(card);
    await tick();
    expect(cardNamed(container, 'Claude').classList.contains('gp-dim')).toBe(true);
    await fireEvent.blur(card);
    await tick();
    expect(container.querySelectorAll('.gp-dim')).toHaveLength(0);
  });
});

describe('the ONE insights pill, and its three tabs', () => {
  it('opens on Programmatic: one row per measurement, none of which is advice', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    expect(container.querySelectorAll('.gp-ins')).toHaveLength(1);
    expect(tabNamed(container, 'Programmatic').getAttribute('aria-selected')).toBe('true');
    const rows = [...container.querySelectorAll('.gp-insrow')];
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(flat(row.textContent).toLowerCase()).not.toMatch(/you should|switch to|consider /);
    expect(container.querySelector('.gp-dt')).toBeNull();
  });

  it('the Data tab is the table view, and names where each length came from', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    await fireEvent.click(tabNamed(container, 'Data'));
    await tick();
    const head = [...container.querySelectorAll('.gp-dt th')].map((e) => flat(e.textContent));
    expect(head).toContain('Length');
    expect(head).toContain('From');
    const rows = [...container.querySelectorAll('.gp-dt tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((td) => flat(td.textContent)),
    );
    expect(rows).toHaveLength(4);
    // A length the provider STATED and one this build measured are different
    // claims, and the table is where that difference is auditable.
    const claude = rows.find((r) => r[0] === 'Claude')!;
    expect(claude[2]).toBe('7 d');
    expect(claude[3]).toBe('stated');
    const grok = rows.find((r) => r[0] === 'Grok')!;
    expect(grok[2]).toBe('unknown');
    expect(grok[3]).toBe('not stated');
    expect(grok[10]).toBe('not projected');
    expect(grok[11]).toBe('too early');
    expect(container.querySelectorAll('.gp-insrow')).toHaveLength(0);
  });

  it('the Reasoned tab swaps the body, posts nothing, and its button is inert', async () => {
    const { container } = await openGlidepath({ providers: FIXTURE });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(tabNamed(container, 'Reasoned'));
    await tick();
    expect(container.querySelectorAll('.gp-insrow')).toHaveLength(0);
    const btn = container.querySelector('.gp-rbtn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await fireEvent.click(btn);
    expect(posts()).toEqual([]);
  });

  it('remembers the tab, and falls back when storage says something unknown', async () => {
    const first = await openGlidepath({ providers: FIXTURE });
    await fireEvent.click(tabNamed(first.container, 'Data'));
    await tick();
    expect(localStorage.getItem('origami.glidepath.insightsTab')).toBe('data');
    cleanup();
    const second = await openGlidepath({ providers: FIXTURE });
    expect(tabNamed(second.container, 'Data').getAttribute('aria-selected')).toBe('true');
    localStorage.setItem('origami.glidepath.insightsTab', 'nonsense');
    cleanup();
    const third = await openGlidepath({ providers: FIXTURE });
    expect(tabNamed(third.container, 'Programmatic').getAttribute('aria-selected')).toBe('true');
  });

  it('still renders when the host refuses storage outright', async () => {
    // Some hosts do not merely return null — reading `localStorage` throws. A
    // pane that will not draw because a preference could not be read is worse
    // than one that opens on the default.
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const getItem = vi.spyOn(proto, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      const { container } = await openGlidepath({ providers: FIXTURE });
      expect(tabNamed(container, 'Programmatic').getAttribute('aria-selected')).toBe('true');
      await fireEvent.click(tabNamed(container, 'Data'));
      await tick();
      expect(container.querySelector('.gp-dt')).not.toBeNull();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
