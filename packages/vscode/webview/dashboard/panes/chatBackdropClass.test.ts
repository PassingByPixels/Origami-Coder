import { describe, expect, it } from 'vitest';
import { chatBackdropOn } from './chatBackdropClass';

describe('chatBackdropOn (t-qn0wj5, proposal 24)', () => {
  it('is on only when the setting is on AND motion is not reduced', () => {
    expect(chatBackdropOn(true, false)).toBe(true);
  });
  it('is off when the setting is off, regardless of motion preference', () => {
    expect(chatBackdropOn(false, false)).toBe(false);
  });
  it('is off under reduced motion, even with the setting on', () => {
    expect(chatBackdropOn(true, true)).toBe(false);
  });
  it('is off when both gates say no', () => {
    expect(chatBackdropOn(false, true)).toBe(false);
  });
});
