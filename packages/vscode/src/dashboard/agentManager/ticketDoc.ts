// The ticket DOCUMENT format: pure text <-> Ticket and nothing else — the frontmatter
// round-trip (every line kept as raw bytes so unknown keys ride through verbatim),
// scalar/list readers, targeted single-line edits, and the two body sections this layer
// touches. Split out so a round-trip assertion needs no disk.

import * as path from 'node:path';

/** One frontmatter line; `key` is '' for a non-`key: value` line (kept so a rewrite
 *  preserves it byte for byte). */
interface FmLine { key: string; raw: string }

export interface Ticket {
  id: string;
  file: string;
  fm: FmLine[];
  body: string;
  malformed: boolean;
}

// ---- Parse / serialize (round-trip preserving) ----

const FM_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;

/** Split a ticket file into frontmatter + body. A malformed file (no `---`, no id, no
 *  title) still yields a Ticket so the board can warn, but every mutation refuses to rewrite
 *  it. */
export function parseTicket(text: string, file: string): Ticket {
  const fallbackId = path.basename(file).replace(/\.md$/i, '');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { id: fallbackId, file, fm: [], body: text, malformed: true };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { id: fallbackId, file, fm: [], body: text, malformed: true };
  const fm: FmLine[] = [];
  for (const line of lines.slice(1, close)) {
    const m = FM_LINE.exec(line);
    fm.push(m ? { key: m[1], raw: m[2] } : { key: '', raw: line });
  }
  const body = lines.slice(close + 1).join('\n');
  const id = scalar(fm, 'id') || fallbackId;
  const malformed = !scalar(fm, 'id') || !scalar(fm, 'title');
  return { id, file, fm, body, malformed };
}

/** Back to file text. Untouched keys keep exact bytes; always LF — a hand-edited CRLF file
 *  is normalized on the first stamp, the one byte a rewrite may change beyond its own
 *  fields. */
export function serializeTicket(t: Ticket): string {
  return `---\n${t.fm.map((l) => (l.key ? `${l.key}:${l.raw}` : l.raw)).join('\n')}\n---\n${t.body}`;
}

/** A frontmatter scalar, quotes stripped. Absent key = ''. */
export function scalar(fm: FmLine[], key: string): string {
  const found = fm.find((l) => l.key === key);
  if (!found) return '';
  const v = found.raw.trim();
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** A frontmatter list (`labels: [ui, ux]`). A bare scalar counts as one entry. */
export function list(fm: FmLine[], key: string): string[] {
  const v = scalar(fm, key);
  if (!v) return [];
  const inner = /^\[(.*)\]$/.exec(v);
  const parts = (inner ? inner[1] : v).split(',').map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2'));
  return parts.filter((s) => s.length > 0);
}

const TAIL_KEYS = ['fold', 'branch']; // slim template's omitted keys (§12.5); INSERTED in this order after `updated:`
export function setScalar(t: Ticket, key: string, value: string): void {
  const raw = ` ${value === '' ? "''" : value}`;
  const found = t.fm.find((l) => l.key === key);
  if (found) { found.raw = raw; return; }
  let at = TAIL_KEYS.includes(key) ? t.fm.findIndex((l) => l.key === 'updated') + 1 || t.fm.length : t.fm.length;
  while (at < t.fm.length && TAIL_KEYS.indexOf(t.fm[at].key) <= TAIL_KEYS.indexOf(key)) at++;
  t.fm.splice(at, 0, { key, raw });
}

// ---- Acceptance + log (body sections) ----

/** Count the `## Acceptance` section's checkbox lines. No section = 0/0. */
export function acceptance(body: string): { done: number; total: number } {
  const lines = body.split('\n');
  let inSection = false;
  let done = 0;
  let total = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) { inSection = /^##\s+Acceptance\s*$/i.test(line); continue; }
    if (!inSection) continue;
    const m = /^\s*[-*]\s*\[([ xX])\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

/** Append a line to the body's `## Log` section (creating it when absent).
 *  Inserted at the END of that section so the log reads oldest-first. */
export function appendLog(body: string, note: string, now: number): string {
  const entry = `- ${new Date(now).toISOString()} folds: ${note}`;
  const lines = body.split('\n');
  const head = lines.findIndex((l) => /^##\s+Log\s*$/i.test(l));
  if (head < 0) return `${body.replace(/\s*$/, '')}\n\n## Log\n\n${entry}\n`;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  let at = end;
  while (at > head + 1 && lines[at - 1].trim() === '') at--; // land under the last entry, not after the blank tail
  lines.splice(at, 0, entry);
  return lines.join('\n');
}
