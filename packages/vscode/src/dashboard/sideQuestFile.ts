// sideQuestFile.ts — the SHARED FILE CONTRACT for one side quest (t-f89g49),
// as pure text in and pure data out.
//
// The engine's `side_quest` tool WRITES `<workspace>/.origami/sidequests/SQ-<n>.md`
// and this shell READS it. Two packages, two processes, one format, and no wire
// between them: the folder IS the protocol. So the parse lives in its own module
// with no `fs`, no `vscode` and no panel — a fixture string is the whole test
// setup, and a format drift shows up as a failing assertion on a literal rather
// than as an empty drawer nobody can explain.
//
// WHY A HAND-WRITTEN PARSER AND NOT A YAML LIBRARY. The contract is five scalar
// keys and three `## ` sections, agreed verbatim with the engine lane. A YAML
// parser would accept a great deal more than that — anchors, block scalars,
// nested maps — and every extra shape it accepts is a shape the engine never
// writes and this drawer would then have to render. Five keys, read as five
// keys.
//
// UNPARSEABLE IS NOT FATAL. A file that does not match returns null and is left
// on disk untouched: the folder is the owner's, an agent or a human may have
// dropped anything in it, and a drawer that refuses to list ANY quest because
// one file is malformed is worse than a drawer that lists the other four.

/** The three states a quest file may carry. `open` is the only one the drawer lists. */
export type SideQuestStatus = 'open' | 'started' | 'dismissed';

const STATUSES: readonly string[] = ['open', 'started', 'dismissed'];

/** One parsed quest file. `rationale` is the one optional section. */
export interface SideQuest {
  /** `SQ-<n>`, verbatim from the frontmatter. */
  id: string;
  title: string;
  status: SideQuestStatus;
  /** ISO 8601, as written. Not parsed to a Date here: the drawer shows it, it
   *  does not do arithmetic on it, and an unparseable stamp must not lose the row. */
  created: string;
  /** The engine session that raised it. */
  session: string;
  summary: string;
  /** '' when the section is absent — the drawer renders nothing for it. */
  rationale: string;
  instructions: string;
}

/** The sort key behind `SQ-<n>`, or -1 when the id is not that shape. Numeric,
 *  not lexical: `SQ-10` sorts after `SQ-9`, which a string compare gets wrong. */
export function sideQuestNumber(id: string): number {
  const m = /^SQ-(\d+)$/.exec(id.trim());
  return m ? Number(m[1]) : -1;
}

/** The frontmatter block's raw text and the body after it, or null when the file
 *  does not open with a `---` fence. CR is stripped first, so a file saved with
 *  Windows line endings parses identically to the LF the contract names. */
function split(text: string): { front: string; body: string } | null {
  const lf = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  if (!lf.startsWith('---\n')) return null;
  const end = lf.indexOf('\n---', 3);
  if (end === -1) return null;
  const after = lf.indexOf('\n', end + 1);
  return { front: lf.slice(4, end + 1), body: after === -1 ? '' : lf.slice(after + 1) };
}

/** `key: value` lines, top level only. A duplicated key keeps the FIRST, which
 *  is what a reader scanning the file top-down would take it to mean. */
function frontmatter(front: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of front.split('\n')) {
    const m = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

/** The body's `## ` sections, keyed by lower-cased heading. A heading with no
 *  text under it maps to '', which is not the same as an absent section. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading = '';
  let buffer: string[] = [];
  const flush = () => { if (heading) out.set(heading, buffer.join('\n').trim()); };
  for (const line of body.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { flush(); heading = m[1]!.toLowerCase(); buffer = []; continue; }
    buffer.push(line);
  }
  flush();
  return out;
}

/** One quest file's text as data, or null when it is not a quest file at all.
 *  REQUIRED: a `SQ-<n>` id, a title, a known status, and an Instructions section
 *  — a row with no instructions is a row whose one action cannot be performed. */
export function parseSideQuest(text: string): SideQuest | null {
  const parts = split(text);
  if (!parts) return null;
  const front = frontmatter(parts.front);
  const id = front.get('id') ?? '';
  const title = front.get('title') ?? '';
  const status = front.get('status') ?? '';
  if (sideQuestNumber(id) < 0 || !title || !STATUSES.includes(status)) return null;
  const body = sections(parts.body);
  const instructions = body.get('instructions') ?? '';
  if (!instructions) return null;
  return {
    id,
    title,
    status: status as SideQuestStatus,
    created: front.get('created') ?? '',
    session: front.get('session') ?? '',
    summary: body.get('summary') ?? '',
    rationale: body.get('rationale') ?? '',
    instructions,
  };
}

/** The same text with its `status:` line rewritten, and NOTHING else touched.
 *  Start and Dismiss both go through here rather than re-serialising the parsed
 *  struct: a round trip would silently drop any key or section this shell does
 *  not know about, and the engine lane owns that file's shape, not this one.
 *
 *  Every other line's BYTES are untouched, including its own line ending — a
 *  file an owner opened and re-saved can carry CRLF on some lines and LF on
 *  others, and a one-word status change must not renormalise the rest of it.
 *  A regex on the frontmatter block does that; a split/join on `\r?\n` cannot,
 *  since a single joining `eol` erases whichever mix the file already had. */
export function stampStatus(text: string, status: SideQuestStatus): string {
  if (!split(text)) return text;
  // The frontmatter only: a `status:` line inside the body is prose, not the key.
  const fence = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fence) return text;
  const stamped = fence[0].replace(/^status:.*$/m, `status: ${status}`);
  return stamped + text.slice(fence[0].length);
}
