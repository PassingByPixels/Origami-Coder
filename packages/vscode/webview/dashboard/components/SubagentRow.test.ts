// SubagentRow.test.ts — one roster row: the per-row collapse toggle
// (t-kgryh1 round 2), the token figure and the time-limit warning (t-dclj7z).
//
// TEST GAP this file closes (fix round, verifier-confirmed): the chevron
// button and its `expanded` $state landed with NO test rendering the
// component and driving the toggle — subagentRows.test.ts covers the row
// DATA (subagentRows.ts), never the .svelte control. Direct-render precedent
// is TodoStrip.test.ts (same folder).
//
// The prop bags come from `rowProps` (panes/subagentRowFixture.ts). This file
// used to pass `onOpenInTab` — a prop renamed to `onOpen` long before — and a
// row literal with no `settled` field, and stayed green in both cases: Svelte
// drops an undeclared prop in silence and the type gate does not read tests.
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import SubagentRow from './SubagentRow.svelte';
import { row, rowProps, tokens } from '../panes/subagentRowFixture';

afterEach(() => cleanup());

const ACTIVE = { activity: 'reading file.ts' } as const;
const fold = (c: HTMLElement) => c.querySelector('.sa-fold') as HTMLButtonElement;
const activity = (c: HTMLElement) => c.querySelector('.sa-activity');
const dot = (c: HTMLElement) => c.querySelector('.sa-dot') as HTMLElement;

describe('SubagentRow — per-row collapse (t-f9jxl1: every row starts COLLAPSED)', () => {
  it('starts COLLAPSED, even a running row: activity hidden, fold reports aria-expanded=false, chevron right', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ description: 'Worker-crane', state: 'running', ...ACTIVE }) }));
    expect(activity(container)).toBeNull();
    expect(fold(container).getAttribute('aria-expanded')).toBe('false');
    expect(fold(container).textContent).toBe('▸');
  });

  it('clicking the fold reveals the activity tail — the header line (name) is unaffected', async () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ description: 'Worker-crane', ...ACTIVE }) }));
    await fireEvent.click(fold(container));

    expect(activity(container)?.textContent).toBe('reading file.ts');
    expect(fold(container).getAttribute('aria-expanded')).toBe('true');
    expect(fold(container).textContent).toBe('▾');
    expect(container.querySelector('.sa-name')?.textContent).toBe('T1 · Worker-crane');
  });

  it('clicking again re-collapses — the activity text was never discarded, just re-derived from the row', async () => {
    const { container } = render(SubagentRow, rowProps({ row: row(ACTIVE) }));
    await fireEvent.click(fold(container));
    expect(activity(container)?.textContent).toBe('reading file.ts');

    await fireEvent.click(fold(container));
    expect(activity(container)).toBeNull();
    expect(fold(container).getAttribute('aria-expanded')).toBe('false');
  });

  it('a silent row (no activity) renders no fold button at all — nothing to collapse', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ activity: '' }) }));
    expect(container.querySelector('.sa-fold')).toBeNull();
  });
});

