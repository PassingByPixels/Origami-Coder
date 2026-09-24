import { describe, expect, it } from 'vitest';
import { chatDensityCompactFromGlobal } from './chatDensityClass';

describe('chatDensityCompactFromGlobal (t-qn0wj5, proposal 26)', () => {
  it('is Compact only on an exact true', () => {
    expect(chatDensityCompactFromGlobal({ __ORIGAMI_CHAT_DENSITY_COMPACT__: true })).toBe(true);
  });
  it('defaults to Comfortable (false) when absent', () => {
    expect(chatDensityCompactFromGlobal({})).toBe(false);
  });
  it('is Comfortable for a stale non-boolean value', () => {
    expect(chatDensityCompactFromGlobal({ __ORIGAMI_CHAT_DENSITY_COMPACT__: 'yes' })).toBe(false);
  });
  it('does not throw on an undefined window-like value', () => {
    expect(chatDensityCompactFromGlobal(undefined)).toBe(false);
  });
});
