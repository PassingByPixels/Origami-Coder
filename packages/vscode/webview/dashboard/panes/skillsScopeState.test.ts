// skillsScopeState.ts — pure leaf behind the Skills pane's persisted
// Local/Global filter (t-7vslix). Placed beside the module it tests, the same
// convention skillsGrouping.ts's own describe block in skillsPane.test.ts
// follows for a pure leaf with no DOM dependency.
import { describe, it, expect } from 'vitest';
import { scopeIn, withScope, DEFAULT_SCOPE } from './skillsScopeState';

describe('scopeIn', () => {
  it('defaults to global with no saved state at all', () => {
    expect(scopeIn(undefined)).toBe('global');
    expect(DEFAULT_SCOPE).toBe('global');
  });

  it('defaults to global when the state object has no skillsScope key', () => {
    expect(scopeIn({ someOtherKey: true })).toBe('global');
  });

  it('reads back a saved local choice', () => {
    expect(scopeIn({ skillsScope: 'local' })).toBe('local');
  });

  it('falls back to the default on a malformed value rather than throwing', () => {
    expect(scopeIn({ skillsScope: 'nonsense' })).toBe('global');
    expect(scopeIn({ skillsScope: 42 })).toBe('global');
    expect(scopeIn(null)).toBe('global');
  });
});

describe('withScope', () => {
  it('keeps every other key the state object already carried', () => {
    expect(withScope({ unrelated: 'kept' }, 'local')).toEqual({ unrelated: 'kept', skillsScope: 'local' });
  });

  it('starts a fresh object from null state', () => {
    expect(withScope(null, 'global')).toEqual({ skillsScope: 'global' });
  });
});
