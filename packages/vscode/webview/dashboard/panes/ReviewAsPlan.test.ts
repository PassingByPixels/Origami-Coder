// t-xsufpe: "Review as plan" under a plan-mode answer that did not call
// plan_exit (owner UAT 0.4.178: the plan came back as chat text, no review).
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import ReviewAsPlan from './ReviewAsPlan.svelte';
import { planAnswer, reviewAsPlanPrompt } from './reviewAsPlan';

afterEach(() => cleanup());

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

const PLAN = 'Day 1: Amsterdam to Cologne.\nDay 2: Cologne to Munich.';
const textTurn = [
  { kind: 'user', text: 'give me a plan for a road trip' },
  { kind: 'thought', text: 'I will just answer in chat' },
  { kind: 'agent', text: PLAN },
];

describe('planAnswer', () => {
  it('offers the answer of a plan-mode turn with no plan_exit', () => {
    expect(planAnswer(textTurn, 'plan', false)).toBe(PLAN);
  });
  it('offers nothing when the turn called plan_exit', () => {
    expect(planAnswer([...textTurn, { kind: 'tool', toolName: 'plan_exit' }], 'plan', false)).toBeNull();
  });
  it('offers nothing outside plan mode, while running, or with no answer', () => {
    expect(planAnswer(textTurn, 'build', false)).toBeNull();
    expect(planAnswer(textTurn, 'deep-plan', false)).toBeNull();
    expect(planAnswer(textTurn, 'plan', true)).toBeNull();
    expect(planAnswer([{ kind: 'user', text: 'hi' }], 'plan', false)).toBeNull();
  });
  it('reads only the last turn: an earlier plan_exit does not hide a new text answer', () => {
    const rows = [{ kind: 'user', text: 'a' }, { kind: 'tool', toolName: 'plan_exit' }, ...textTurn];
    expect(planAnswer(rows, 'plan', false)).toBe(PLAN);
  });
});

describe('ReviewAsPlan', () => {
  it('in plan mode, the button sends a turn that carries the answer and asks for the plan file + plan_exit', async () => {
    const onSend = vi.fn();
    const { container } = render(ReviewAsPlan, { sessionId: 's1', rows: textTurn, inFlight: false, onSend });
    expect(container.querySelector('button')).toBeNull();
    await post({ type: 'modeUpdate', sessionId: 's1', mode: 'plan' });
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Review as plan');
    await fireEvent.click(button);
    expect(onSend).toHaveBeenCalledWith(reviewAsPlanPrompt(PLAN));
    const sent = onSend.mock.calls[0]![0] as string;
    expect(sent).toContain(PLAN);
    expect(sent).toContain('plan file');
    expect(sent).toContain('plan_exit');
  });
  it('a mode message for another chat does not show it', async () => {
    const { container } = render(ReviewAsPlan, { sessionId: 's1', rows: textTurn, inFlight: false, onSend: vi.fn() });
    await post({ type: 'modeUpdate', sessionId: 's2', mode: 'plan' });
    expect(container.querySelector('button')).toBeNull();
  });
});
