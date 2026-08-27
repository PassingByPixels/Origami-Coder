// Which reasoning-block message ids the user opened by hand. Every stream
// delta re-renders the thought row (appendToMessage replaces the message
// object), which re-fires ThoughtPill's `open` attribute effect on the SAME
// <details> node — so if the caller doesn't track what the user actually did,
// that reassertion silently re-closes a block the user just expanded. Kept as
// a plain array on the session (mirrors subagentsDismissed) so ChatPane's
// render can derive a real, per-id boolean instead of a raw "is live" flag.
// Pure — no Svelte, so it is unit-testable without a DOM.

export function isThoughtOpen(ids: number[] | undefined, msgId: number): boolean {
  return (ids ?? []).includes(msgId);
}

export function withThoughtOpen(ids: number[] | undefined, msgId: number, open: boolean): number[] {
  const next = new Set(ids ?? []);
  if (open) next.add(msgId);
  else next.delete(msgId);
  return [...next];
}
