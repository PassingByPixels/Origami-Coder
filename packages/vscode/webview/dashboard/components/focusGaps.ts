// focusGaps.ts — WHAT FOCUS VIEW HID, counted, between the rows it kept.
//
// chatFocus.ts decides WHICH rows survive focus view. This file decides what
// the user is told about the ones that did not. Hiding forty tool cards is the
// whole point of the view, but a transcript that jumps from one answer to the
// next leaving no mark says nothing about the work between them — which reads
// as lost context rather than as a clean read.
//
// So a RUN of consecutive hidden rows folds into ONE gap carrying a count per
// family: "38 tools · 16 file reads · 2 thoughts". Runs at the start, in the
// middle and at the end all fold, and a run of ONE folds too: a lone hidden row
// is still a hidden row, and a view that marks some gaps and not others is
// worse than one that marks none.
//
// A pure leaf (no DOM, no Svelte, no `vscode`) for the reason chatFocus.ts is
// one: the counting and the wording are the only things here that can be WRONG,
// so focusGaps.test.ts asserts them with nothing rendered.
//
// THE COUNTS ARE DISJOINT AND THEY SUM to the run length. Every hidden row
// lands in exactly one family, so "38 tools" means 38 calls that were NOT the
// 16 file reads beside it. A family that double-counted would report more work
// than the agent did, on a divider whose entire job is to be trusted at a
// glance.
//
// THE FAMILIES MIRROR ToolCard's DISPATCH, deliberately — an explicit tool NAME
// wins and the ACP `kind` is the fallback, exactly as TOOLCARD_REGISTRY then
// KIND_REGISTRY do in ToolCard.svelte. The names are the ones that actually
// arrive on the wire (that registry, plus the engine tool ids mirrored in
// src/dashboard/botTools.ts). The fallback is not decoration: `toolName` is
// optional on the row (pre-Pillar-2 sessions and non-Origami ACP servers omit
// it), and without the kind every one of those rows would read as a plain
// "tool" — the exact context loss this file exists to stop.

import { visibleInFocus } from './chatFocus';
import type { Message } from '../panes/chatMessage';

/** The families a hidden row can land in. `tools` is the catch-all, so an
 *  unrecognised tool is under-described and never miscounted or dropped. */
export type GapCategory = 'tools' | 'reads' | 'edits' | 'commands' | 'searches' | 'thoughts' | 'steps';

/** One folded run of hidden rows, standing in the row list where they were. */
export interface FocusGap {
  /** The discriminant `Message` does not have — what `isFocusGap` reads. */
  gap: true;
  /** Keyed `{#each}` identity: the FIRST hidden row's id. Stable across a
   *  re-render because the run's head does not move while the run grows. */
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

/** ACP `kind` → family, used only when the name is missing or unknown — the
 *  same order of preference ToolCard's dispatch already applies. `bash` is a
 *  kind as well as a name (ToolCard's kindIcons names both). */
const KIND_FAMILY: Readonly<Record<string, GapCategory>> = {
  read: 'reads',
  edit: 'edits',
  execute: 'commands',
  bash: 'commands',
  search: 'searches',
};

/** Rendered order, singular, plural. The ARRAY is the fixed order — a caller
 *  reads "38 tools · 16 file reads" the same way every time, and a family with
 *  no rows in this run is omitted rather than printed as a zero. */
const FAMILY_WORDS: ReadonlyArray<readonly [GapCategory, string, string]> = [
  ['tools', 'tool', 'tools'],
  ['reads', 'file read', 'file reads'],
  ['edits', 'edit', 'edits'],
  ['commands', 'command', 'commands'],
  ['searches', 'search', 'searches'],
  ['thoughts', 'thought', 'thoughts'],
  ['steps', 'step', 'steps'],
];

/**
 * Which family ONE hidden row belongs to.
 *
 * `steps` is the quiet tail: a verdict, a todo snapshot and a compaction marker
 * are turn BOOKKEEPING, not calls the agent made, so folding them into "tools"
 * would inflate the one number a reader takes as work done.
 */
function familyOf(msg: Message): GapCategory {
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

/**
 * The row list a focused transcript draws: every visible message BY IDENTITY
 * (never a copy — the renderer keys on `msg.id` and the pane still owns the
 * object), with each run of hidden rows replaced by one `FocusGap`.
 *
 * Nothing is filtered away silently: a hidden row is either counted into the
 * gap that replaced it or it was never hidden. `visibleInFocus` fails open, so
 * a message kind added later passes through as a row rather than being counted
 * into a gap nobody can expand.
 */
export function foldForFocus(messages: readonly Message[]): FocusRow[] {
  const rows: FocusRow[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length > 0) rows.push(gapOf(run));
    run = [];
  };
  for (const msg of messages) {
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
