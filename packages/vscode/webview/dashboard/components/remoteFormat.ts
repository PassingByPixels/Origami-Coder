// The words the Remote pane's status header says, as pure functions.
//
// Split out of the pane rather than inlined because every one of them is a
// SENTENCE THE OWNER READS as the whole truth about the feature — "Paired ·
// bertha · 2 min ago" is the one line that answers "can my phone reach this
// machine". A pure module can be asserted without a DOM, so the wording is
// held by tests that cannot pass by rendering something plausible.
//
// `deviceLabel` carries the naming rule in one place: a name the user typed
// wins, and with none the rid prefix is the pairing's only handle. The phone
// never sends a name (the pairing is anonymous by design), so a name is always
// something the desktop was told, never something the wire supplied.

/** The relay's host, for the pill. Falls back to the raw string: a URL the
 *  user is mid-way through typing must still show as itself, not as blank. */
export function relayHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** How long ago, in the mock's own units: seconds, then minutes, then hours. */
export function ago(ms: number | null): string {
  if (!ms) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** The eight-character rid prefix, with the ellipsis that says it is a prefix. */
export function ridPrefix(rid: string | null): string {
  return rid ? `${rid.slice(0, 8)}…` : '';
}

/** What to CALL this pairing: the name the user gave it, else the rid prefix. */
export function deviceLabel(name: string, rid: string | null): string {
  const trimmed = name.trim();
  return trimmed || ridPrefix(rid);
}

/** Two characters for the avatar circle, from the name if there is one. */
export function avatarInitials(name: string, rid: string | null): string {
  const source = name.trim() || rid || '';
  return source.slice(0, 2).toLowerCase();
}

/** A name is a LABEL, not a field: trimmed, one line, and short enough that the
 *  device row cannot be pushed out of shape by a pasted paragraph.
 *
 *  DUPLICATED, deliberately: the host enforces the same limit in
 *  src/remote/deviceNames.ts and the webview tsconfig pins rootDir to
 *  `webview/`, so neither tree can import the other's copy (TS6059). The two
 *  are held equal by an assertion in remotePane.test.ts, which can see both. */
export const DEVICE_NAME_MAX = 40;
