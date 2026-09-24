// Origami Remote — WHAT THIS PHONE SAYS IT CAN OPEN.
//
// `restoreMessagesZ` is a deflated `restoreMessages`, and a page that cannot
// inflate it paints an EMPTY transcript over the owner's chat. The iOS shell
// ships its own copy of the phone web layer, so the desk cannot assume the page
// is the one in this tree.
//
// So the phone DECLARES: `remote/hello` carries an optional `caps: string[]`,
// and a hello without one declares nothing — the plain 80-row tail. Per socket,
// stamped on the WEBVIEW, so the mark dies with the socket by construction.

/** The capability name a phone declares when it can inflate `restoreMessagesZ`. */
export const RESTORE_Z_CAP = 'restoreZ';

/** Where the declared caps are stamped, beside `REMOTE_VIEW_BRAND`. */
export const REMOTE_CAPS_BRAND = '__origamiRemoteCaps';

/** The `caps` a `remote/hello` declares. Absent, not an array, or carrying
 *  non-strings: no caps at all — a malformed hello declares nothing. */
export function helloCaps(msg: unknown): string[] {
  const caps = (msg as { caps?: unknown } | null)?.caps;
  if (!Array.isArray(caps)) return [];
  return caps.filter((cap): cap is string => typeof cap === 'string');
}

/** Record what the phone declared; a socket with no hello stays uncapable. */
export function markCaps(webview: unknown, caps: readonly string[]): void {
  const target = webview as Record<string, unknown> | null;
  if (!target) return;
  target[REMOTE_CAPS_BRAND] = [...caps];
}

/** True only when THIS phone said it can inflate the compressed envelope. */
export function remoteAcceptsZ(webview: unknown): boolean {
  const caps = (webview as Record<string, unknown> | null)?.[REMOTE_CAPS_BRAND];
  return Array.isArray(caps) && caps.includes(RESTORE_Z_CAP);
}
