// effortOrder.test.ts — the Effort popover must read low-to-high whatever
// order the backend advertised, per t-djfz21 (UAT 0.4.135 screenshot: a
// ChatGPT catalog entry rendered Medium, Low, High, Xhigh, Max, Ultra
// because catalogDefaultFirst puts the default first, not the weakest).

import { describe, expect, it } from 'vitest';
import { orderEffortLevels } from './effortOrder';

type Opt = { value: string; name: string };
const opt = (value: string, name = value): Opt => ({ value, name });

describe('orderEffortLevels', () => {
  it('sorts the UAT ladder [medium, low, high, xhigh, max, ultra] into rank order', () => {
    const ladder = [opt('medium', 'Medium'), opt('low', 'Low'), opt('high', 'High'),
      opt('xhigh', 'Xhigh'), opt('max', 'Max'), opt('ultra', 'Ultra')];
    expect(orderEffortLevels(ladder).map(o => o.value))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('leaves an already-ordered ladder unchanged', () => {
    const ladder = [opt('none'), opt('minimal'), opt('low'), opt('medium'),
      opt('high'), opt('xhigh'), opt('max'), opt('ultra')];
    expect(orderEffortLevels(ladder).map(o => o.value)).toEqual(ladder.map(o => o.value));
  });

  it('puts an unknown level name after every known level', () => {
    const ladder = [opt('medium'), opt('quantum'), opt('low'), opt('high')];
    expect(orderEffortLevels(ladder).map(o => o.value)).toEqual(['low', 'medium', 'high', 'quantum']);
  });

  it('keeps two unknown names in their advertised relative order (stable sort)', () => {
    const ladder = [opt('zeta'), opt('medium'), opt('alpha')];
    expect(orderEffortLevels(ladder).map(o => o.value)).toEqual(['medium', 'zeta', 'alpha']);
  });

  it('does not mutate the input array', () => {
    const ladder = [opt('high'), opt('low')];
    const copy = [...ladder];
    orderEffortLevels(ladder);
    expect(ladder).toEqual(copy);
  });

  it('handles empty input', () => {
    expect(orderEffortLevels([])).toEqual([]);
  });

  it('sorting never changes which value counts as "current" — the caller still finds it', () => {
    const ladder = [opt('medium'), opt('low'), opt('high'), opt('xhigh'), opt('max'), opt('ultra')];
    const sorted = orderEffortLevels(ladder);
    const current = 'medium';
    expect(sorted.find(o => o.value === current)?.value).toBe('medium');
    // and it is still the one that would be highlighted, wherever it landed
    expect(sorted.some(o => o.value === current)).toBe(true);
  });
});
