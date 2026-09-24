// changelogGate.ts — pure "show What's new or not" decision (t-obg1yz, t-v5r1fd).
// Kept separate from changelogPanel.ts (which owns vscode.WebviewPanel + fs) so the
// rule is testable with plain strings, no fakes required.
//
// t-v5r1fd: the pop-up shows only on a PUBLIC release (PUBLIC_RELEASES in
// publicReleases.ts). A dev or half build shows nothing and records nothing, so a user
// who comes from their last public version gets ONE summary of everything since then.

/** Compare two dotted numeric versions ("0.4.155"). Negative when a < b. A part that
 *  is missing or not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest public release strictly older than `version`, if any. */
export function previousPublicRelease(version: string, publicReleases: readonly string[]): string | undefined {
  return publicReleases
    .filter((r) => compareVersions(r, version) < 0)
    .sort(compareVersions)
    .at(-1);
}

/** The versions a What's new covers: everything after `from` (exclusive), up to and
 *  including `to`. `from` is undefined when there is nothing older to count from. */
export interface WhatsNewRange {
  from: string | undefined;
  to: string;
}

/**
 * Decide whether the pop-up shows on activation, and which versions it covers.
 * - `currentVersion` not in `publicReleases` (a dev or half build): undefined.
 * - Already seen, or a rollback to an older version: undefined.
 * - Otherwise from the last version the user saw (or, on a fresh install, the
 *   previous public release, so a new user gets this release only) to the current one.
 */
export function whatsNewRange(
  lastSeenVersion: string | undefined,
  currentVersion: string,
  publicReleases: readonly string[],
): WhatsNewRange | undefined {
  if (!publicReleases.includes(currentVersion)) return undefined;
  if (lastSeenVersion !== undefined && compareVersions(lastSeenVersion, currentVersion) >= 0) return undefined;
  return {
    from: lastSeenVersion ?? previousPublicRelease(currentVersion, publicReleases),
    to: currentVersion,
  };
}

/** The range the owner's preview command shows: what users on the last public
 *  release will get when `currentVersion` goes public. Never gated. */
export function previewRange(currentVersion: string, publicReleases: readonly string[]): WhatsNewRange {
  return { from: previousPublicRelease(currentVersion, publicReleases), to: currentVersion };
}
