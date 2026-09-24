import { describe, expect, it } from 'vitest';
import { toggleFuse } from './contextFuse';

describe('contextFuse — toggleFuse', () => {
  it('idle -> armed on the first click', () => {
    expect(toggleFuse('idle')).toBe('armed');
  });
  it('armed -> idle on a second click (cancel)', () => {
    expect(toggleFuse('armed')).toBe('idle');
  });
});
