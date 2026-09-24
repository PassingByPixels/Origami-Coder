// changelogSection.ts — pure merge of CHANGELOG.md sections into one summary.
// No vscode import, no fs: a leaf the caller feeds a string and a version range, so it
// is testable without a DOM or an extension host (Part 4/6 of WORKING_ON_ORIGAMI_CODER.md —
// extract before the cap, test what no screenshot would catch).
//
// t-v5r1fd: a user who skipped several dev builds gets ONE summary, grouped by the
// `### ` feature headings, not a stack of per-version sections.

import { compareVersions } from './changelogGate';

const VERSION_HEADING_RE = /^##[ \t]+(\d+(?:\.\d+)*)[ \t]*$/;
const GROUP_HEADING_RE = /^###[ \t]+(.+?)[ \t]*$/;
const UNGROUPED = 'More changes';

/** Split markdown into `## <version>` sections, in file order (newest first). Any
 *  other `## ` heading ends the section before it and is not a version. */
function versionSections(markdown: string): Array<{ version: string | undefined; lines: string[] }> {
  const out: Array<{ version: string | undefined; lines: string[] }> = [];
  let current: { version: string | undefined; lines: string[] } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##[ \t]/.test(line)) {
      const m = VERSION_HEADING_RE.exec(line);
      current = { version: m?.[1], lines: [] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

/**
 * Merge every section whose version is after `from` (exclusive) and up to `to`
 * (inclusive) into one markdown body. Items under the same `### ` heading, in any of
 * those sections, land under ONE heading in first-seen order (newest first). Items
 * with no group heading go under "More changes" at the end. Returns '' when no
 * section falls in the range.
 */
export function mergeChangelogSince(markdown: string, from: string | undefined, to: string): string {
  const groups = new Map<string, { title: string; lines: string[] }>();
  const addTo = (title: string, line: string) => {
    const key = title.toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { title, lines: [] }));
    g.lines.push(line);
  };

  for (const s of versionSections(markdown)) {
    if (!s.version) continue;
    if (compareVersions(s.version, to) > 0) continue;
    if (from !== undefined && compareVersions(s.version, from) <= 0) continue;
    let group = UNGROUPED;
    for (const line of s.lines) {
      const g = GROUP_HEADING_RE.exec(line);
      if (g) group = g[1];
      else addTo(group, line);
    }
  }

  const ordered = [...groups.values()].filter((g) => g.lines.some((l) => l.trim() !== ''));
  const ungrouped = ordered.filter((g) => g.title === UNGROUPED);
  return [...ordered.filter((g) => g.title !== UNGROUPED), ...ungrouped]
    .map((g) => `### ${g.title}\n\n${tidy(g.lines)}`)
    .join('\n\n');
}

/** Drop a blank line that only separates two list items (items from two sections
 *  then form one tight list), keep one blank line before anything else, trim. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      out.push(lines[i]);
      continue;
    }
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    const prev = out.at(-1);
    if (next === undefined || prev === undefined || prev.trim() === '') continue;
    if (/^\s*[-*][ \t]/.test(next)) continue;
    out.push('');
  }
  return out.join('\n').trim();
}
