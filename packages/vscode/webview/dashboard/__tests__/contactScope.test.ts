// THE OVERLAY BEHIND THE EDIT POPOVER — panes/contactScope.ts.
//
// The popover draws ONE set of pills out of TWO lists: the desk's defaults and
// this contact's own override. Every wrong answer here is silent on screen:
//
//  - a default the contact has been cut off from that stops rendering, so the
//    only way to notice the decision would be to remember the default and spot
//    the absence;
//  - a pill that renders unmarked while the contact cannot in fact read it;
//  - a click that posts a DELTA instead of the whole scope, which the engine
//    stores as "share only this" — the reduction the owner did not ask for.
//
// Asserted as values, not as a render, for the reason the repo's guide gives:
// jsdom has no layout and no styles, so a test that queried the mark would be
// asserting a class name, not a mark anybody can see.
import { describe, expect, it } from 'vitest';
import { autoPill, effectiveScope, overridden, ownScope, pillLabel, scopePills, toggledScope } from '../panes/contactScope';
import type { FlockFriendRow, FlockScope, FlockScopeOptions } from '../panes/flockTypes';

const DESK: FlockScope = { repos: ['C:/Repos/work/api'], wiki: ['wiki/pages', 'wiki/drafts'], folders: ['D:/notes'] };

// No known options by default: most of the suite is about the desk/contact
// overlay, which is the same arithmetic whether or not the workspace can
// offer anything extra. The tests that ARE about known options say so.
const NO_OPTIONS: FlockScopeOptions = { repos: [], wiki: [] };

const friend = (policy: FlockFriendRow['policy']): FlockFriendRow => ({
  handle: 'robin@abc',
  handleShort: 'robin@abc',
  name: 'robin',
  addedAt: '2026-09-01T00:00:00.000Z',
  policy,
  spentToday: 0,
  effective: { autoAnswer: false },
});

describe('effectiveScope — what applies to one contact today', () => {
  it('a contact with no override of their own gets the desk lists', () => {
    expect(effectiveScope(friend({}), DESK)).toEqual(DESK);
  });

  it('an override REPLACES the desk lists rather than adding to them', () => {
    // The engine stores a scope, not a delta (`FlockPolicy.resolve`), so a
    // contact with `{ wiki: [...] }` of their own shares NO repos at all — and
    // the popover has to show that, or the owner reads a repo pill as on.
    expect(effectiveScope(friend({ scope: { wiki: ['wiki/drafts'] } }), DESK)).toEqual({
      repos: [],
      wiki: ['wiki/drafts'],
      folders: [],
    });
  });

  it('no contact and no desk scope is three empty lists, never undefined', () => {
    expect(effectiveScope(undefined, undefined)).toEqual({ repos: [], wiki: [], folders: [] });
  });
});

describe('scopePills — known options, the desk list and the contact list, overlaid', () => {
  it('shows every default ON, isDefault and unmarked for a contact who overrides nothing', () => {
    expect(scopePills(friend({}), DESK, NO_OPTIONS)).toEqual([
      { kind: 'repos', value: 'C:/Repos/work/api', label: 'api', on: true, isDefault: true, differs: false },
      { kind: 'wiki', value: 'wiki/pages', label: 'wiki/pages', on: true, isDefault: true, differs: false },
      { kind: 'wiki', value: 'wiki/drafts', label: 'wiki/drafts', on: true, isDefault: true, differs: false },
      { kind: 'folders', value: 'D:/notes', label: 'notes', on: true, isDefault: true, differs: false },
    ]);
  });

  it('keeps a default they were cut off from — OFF and MARKED, isDefault still true', () => {
    const pills = scopePills(friend({ scope: { wiki: ['wiki/drafts'] } }), DESK, NO_OPTIONS);
    // Every default is still a row. Dropping the ones that are off would leave
    // "reduced for this person" looking identical to the default.
    expect(pills.map((p) => p.value)).toEqual(['C:/Repos/work/api', 'wiki/pages', 'wiki/drafts', 'D:/notes']);
    expect(pills.filter((p) => p.on).map((p) => p.value)).toEqual(['wiki/drafts']);
    expect(pills.filter((p) => p.isDefault).map((p) => p.value)).toEqual([
      'C:/Repos/work/api',
      'wiki/pages',
      'wiki/drafts',
      'D:/notes',
    ]);
    expect(pills.filter((p) => p.differs).map((p) => p.value)).toEqual([
      'C:/Repos/work/api',
      'wiki/pages',
      'D:/notes',
    ]);
  });

  it('shows something ADDED for this contact alone — on, differs, NOT isDefault, after the defaults', () => {
    const pills = scopePills(friend({ scope: { ...DESK, folders: ['D:/notes', 'E:/tax'] } }), DESK, NO_OPTIONS);
    const extra = pills.find((p) => p.value === 'E:/tax');
    expect(extra).toEqual({ kind: 'folders', value: 'E:/tax', label: 'tax', on: true, isDefault: false, differs: true });
    // ...and it appears exactly once, after the default it was added beside.
    expect(pills.filter((p) => p.value === 'E:/tax')).toHaveLength(1);
    expect(pills[pills.length - 1]!.value).toBe('E:/tax');
  });

  it('a desk that shares nothing and offers nothing has no pills at all', () => {
    expect(scopePills(friend({}), undefined, NO_OPTIONS)).toEqual([]);
  });

  it('a known repo that is neither a default nor the contact\'s own is off, not default, not differs', () => {
    const options: FlockScopeOptions = { repos: [{ root: 'C:/Repos/side/tools', name: 'tools' }], wiki: [] };
    const pills = scopePills(friend({}), DESK, options);
    expect(pills.find((p) => p.value === 'C:/Repos/side/tools')).toEqual({
      kind: 'repos', value: 'C:/Repos/side/tools', label: 'tools', on: false, isDefault: false, differs: false,
    });
  });

  it('an unknown repo the desk shares still appears, ON and isDefault — it cannot be dropped by accident', () => {
    // DESK shares 'C:/Repos/work/api', which is not in `options.repos` at all
    // (no registry entry for it, e.g. a hand-typed glob from before this pane
    // existed). It has to render regardless, or a click elsewhere could write
    // it out of the contact's scope with nobody deciding to remove it.
    const options: FlockScopeOptions = { repos: [{ root: 'C:/Repos/side/tools', name: 'tools' }], wiki: [] };
    const pills = scopePills(friend({}), DESK, options);
    expect(pills.find((p) => p.value === 'C:/Repos/work/api')).toEqual({
      kind: 'repos', value: 'C:/Repos/work/api', label: 'api', on: true, isDefault: true, differs: false,
    });
  });

  it('a contact-only folder is on and differs, listed after the known and default entries', () => {
    const options: FlockScopeOptions = { repos: [{ root: 'C:/Repos/side/tools', name: 'tools' }], wiki: [] };
    const pills = scopePills(friend({ scope: { folders: ['D:/notes', 'F:/side-project'] } }), DESK, options);
    const repoAndFolderValues = pills.filter((p) => p.kind === 'repos' || p.kind === 'folders').map((p) => p.value);
    expect(repoAndFolderValues).toEqual(['C:/Repos/side/tools', 'C:/Repos/work/api', 'D:/notes', 'F:/side-project']);
    expect(pills.find((p) => p.value === 'F:/side-project')).toEqual({
      kind: 'folders', value: 'F:/side-project', label: 'side-project', on: true, isDefault: false, differs: true,
    });
  });

  it('a repo\'s label is its REGISTERED name, not its root path', () => {
    const options: FlockScopeOptions = { repos: [{ root: 'C:/Repos/acme/site', name: 'site' }], wiki: [] };
    const pills = scopePills(friend({}), undefined, options);
    expect(pills).toEqual([
      { kind: 'repos', value: 'C:/Repos/acme/site', label: 'site', on: false, isDefault: false, differs: false },
    ]);
  });
});

