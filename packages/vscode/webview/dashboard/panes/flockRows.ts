// WHAT A CONTACT ROW SHOWS, AND WHICH CONTACTS ARE SHOWN AT ALL.
//
// Four pure functions, out of the component, because three of them answer a
// question that has a wrong answer: the wrong name in the first line, the wrong
// row surviving a search, or the same colour on two people the search exists to
// tell apart. A component test can assert what is on screen; only these can be
// asserted against every input that reaches them.
//
// THE TWO NAMES. `name` is what a contact calls THEMSELVES — it rides in their
// invite and is refreshed by every frame of theirs that verifies — so an owner
// with three contacts called "dana" has three identical rows and nothing to
// click. `displayName` is the owner's own label, and it leads. The handle stays
// on the row under it, because the local label is not who signed the envelope
// and a pane that hid that would teach that it was.

import { scopeCount } from './flockChips';
import type { FlockFriendRow } from './flockTypes';

/** The line a row leads with: the owner's label, else the name they use. */
export function displayNameOf(friend: { name: string; displayName?: string }): string {
  const label = friend.displayName?.trim();
  return label ? label : friend.name;
}

/**
 * The mark an Origami shows when it has not said which one it wants — the crane,
 * which is the brand sigil itself. It is here rather than imported from the
 * engine because the webview shares no module with it, and it must match
 * `FlockIdentity.ICON_DEFAULT`: an extension and an engine ship separately, so
 * this is also what an engine too old to send the field renders as.
 */
export const ICON_DEFAULT = 'crane';

/** The icon id to draw for a row, defaulted. */
export function iconOf(row: { icon?: string }): string {
  return row.icon?.trim() ? row.icon : ICON_DEFAULT;
}

/**
 * Which of the four state colours an avatar takes. Keyed off the FULL handle,
 * so two friends who share a display name still differ — the fingerprint is the
 * only part of a handle that cannot collide, and it is what the hash sees.
 */
const TINTS = ['--og-chat', '--og-accent-2', '--og-success', '--og-status-waiting'] as const;
export function avatarTint(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  return `var(${TINTS[hash % TINTS.length]})`;
}

/**
 * THE SEARCH. Matches a contact on any of the three things an owner would type:
 * the label they gave them, the name the contact uses, and the START of the
 * handle.
 *
 * The handle is matched as a PREFIX and the two names as substrings, and the
 * difference is deliberate. A name is read and remembered in pieces ("gym"
 * finds "Dana from the gym"); a handle is 43 characters of base64 that nobody
 * remembers the middle of, and a substring match on it would make an arbitrary
 * three-character query hit half the flock for no reason a reader could see.
 *
 * An empty or blank query returns EVERY contact rather than none: a search box
 * that hides the list until it is typed in is a list that has been lost.
 */
export function filterFriends<T extends { name: string; displayName?: string; handle: string }>(
  friends: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...friends];
  return friends.filter((friend) => {
    const label = displayNameOf(friend).toLowerCase();
    if (label.includes(needle)) return true;
    if (friend.name.toLowerCase().includes(needle)) return true;
    return friend.handle.toLowerCase().startsWith(needle);
  });
}

/** The one-line summary of what a contact may do, for the row's chip. */
export function policyChip(friend: FlockFriendRow): string {
  const own = scopeCount(friend.policy.scope);
  const answer = friend.effective.autoAnswer ? 'auto' : 'waits for you';
  return `${answer} · ${own === 0 ? 'default scope' : `${own} of their own`}`;
}
