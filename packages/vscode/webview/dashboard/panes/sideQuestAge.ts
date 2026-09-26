// t-yyz5je: the age a side-quest row shows ("today", "3 d"), read from the
// engine's `created` stamp. A leaf so the drawer stays under its cap and the
// rule is testable without a render.

const DAY_MS = 24 * 60 * 60 * 1000;

/** '' when `created` does not parse: a row then shows no age, never "NaN d". A
 *  stamp ahead of `now` (clock skew) reads "today". */
export function questAge(created: string, now: number = Date.now()): string {
  const at = Date.parse(created);
  if (Number.isNaN(at)) return '';
  const days = Math.floor((now - at) / DAY_MS);
  return days < 1 ? 'today' : `${days} d`;
}
