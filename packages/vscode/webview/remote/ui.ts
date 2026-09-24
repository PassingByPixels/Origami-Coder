// Origami Remote — the chrome the phone shell owns itself: a connection status
// strip, a notice strip, and the watch-only line. Everything else on screen is
// the real chat bundle.
//
// THE PIN SHEET IS GONE (2026-09-06). It was the road a keyless browser page
// used to approve a shell command; a page with no device key may now only
// watch, so there is nothing for it to type. What replaces it is one sentence,
// said when the reader tries something the desktop will not act on.

/** The message types a page holding NO device key is refused. Four names, not
 *  the desktop's whole verb table: this page must not become a second policy
 *  engine, so the message is still sent and the DESKTOP still does the
 *  refusing — this list only decides when to say so. `remoteVerbs.ts` is the
 *  authority, and it drops far more than these; these are the four a person
 *  actually reaches for. */
const KEYLESS_REFUSED: ReadonlySet<string> = new Set([
  'send',
  'sendWithImages',
  'permission',
  'remote/set-mode-request',
]);

export const WATCH_ONLY_TEXT = 'This page can watch. Use the app to send or approve.';

/** True when a keyless page just tried something the desktop will drop. A
 *  permission DENY is not one of them: refusing an ask is free at every tier,
 *  and telling someone their "no" was ignored would be a lie. */
export function isRefusedWhenKeyless(msg: unknown): boolean {
  const m = msg as { type?: unknown; optionId?: unknown } | null;
  if (typeof m?.type !== 'string' || !KEYLESS_REFUSED.has(m.type)) return false;
  if (m.type === 'permission') return m.optionId !== null && m.optionId !== undefined;
  return true;
}

/** Paint the watch-only line. Idempotent: it says the same thing however many
 *  times it is reached, so it is set once and left up. */
export function setWatchOnly(doc: Document): void {
  const el = doc.getElementById('remoteWatch');
  if (!el) return;
  el.textContent = WATCH_ONLY_TEXT;
  el.setAttribute('data-open', 'true');
}

/** Paint the fatal line — the shell's fourth strip, said once when the page
 *  cannot run at all. Here with the other three, not in `main.ts`. */
export function setFatal(doc: Document, text: string): void {
  const el = doc.getElementById('remoteFatal');
  if (!el) return;
  el.textContent = text;
  el.setAttribute('data-open', 'true');
}

/** Paint the page's own notice strip: the one thing on screen that is neither
 *  the status pill nor the chat bundle. `''` takes it down again. */
export function setNotice(doc: Document, text: string): void {
  const el = doc.getElementById('remoteNotice');
  if (!el) return;
  el.textContent = text;
  if (text) el.setAttribute('data-open', 'true');
  else el.removeAttribute('data-open');
}

/** Paint the connection strip. `detail` carries the last rejection, if any. */
export function setStatus(doc: Document, state: string, detail = ''): void {
  const el = doc.getElementById('remoteStatus');
  if (!el) return;
  el.setAttribute('data-state', state);
  el.textContent = detail ? `${state} — ${detail}` : state;
}