// t-dclj7z / t-f9jxl1: the single `<X> tokens` figure on row 2, beside the
// age, blank against an engine that rides none.
describe('SubagentRow — the token figure', () => {
  it('prints the compact total tokens beside the age, with the full breakdown in its title', () => {
    const { container } = render(SubagentRow, {
      ...rowProps({ row: row({ elapsedMs: 125_000, tokens: tokens({ cost: 0.0421 }) }) }),
    });
    expect(container.querySelector('.sa-age')?.textContent).toBe('2m 05s');
    const spend = container.querySelector('.sa-tokens');
    expect(spend?.textContent).toBe('14.5k tokens');
    expect(spend?.getAttribute('data-tip')).toBe('Input 12,400 · Output 2,100 · Cost $0.0421');
  });

  // t-ffziaz. The owner read a child's 38k beside a chat's 19k and concluded the
  // child cost twice as much for the same job. Both numbers were right: 38k was
  // the SUM of two steps, 19k was ONE step's context. The row now states all
  // three figures in the vocabulary the chat's pill uses, so neither can be
  // mistaken for the other again.
  it('states the sum, the step count and the LAST step context — the three are one vocabulary', () => {
    // Two steps of ~19k input: the run spent 38.5k, but its window never passed 19.1k.
    const { container } = render(SubagentRow, rowProps({
      row: row({ tokens: tokens({ input: 38_200, output: 300, steps: 2, context: 19_100 }) }),
    }));
    const spend = container.querySelector('.sa-tokens');

    expect(spend?.textContent).toBe('38.5k tokens · 2 steps · 19.1k context');
    // The sum and the context are DIFFERENT numbers on the same row — the whole
    // point — and the tooltip names which context it means.
    expect(spend?.getAttribute('data-tip')).toContain('Last step context 19,100');
    expect(spend?.getAttribute('data-tip')).toContain('Steps 2');
  });

  it('says "1 step" and not "1 steps" for a child that answered in one call', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ tokens: tokens({ input: 19_000, output: 100, steps: 1, context: 19_000 }) }),
    }));
    expect(container.querySelector('.sa-tokens')?.textContent).toBe('19.1k tokens · 1 step · 19k context');
  });

  it('drops the two new figures against an engine that rides neither, rather than inventing them', () => {
    // An installed engine older than the t-ffziaz lane sends input/output only.
    // `1 step` there would be a claim, not a reading.
    const { container } = render(SubagentRow, rowProps({ row: row({ tokens: tokens() }) }));
    expect(container.querySelector('.sa-tokens')?.textContent).toBe('14.5k tokens');
  });

  it('prints NOTHING when the card carried no token rider', () => {
    // The fail-open case: an installed engine older than this extension rides
    // no tokens, and `0 / 0` there would claim a figure nobody sent.
    const { container } = render(SubagentRow, rowProps({ row: row({ tokens: undefined }) }));
    expect(container.querySelector('.sa-tokens')).toBeNull();
  });
});

// t-dclj7z, acceptance 3: amber past 80% of the ceiling. The clock is a
// parameter (elapsedMs on the row, limitMs as a prop), so no waiting.
describe('SubagentRow — the time-limit warning', () => {
  const FOUR_HOURS = 4 * 3_600_000;

  it('ambers a running row past 80%, and names the time left', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ elapsedMs: FOUR_HOURS * 0.8 }),
      limitMs: FOUR_HOURS,
    }));
    expect(dot(container).className).toContain('sa-warn');
    expect(dot(container).getAttribute('data-tip')).toBe('Approaching the 4 h sub-agent time limit — about 48m 00s left');
  });

  it('leaves a row one millisecond short of the threshold alone, with no stray title', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ elapsedMs: FOUR_HOURS * 0.8 - 1 }),
      limitMs: FOUR_HOURS,
    }));
    expect(dot(container).className).not.toContain('sa-warn');
    expect(dot(container).getAttribute('data-tip')).toBe('');
  });

  it('keeps the RUNNING state class as well as the warning — it has not stopped', () => {
    // Amber replaces the colour, not the state: the row is still working, it
    // is running out of time.
    const { container } = render(SubagentRow, rowProps({
      row: row({ elapsedMs: FOUR_HOURS }),
      limitMs: FOUR_HOURS,
    }));
    expect(dot(container).className).toContain('sa-running');
    expect(dot(container).className).toContain('sa-warn');
  });

  it('never ambers when the host reported no usable ceiling', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ elapsedMs: FOUR_HOURS * 9 }) }));
    expect(dot(container).className).not.toContain('sa-warn');
  });
});

