// changelogActivate.ts — the activation-time hook for the What's new pop-up (t-obg1yz)
// and the owner's preview command (t-v5r1fd).
// Mirrors seedGlobal.ts's marker shape: a globalState version string. The marker is
// written as soon as we decide to show, not when the panel is closed — "once per
// version" must hold even if the user never interacts with the popup at all.
//
// t-v5r1fd: only a PUBLIC release (publicReleases.ts) shows the pop-up, and it shows
// ONE summary of everything since the last version the user saw: the curated note
// whats-new/<version>.md when it exists, else the CHANGELOG.md sections merged by group.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { compareVersions, previewRange, previousPublicRelease, whatsNewRange, type WhatsNewRange } from './changelogGate';
import { mergeChangelogSince } from './changelogSection';
import { openChangelogPanel } from './changelogPanel';
import { PUBLIC_RELEASES } from './publicReleases';

const MARKER_KEY = 'origami.changelog.lastSeenVersion';

/** The narrow slice of ExtensionContext this feature reads/writes. */
export interface ChangelogMarker {
  get(): string | undefined;
  set(version: string): void;
}

export interface WhatsNewOptions {
  marker?: ChangelogMarker;
  changelogPath?: string;
  /** Folder of curated notes (<version>.md) with diagrams/ and shots/ beside them. */
  notesDir?: string;
  publicReleases?: readonly string[];
  log?: (msg: string) => void;
}

function resolve(context: vscode.ExtensionContext, opts: WhatsNewOptions | undefined) {
  return {
    log: opts?.log ?? ((m: string) => console.warn(m)),
    marker: opts?.marker ?? {
      get: () => context.globalState.get<string>(MARKER_KEY),
      set: (v: string) => void context.globalState.update(MARKER_KEY, v),
    },
    changelogPath: opts?.changelogPath ?? path.join(context.extensionPath, 'CHANGELOG.md'),
    notesDir: opts?.notesDir ?? path.join(context.extensionPath, 'whats-new'),
    publicReleases: opts?.publicReleases ?? PUBLIC_RELEASES,
    version: String((context.extension.packageJSON as { version?: unknown }).version ?? ''),
  };
}

function readIfExists(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/**
 * One markdown summary for `range`: per public release in the range (newest first),
 * its curated note, or else its CHANGELOG sections merged by group. Undefined when
 * there is no text at all.
 */
function composeWhatsNew(
  range: WhatsNewRange,
  publicReleases: readonly string[],
  changelogPath: string,
  notesDir: string,
): string | undefined {
  const inRange = (v: string) =>
    compareVersions(v, range.to) < 0 && (range.from === undefined || compareVersions(v, range.from) > 0);
  const releases = [...publicReleases.filter(inRange), range.to].sort(compareVersions).reverse();
  const changelog = readIfExists(changelogPath);

  const parts = releases.map((release) => {
    const note = readIfExists(path.join(notesDir, `${release}.md`));
    if (note?.trim()) return note.trim();
    if (!changelog) return '';
    const prev = previousPublicRelease(release, publicReleases);
    const from = [range.from, prev].filter((v): v is string => !!v).sort(compareVersions).at(-1);
    const body = mergeChangelogSince(changelog, from, release);
    return body ? `## What's new in ${release}\n\n${body}` : '';
  });
  const text = parts.filter(Boolean).join('\n\n');
  return text || undefined;
}

/**
 * Show the What's new pop-up once, on a public release the user has not seen yet.
 * Reads CHANGELOG.md and whats-new/ from the extension's installed root (shipped
 * alongside out/, not under src/ — see packages/vscode/.vscodeignore). Missing files
 * or a read error are logged and swallowed: the popup must never block activation.
 */
export function maybeShowChangelog(context: vscode.ExtensionContext, opts?: WhatsNewOptions): void {
  let log = (m: string) => console.warn(m);
  try {
    const r = resolve(context, opts);
    log = r.log;
    if (!r.version) return;
    const range = whatsNewRange(r.marker.get(), r.version, r.publicReleases);
    if (!range) return;

    const markdown = composeWhatsNew(range, r.publicReleases, r.changelogPath, r.notesDir);
    r.marker.set(r.version); // recorded before opening: "once" must hold even if never closed
    if (markdown) openChangelogPanel(context, markdown, { notesDir: r.notesDir, preview: false });
  } catch (err) {
    log(`Origami changelog popup skipped: ${String(err)}`);
  }
}

/**
 * The owner's preview ("Origami: Preview What's New"): shows what users on the last
 * public release will see when this version goes public, on any build, with marked
 * placeholders for screenshots not yet added. Reads and writes no marker.
 */
export function previewWhatsNew(context: vscode.ExtensionContext, opts?: WhatsNewOptions): void {
  const r = resolve(context, opts);
  const markdown = composeWhatsNew(previewRange(r.version, r.publicReleases), r.publicReleases, r.changelogPath, r.notesDir);
  if (!markdown) {
    void vscode.window.showInformationMessage(`Origami: no What's new text for ${r.version}.`);
    return;
  }
  openChangelogPanel(context, markdown, { notesDir: r.notesDir, preview: true });
}
