// WHICH RIGHT-RAIL CHIP STARTS OPEN, AND WHAT ITS SHUT LINE SAYS.
//
// A rule with a wrong answer, so it is a pure function rather than three
// `$state` initialisers in a component: a chip that starts CLOSED over
// something the owner has not set yet hides work from them — an Origami with
// no display name, an owner with nobody to talk to, a front desk allowed to
// read nothing — and a chip that starts OPEN over something already set
// re-opens, on every reload, a form nobody asked to see.
//
// The owner's own clicks outrank both. A saved value for a chip is used as it
// stands; only a chip the owner has never touched falls back to the facts.

import type { FlockScope } from './flockTypes';

/** The three things an owner sets once. The Front Desk is not one of them —
 *  it is a card, always open, because a broken desk refuses every question. */
export type ChipId = 'identity' | 'invite' | 'permissions';

/** What the pane knows about whether each chip's thing is set yet. */
export interface ChipFacts {
  /** The identity carries a display name. */
  named: boolean;
  /**
   * There is at least one contact.
   *
   * NOT "an invite string exists": the invite is minted on a button press and
   * is '' on every load, so that fact would open this chip for ever. Having
   * nobody to talk to is the state the invite chip is the fix for.
   */
  hasContacts: boolean;
  /** The front desk may read something — any repo, wiki path or folder. */
  shared: boolean;
}

const ALL: ChipId[] = ['identity', 'invite', 'permissions'];

/** True = open. */
function fromFacts(facts: ChipFacts): Record<ChipId, boolean> {
  return { identity: !facts.named, invite: !facts.hasContacts, permissions: !facts.shared };
}

/**
 * The open/shut map to render, given what the webview state remembered and
 * what is actually set. A saved entry wins; an absent one takes the fact.
 */
export function chipOpen(
  saved: Partial<Record<ChipId, boolean>> | undefined,
  facts: ChipFacts,
): Record<ChipId, boolean> {
  const defaults = fromFacts(facts);
  const out = {} as Record<ChipId, boolean>;
  for (const id of ALL) out[id] = typeof saved?.[id] === 'boolean' ? (saved[id] as boolean) : defaults[id];
  return out;
}

/** What a scope shares, across all three lists. ONE counter, exported: four
 *  places added the same lengths up by hand, and all four had to move together. */
export function scopeCount(scope: FlockScope | undefined): number {
  return (scope?.repos?.length ?? 0) + (scope?.wiki?.length ?? 0) + (scope?.folders?.length ?? 0);
}

/** The permissions chip's shut line. "By default": a contact's own Edit
 *  popover can grant them more or less, so this count is a starting point. */
export function scopeSummary(scope: FlockScope | undefined): string {
  const count = scopeCount(scope);
  if (count === 0) return 'Nothing shared by default';
  return `${count} ${count === 1 ? 'path' : 'paths'} shared by default`;
}
