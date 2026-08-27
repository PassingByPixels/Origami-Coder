import { describe, expect, it } from 'vitest';
import { isTabWaiting } from './tabWaiting';

describe('isTabWaiting', () => {
  it('is false when neither a question nor a permission ask is open', () => {
    expect(isTabWaiting(false, false)).toBe(false);
  });

  it('is true when a question batch is open', () => {
    expect(isTabWaiting(true, false)).toBe(true);
  });

  it('is true when a permission approval is pending', () => {
    expect(isTabWaiting(false, true)).toBe(true);
  });

  it('is true when both a question and a permission ask are open at once', () => {
    expect(isTabWaiting(true, true)).toBe(true);
  });
});
