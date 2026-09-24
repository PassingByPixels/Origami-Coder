// focusGaps.ts — what focus view hid, counted, between the rows it kept.
//
// chatFocus.ts decides which rows survive focus view; this file decides what
// the user is told about the ones that didn't. A run of consecutive hidden
// rows folds into one gap carrying a count per family: "38 tools · 16 file
// reads · 2 thoughts". Runs at the start, middle and end all fold, and a run
// of one folds too — a view that marks some gaps and not others is worse
// than one that marks none.
//
// A pure leaf, so the counting and wording are testable with nothing
// rendered (focusGaps.test.ts). The counts are disjoint and sum to the run
// length: a family that double-counted would report more work than the
// agent did.
//
// The families mirror ToolCard's dispatch deliberately: an explicit tool
// name wins and the ACP `kind` is the fallback. `toolName` is optional on
// the row (older sessions and non-Origami ACP servers omit it), and without
// the kind fallback every one of those rows would read as a plain "tool".

import { isEmptyAgentTurn, visibleInFocus } from './chatFocus';
import type { Message } from '../panes/chatMessage';

/** The families a hidden row can land in. `tools` is the catch-all, so an
 *  unrecognised tool is under-described and never miscounted or dropped. */
export type GapCategory = 'tools' | 'reads' | 'edits' | 'commands' | 'searches' | 'thoughts' | 'steps';

/** One folded run of hidden rows, standing in the row list where they were. */
export interface FocusGap {
  /** The discriminant `Message` does not have — what `isFocusGap` reads. */
  gap: true;
  /** Keyed `{#each}` identity: the first hidden row's id, stable while the run grows. */
  key: string;
  /** Every family, zeros included, so a caller can assert the sum. */
  counts: Readonly<Record<GapCategory, number>>;
  /** The rendered wording, e.g. "38 tools · 16 file reads · 2 thoughts". */
  label: string;
}

/** What a focused transcript iterates: the kept rows, with gaps between them. */
export type FocusRow = Message | FocusGap;

export function isFocusGap(row: FocusRow): row is FocusGap {
  return (row as FocusGap).gap === true;
}

/** Tool NAME → family. Every key is a name ToolCard already dispatches on or an
 *  engine tool id from botTools.ts's TOOL_IDS mirror. */
const TOOL_FAMILY: Readonly<Record<string, GapCategory>> = {
  read: 'reads',
  read_file: 'reads',
  edit: 'edits',
  multi_edit: 'edits',
  write: 'edits',
  write_file: 'edits',
  apply_patch: 'edits',
  bash: 'commands',
  run: 'commands',
  shell: 'commands',
  execute: 'commands',
  grep: 'searches',
  glob: 'searches',
  list_dir: 'searches',
};

/** ACP `kind` → family, used only when the name is missing or unknown, the
 *  same preference order ToolCard's dispatch applies. */
const KIND_FAMILY: Readonly<Record<string, GapCategory>> = {
  read: 'reads',
  edit: 'edits',
  execute: 'commands',
  bash: 'commands',
  search: 'searches',
};

/** Rendered order, singular, plural. Fixed order, so a family with no rows
 *  in this run is omitted rather than printed as a zero. */
const FAMILY_WORDS: ReadonlyArray<readonly [GapCategory, string, string]> = [
  ['tools', 'tool', 'tools'],
  ['reads', 'file read', 'file reads'],
  ['edits', 'edit', 'edits'],
  ['commands', 'command', 'commands'],
  ['searches', 'search', 'searches'],
  ['thoughts', 'thought', 'thoughts'],
  ['steps', 'step', 'steps'],
];

/** Which family one hidden row belongs to. `steps` is the quiet tail: a
 *  verdict, todo snapshot or compaction marker is turn bookkeeping, not a
 *  call the agent made, so folding it into "tools" would inflate the one
 *  number a reader takes as work done. */
export function familyOf(msg: Message): GapCategory {
  if (msg.kind === 'thought') return 'thoughts';
  if (msg.kind !== 'tool') return 'steps';
  const byName = msg.toolName ? TOOL_FAMILY[msg.toolName] : undefined;
  return byName ?? KIND_FAMILY[msg.toolKind ?? ''] ?? 'tools';
}

function emptyCounts(): Record<GapCategory, number> {
  const counts = {} as Record<GapCategory, number>;
  for (const [family] of FAMILY_WORDS) counts[family] = 0;
  return counts;
}

/** "38 tools · 16 file reads · 2 thoughts" — fixed order, zeros omitted. */
function labelOf(counts: Record<GapCategory, number>): string {
  return FAMILY_WORDS.filter(([family]) => counts[family] > 0)
    .map(([family, one, many]) => `${counts[family]} ${counts[family] === 1 ? one : many}`)
    .join(' · ');
}

function gapOf(run: readonly Message[]): FocusGap {
  const counts = emptyCounts();
  for (const msg of run) counts[familyOf(msg)] += 1;
  return { gap: true, key: `gap-${run[0].id}`, counts, label: labelOf(counts) };
}

/** The row list a focused transcript draws: every visible message by
 *  identity (never a copy), with each run of hidden rows replaced by one
 *  `FocusGap`. `visibleInFocus` fails open, so a message kind added later
 *  passes through as a row rather than into a gap nobody can expand.
 *
 *  An empty agent turn (t-di3a0w) is neither hidden nor a message: `agent`
 *  is VISIBLE by kind, so without this check it would flush whatever run
 *  came before it, splitting one tool run either side of a blank Tsuru
 *  bubble into two dividers — the owner's screenshot. It carries no prose
 *  and no images, so there is nothing to keep and nothing to count: it is
 *  skipped outright, joining its neighbouring hidden runs into one gap
 *  rather than being folded INTO the run (which would count it and inflate
 *  the total beyond the tool calls the agent actually made). */
export function foldForFocus(messages: readonly Message[]): FocusRow[] {
  const rows: FocusRow[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length > 0) rows.push(gapOf(run));
    run = [];
  };
  for (const msg of messages) {
    if (isEmptyAgentTurn(msg)) continue;
    // A read that produced a picture is a `tool` row like any other (t-h4o65t):
    // it folds into the reads gap with the text reads, never kept on its own.
    if (visibleInFocus(msg)) {
      flush();
      rows.push(msg);
    } else {
      run.push(msg);
    }
  }
  flush();
  return rows;
}
