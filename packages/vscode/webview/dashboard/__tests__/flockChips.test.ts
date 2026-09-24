// flockChips.test.ts — which right-rail chip starts open, and what its shut
// line says.
//
// Both halves have a wrong answer that hides something from the owner: a chip
// that starts CLOSED over an unset identity, an owner with nobody to talk to or
// a desk allowed to read nothing hides work they have not done; a chip that
// starts OPEN over something already set re-opens a form nobody asked for on
// every single reload. And a shut line reading "Permissions" instead of
// "Nothing shared by default" names the noun while saying nothing about the
// value, which is the entire reason the chips carry one.
import { describe, expect, it } from 'vitest';
import { chipOpen, scopeCount, scopeSummary } from '../panes/flockChips';

const SET = { named: true, hasContacts: true, shared: true };
const UNSET = { named: false, hasContacts: false, shared: false };

describe('chipOpen — the default', () => {
  it('opens every chip whose thing is not set yet', () => {
    expect(chipOpen(undefined, UNSET)).toEqual({ identity: true, invite: true, permissions: true });
  });

  it('shuts every chip whose thing IS set', () => {
    expect(chipOpen(undefined, SET)).toEqual({ identity: false, invite: false, permissions: false });
  });

  it('decides each chip on its OWN fact, not on the other two', () => {
    // A rule that read one flag for all three would pass both tests above and
    // open the identity form for somebody whose only unfinished thing is scope.
    expect(chipOpen(undefined, { ...SET, shared: false })).toEqual({
      identity: false,
      invite: false,
      permissions: true,
    });
    expect(chipOpen(undefined, { ...SET, named: false })).toEqual({
      identity: true,
      invite: false,
      permissions: false,
    });
    expect(chipOpen(undefined, { ...SET, hasContacts: false })).toEqual({
      identity: false,
      invite: true,
      permissions: false,
    });
  });
});

describe('chipOpen — what the owner clicked', () => {
  it('lets a saved value outrank the fact, in both directions', () => {
    expect(chipOpen({ permissions: false }, UNSET).permissions).toBe(false);
    expect(chipOpen({ identity: true }, SET).identity).toBe(true);
  });

  it('falls back to the fact for the chips the owner never touched', () => {
    const out = chipOpen({ identity: true }, SET);
    expect(out).toEqual({ identity: true, invite: false, permissions: false });
  });

  it('ignores a stored value that is not a boolean, rather than rendering it', () => {
    // Webview state survives a reload and an extension upgrade, so a shape from
    // an older build has to degrade to the rule rather than to a truthy string.
    const junk = { identity: 'yes', invite: null } as unknown as Partial<Record<'identity' | 'invite', boolean>>;
    expect(chipOpen(junk, SET)).toEqual({ identity: false, invite: false, permissions: false });
  });
});

describe('scopeSummary', () => {
  it('says "Nothing shared by default" for every shape of empty — it is the state that matters most', () => {
    // The desk can then answer from no files at all, which is a thing the owner
    // has to be able to read without opening anything.
    expect(scopeSummary(undefined)).toBe('Nothing shared by default');
    expect(scopeSummary({})).toBe('Nothing shared by default');
    expect(scopeSummary({ repos: [], wiki: [], folders: [] })).toBe('Nothing shared by default');
  });

  it('counts across all three lists, and gets the singular right', () => {
    expect(scopeSummary({ repos: ['work/api'] })).toBe('1 path shared by default');
    expect(scopeSummary({ repos: ['work/api'], wiki: ['wiki/pages'], folders: ['D:/notes'] })).toBe(
      '3 paths shared by default',
    );
  });

  it('a scope of FOLDERS alone is not "Nothing shared" — the summary counts them', () => {
    // The regression this guards is silent and total: a summary that counted
    // only repos and wiki would read "Nothing shared" over a desk that can in
    // fact read two folders, and the owner's only reason to open the chip is
    // that line.
    expect(scopeCount({ folders: ['D:/notes'] })).toBe(1);
    expect(scopeSummary({ folders: ['D:/notes'] })).toBe('1 path shared by default');
    expect(scopeSummary({ folders: ['D:/notes', 'E:/tax'] })).toBe('2 paths shared by default');
  });

  it('a `skills` list left over in a stored scope counts for nothing', () => {
    // Skills are not a permission any more. The engine drops the list on read;
    // a webview that still added its length in would show a number the picker
    // beside it could not account for.
    const stale = { repos: ['work/api'], skills: ['wrap', 'delegate'] } as unknown as Parameters<typeof scopeCount>[0];
    expect(scopeCount(stale)).toBe(1);
    expect(scopeSummary(stale)).toBe('1 path shared by default');
  });
});
