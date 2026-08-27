import { describe, it, expect } from 'vitest';
import { isThoughtOpen, withThoughtOpen } from './thoughtOpenState';

describe('thoughtOpenState', () => {
  it('an id absent from the list is not open', () => {
    expect(isThoughtOpen(undefined, 7)).toBe(false);
    expect(isThoughtOpen([1, 2], 7)).toBe(false);
  });

  it('an id present in the list is open', () => {
    expect(isThoughtOpen([1, 7, 2], 7)).toBe(true);
  });

  it('opening adds the id once (no duplicates on repeat toggles)', () => {
    let ids = withThoughtOpen(undefined, 7, true);
    ids = withThoughtOpen(ids, 7, true);
    expect(ids).toEqual([7]);
  });

  it('closing removes the id and leaves siblings untouched', () => {
    const ids = withThoughtOpen([1, 7, 2], 7, false);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it('closing an id that was never open is a no-op', () => {
    expect(withThoughtOpen([1, 2], 7, false)).toEqual([1, 2]);
  });
});