// t-f9jxl1 acceptance 2 asked for three distinct lines. t-qn0lpl SUPERSEDES it
// with two: the model joined the metadata line, because three lines per row cost
// eighteen lines of a 280px rail on a fan-out of six and the model is the same
// kind of fact as the tokens and the age. What stays asserted is the part that
// was never about the count — identity on line 1, every figure on line 2, in
// order, as DISTINCT nodes rather than one wrapping line.
describe('SubagentRow — the two-row layout', () => {
  // t-yyz57i: the model left the face for the row's tooltip (mockup R3).
  it('renders identity+buttons, then tokens+elapsed, as two separate lines; the model is in the tooltip', () => {
    const { container } = render(SubagentRow, rowProps({
      row: row({ elapsedMs: 125_000, tokens: tokens(), model: 'openrouter/qwen3-coder' }),
    }));
    const line1 = container.querySelector('.sa-line1') as HTMLElement;
    const line2 = container.querySelector('.sa-line2') as HTMLElement;
    expect(line1.querySelector('.sa-name')).not.toBeNull();
    expect(line2.querySelector('.sa-tokens')?.textContent).toBe('14.5k tokens');
    expect(line2.querySelector('.sa-age')?.textContent).toBe('2m 05s');
    expect(line2.querySelector('.sa-model')).toBeNull();
    expect(container.querySelector('.sa-row')?.getAttribute('data-tip')).toContain('openrouter/qwen3-coder');
    expect(new Set([line1, line2]).size).toBe(2);
    expect(container.querySelector('.sa-line3')).toBeNull();
  });

  it('a card with no model prints no model span — absent, not empty', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ model: undefined }) }));
    expect(container.querySelector('.sa-model')).toBeNull();
    expect(container.querySelector('.sa-line3')).toBeNull();
  });
});

describe('SubagentRow — what the row CALLS the agent (t-f6u661)', () => {
  const name = (c: HTMLElement) => c.querySelector('.sa-name') as HTMLElement;

  it('prints the identity, never the card header — which is the word `task`', () => {
    // The owner's defect on 0.4.139: every row in a fan-out read `task`,
    // because the row printed the tool call's own title. `title` is still set
    // on the fixture, so a regression to it fails here instead of matching.
    const { container } = render(SubagentRow, rowProps({
      row: row({ title: 'task', ordinal: 2, agentType: 'Explore', description: 'audit the bundle' }),
    }));
    expect(name(container).textContent).toBe('Explore · T2 · audit the bundle');
    expect(name(container).textContent).not.toBe('task');
  });

  it('hovers the SAME identity, so a clipped row stays addressable', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ ordinal: 2, agentType: 'Explore' }) }));
    expect(name(container).getAttribute('data-tip')).toBe('Explore · T2 · audit the bundle');
  });

  it('drops the parts the engine did not send rather than padding them', () => {
    // An engine that rides no `subagent_type`, and a card whose input never
    // reached the webview: both still name an agent you can point at.
    const { container: noType } = render(SubagentRow, rowProps({ row: row({ ordinal: 3 }) }));
    expect(name(noType).textContent).toBe('T3 · audit the bundle');
    cleanup();
    const { container: bare } = render(SubagentRow, rowProps({
      row: row({ ordinal: 4, description: undefined, agentType: undefined }),
    }));
    expect(name(bare).textContent).toBe('T4');
  });
});

// t-yyz57i: line 2 is the live activity while running, the reason when failed.
describe('SubagentRow — line 2 by state (t-yyz57i)', () => {
  it('a running row with output shows its latest line in the activity slot', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ activity: 'read a.ts\nedit b.ts' }) }));
    expect(container.querySelector('.sa-line2 .sa-act')?.textContent).toBe('edit b.ts');
  });

  it('a failed row shows its reason in red, not its totals', () => {
    const { container } = render(SubagentRow, rowProps({ row: row({ state: 'error', settled: true, activity: 'Error: 429', tokens: tokens() }) }));
    const line2 = container.querySelector('.sa-line2') as HTMLElement;
    expect(line2.classList.contains('sa-line2-fail')).toBe(true);
    expect(line2.querySelector('.sa-reason')?.textContent).toBe('Error: 429');
    expect(line2.querySelector('.sa-tokens')).toBeNull();
  });
});
