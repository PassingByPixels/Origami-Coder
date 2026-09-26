// publicReleases.ts — THE PUBLIC-RELEASE MARKER (t-v5r1fd). The owner sets it here.
//
// The "What's new" pop-up shows only when the installed version is in this list.
// Dev and half builds are not in it, so users see nothing for them, and the marker
// of the last version they saw stays on their last public release. When a version
// here lands, they get ONE summary of everything since that release.
//
// To release a version to users:
//   1. Bump "version" in packages/vscode/package.json as usual.
//   2. Add that version to the end of this list.
//   3. Optional: write the curated text in packages/vscode/whats-new/<version>.md.
//      Without it the pop-up merges the CHANGELOG.md sections since the previous
//      public release, grouped by their ### headings.
// To see the pop-up before release: command palette, "Origami: Preview What's New".
//
// Oldest first. 0.4.155 was the last version users received before 0.4.175 (owner, 2026-09-24).
export const PUBLIC_RELEASES: readonly string[] = ['0.4.155', '0.4.175', '0.4.184'];
