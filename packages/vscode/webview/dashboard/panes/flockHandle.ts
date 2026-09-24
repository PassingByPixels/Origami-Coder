// TRUNCATING A HANDLE, IN ONE PLACE.
//
// A flock handle is `name@` plus the whole sha256 of the signing key — 43
// base64url characters. Every surface that lists one has to shorten it (a row
// whose first line is forty-three characters of base64 buries the thing the
// row exists to show), and every surface that shortens it is one slice away
// from someone eventually MATCHING on the short form.
//
// So it is a named function and not an inline slice, it says what it is for in
// its name, and the engine has the same function under the same rule
// (`FlockIdentity.short`). The pane's own rows use the `handleShort` the engine
// already sends; this is for the two places that receive a raw handle instead —
// the permission queue's `from`, and the answer log's.

/** How much of a fingerprint a label shows. Matches `FlockIdentity.SHORT_LENGTH`. */
export const SHORT_LENGTH = 8;

/**
 * `name@` plus the first {@link SHORT_LENGTH} characters, with an ellipsis so
 * the reader can see it is cut. DISPLAY ONLY: never pass the result to anything
 * that looks a friend up. A handle with no `@` comes back untouched rather than
 * losing its first eight characters to a slice that assumed one.
 */
export function shortHandle(handle: string): string {
  const at = handle.lastIndexOf('@');
  if (at < 0) return handle;
  return `${handle.slice(0, at + 1)}${handle.slice(at + 1, at + 1 + SHORT_LENGTH)}…`;
}