describe('toggledScope — a known, non-default repo toggled ON', () => {
  it('posts the effective scope PLUS that repo, leaving the rest as they were', () => {
    // A pill that is known but not yet shared: clicking it has to ADD it to
    // whatever the contact already has, not replace their scope with it alone.
    expect(toggledScope(friend({}), DESK, 'repos', 'C:/Repos/side/tools')).toEqual({
      repos: ['C:/Repos/work/api', 'C:/Repos/side/tools'],
      wiki: ['wiki/pages', 'wiki/drafts'],
      folders: ['D:/notes'],
    });
  });
});

describe('toggledScope — what a pill CLICK posts', () => {
  it('posts the whole scope minus one entry, not a delta', () => {
    // A delta would be stored as the contact's entire scope, which is the
    // quiet reduction this shape exists to prevent.
    expect(toggledScope(friend({}), DESK, 'wiki', 'wiki/pages')).toEqual({
      repos: ['C:/Repos/work/api'],
      wiki: ['wiki/drafts'],
      folders: ['D:/notes'],
    });
  });

  it('adds an entry the contact did not have, leaving the rest as they were', () => {
    expect(toggledScope(friend({ scope: { wiki: ['wiki/drafts'] } }), DESK, 'folders', 'E:/tax')).toEqual({
      repos: [],
      wiki: ['wiki/drafts'],
      folders: ['E:/tax'],
    });
  });
});

describe('autoPill and the reset gate', () => {
  it('follows the desk default and says so is NOT a decision', () => {
    expect(autoPill(friend({}), true)).toEqual({ on: true, differs: false });
    expect(autoPill(friend({}), false)).toEqual({ on: false, differs: false });
  });

  it('marks an override even when it happens to agree — no: agreeing is not a difference', () => {
    expect(autoPill(friend({ autoAnswer: true }), true)).toEqual({ on: true, differs: false });
    expect(autoPill(friend({ autoAnswer: true }), false)).toEqual({ on: true, differs: true });
    expect(autoPill(friend({ autoAnswer: false }), true)).toEqual({ on: false, differs: true });
  });

  it('Reset is offered for ANY override, and for none of them when there is none', () => {
    // Scope alone, auto-answer alone and a budget alone are each an override
    // the owner has to be able to undo; a gate that watched only the scope
    // would leave the other two with no way back to the default.
    expect(overridden(friend({}))).toBe(false);
    expect(overridden(friend({ scope: {} }))).toBe(true);
    expect(overridden(friend({ autoAnswer: false }))).toBe(true);
    expect(overridden(friend({ dailyBudgetTokens: 100 }))).toBe(true);
    expect(overridden(undefined)).toBe(false);
    // `ownScope` is the narrower question, and only the scope answers it.
    expect(ownScope(friend({ autoAnswer: false }))).toBe(false);
    expect(ownScope(friend({ scope: {} }))).toBe(true);
  });
});

describe('pillLabel', () => {
  it('keeps the tail of a path, on either separator, and a wiki entry whole', () => {
    expect(pillLabel({ kind: 'repos', value: 'C:/Repos/acme/site' })).toBe('site');
    expect(pillLabel({ kind: 'folders', value: 'D:\\notes\\2026\\' })).toBe('2026');
    // A wiki entry is already short AND is the thing the owner ticked by that
    // name, so trimming it to `pages` would name a different-looking share.
    expect(pillLabel({ kind: 'wiki', value: 'wiki/pages' })).toBe('wiki/pages');
  });
});
