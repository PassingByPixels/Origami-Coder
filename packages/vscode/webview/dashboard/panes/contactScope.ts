// What one contact may see, as pills: the arithmetic behind the Edit
// popover. Every option is overlaid with the desk's defaults and this
// contact's own, so the owner reads one set of pills, not three lists
// diffed by eye. Pure, no DOM.

import type {
  FlockFriendRow, FlockPickedFolder, FlockScope, FlockScopeKind, FlockScopeOptions, FlockState,
} from './flockTypes';

/** EVERYTHING THE EDIT POPOVER NEEDS, AS ONE PROP: FlockThread.svelte has no room for four. */
export interface ContactEdit {
  /** The whole `flock_state`. NOT called `state`: that name shadows the
   *  `$state` rune, and every `$state(...)` in the component would silently
   *  compile to a store subscription on the prop instead. */
  flock: FlockState;
  picked: FlockPickedFolder | null;
  /** Known repos and wiki folders, so a contact can be granted one the desk doesn't yet share. */
  options: FlockScopeOptions;
  /** The pane's own `post` — the single door out of the webview. */
  onpost: (msg: Record<string, unknown>) => void;
}

export const SCOPE_KINDS: readonly FlockScopeKind[] = ['repos', 'wiki', 'folders'];

export interface ScopePill {
  kind: FlockScopeKind;
  /** The stored value — a repo root, a wiki folder, an absolute folder path. */
  value: string;
  /** A repo's registered name, a wiki path whole, or a folder's short tail. */
  label: string;
  /** In this contact's effective scope. */
  on: boolean;
  /** In the desk's own default list. */
  isDefault: boolean;
  /** Disagrees with the desk default: either added for them or taken away. */
  differs: boolean;
}

/** Whether this contact has a scope of their own at all. */
export function ownScope(friend: FlockFriendRow | undefined): boolean {
  return friend?.policy.scope !== undefined;
}

/** Whether ANY default is overridden for them — what "Reset to default" undoes. */
export function overridden(friend: FlockFriendRow | undefined): boolean {
  const policy = friend?.policy;
  if (!policy) return false;
  return policy.scope !== undefined || policy.autoAnswer !== undefined || policy.dailyBudgetTokens !== undefined;
}

/** The scope that actually applies to them: their own, else the desk's. */
export function effectiveScope(friend: FlockFriendRow | undefined, desk: FlockScope | undefined): FlockScope {
  const source = friend?.policy.scope ?? desk;
  return { repos: source?.repos ?? [], wiki: source?.wiki ?? [], folders: source?.folders ?? [] };
}

/** What the workspace can offer for one kind (no list for folders — only Browse). */
function knownValues(kind: FlockScopeKind, options: FlockScopeOptions): string[] {
  if (kind === 'repos') return options.repos.map((repo) => repo.root);
  if (kind === 'wiki') return options.wiki;
  return [];
}

/** A repo's registered name when known, else the fallback tail every other kind uses. */
function labelFor(kind: FlockScopeKind, value: string, options: FlockScopeOptions): string {
  const known = kind === 'repos' ? options.repos.find((repo) => repo.root === value) : undefined;
  return known ? known.name : pillLabel({ kind, value });
}

/** Every pill to draw: known options first, then desk defaults, then the
 *  contact's own — the union, so a cut-off default still appears. */
export function scopePills(
  friend: FlockFriendRow | undefined,
  desk: FlockScope | undefined,
  options: FlockScopeOptions,
): ScopePill[] {
  const effective = effectiveScope(friend, desk);
  const out: ScopePill[] = [];
  for (const kind of SCOPE_KINDS) {
    const defaults = desk?.[kind] ?? [];
    const mine = effective[kind] ?? [];
    const seen = new Set<string>();
    for (const value of [...knownValues(kind, options), ...defaults, ...mine]) {
      if (seen.has(value)) continue;
      seen.add(value);
      const on = mine.includes(value);
      const isDefault = defaults.includes(value);
      out.push({ kind, value, label: labelFor(kind, value, options), on, isDefault, differs: on !== isDefault });
    }
  }
  return out;
}

/** The scope to post when a pill is clicked: the effective list with that
 *  entry flipped, as the whole three arrays (the engine stores no delta). */
export function toggledScope(
  friend: FlockFriendRow | undefined,
  desk: FlockScope | undefined,
  kind: FlockScopeKind,
  value: string,
): FlockScope {
  const scope = effectiveScope(friend, desk);
  const list = scope[kind] ?? [];
  const next = list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
  return { ...scope, [kind]: next };
}

/** Auto-answer pill: on/off as it applies, plus whether that was decided for this contact. */
export function autoPill(
  friend: FlockFriendRow | undefined,
  deskAutoAnswer: boolean,
): { on: boolean; differs: boolean } {
  const own = friend?.policy.autoAnswer;
  return { on: own ?? deskAutoAnswer, differs: own !== undefined && own !== deskAutoAnswer };
}

/** The short label a pill falls back to: a path's tail; a wiki entry is
 *  already short and is left whole. */
export function pillLabel(pill: { kind: FlockScopeKind; value: string }): string {
  if (pill.kind === 'wiki') return pill.value;
  const parts = pill.value.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? pill.value;
}
