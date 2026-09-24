// boardVisibility.test.ts — the rail-visibility rule as PURE logic, no DOM:
// the real regression to catch is the rule itself drifting, not a render that
// happens to look right in jsdom (which has no layout engine to begin with).
//
// The remote-device-key lane REVERSED the hide: the Remote row is drawn either
// way now. The argument stays on both functions for the sibling lane's switch,
// so both values are still pinned — a row that started dropping again on one
// of them is exactly the regression these four cases exist to catch.
import { describe, expect, it } from 'vitest';
import { resolveView, visibleViews } from '../panes/boardVisibility';
import { VIEWS } from '../panes/boardViews';

describe('visibleViews', () => {
  it('includes remote when the setting is off (the default) — the row is not the gate', () => {
    expect(visibleViews(false).some((v) => v.id === 'remote')).toBe(true);
  });

  it('includes remote when the setting is on', () => {
    expect(visibleViews(true).some((v) => v.id === 'remote')).toBe(true);
  });

  it('matches the full VIEWS table exactly with the setting off', () => {
    expect(visibleViews(false)).toEqual(VIEWS);
  });

  it('matches the full VIEWS table exactly while the setting is on', () => {
    expect(visibleViews(true)).toEqual(VIEWS);
  });
});

describe('resolveView', () => {
  it('keeps a persisted remote view when the setting is on', () => {
    expect(resolveView('remote', true)).toBe('remote');
  });

  it('keeps a persisted remote view with the setting off too — the row is drawn either way', () => {
    expect(resolveView('remote', false)).toBe('remote');
  });

  it('falls back to the default view for an id with no matching row (a deleted view)', () => {
    expect(resolveView('routings', true)).toBe('flock');
    expect(resolveView('routings', false)).toBe('flock');
  });

  it('falls back to the default view for a non-string id', () => {
    expect(resolveView(undefined, true)).toBe('flock');
    expect(resolveView(42, true)).toBe('flock');
  });
});
