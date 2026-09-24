// scrollAnchor.ts — "how much arrived while you were reading?", in words.
//
// chatScroll.ts already stops following when the reader scrolls up (the stick
// gate). What it never said was how much landed since. This leaf turns the tail
// of the message list into the pill's label: `4 files · 2 tools · 1 thought ·
// 5 messages` — fixed order, zeros omitted, ` · ` separator, the shape focus
// view already uses for the rows it hid.
//
// The counts come from the MESSAGE LIST, never from the DOM. The mock had to
// read classes off painted cards and got file-vs-tool wrong until the paint
// settled; here `familyOf` (focusGaps.ts) answers from the row itself, so a
// card that has not rendered its path yet is still counted as the file
// operation it is. Reusing focusGaps' rule also keeps the two surfaces saying
// the same thing about the same rows.

import { familyOf } from '../components/focusGaps';
import type { Message } from './chatMessage';

/** The four words the pill speaks. Coarser than focus view's seven families on
 *  purpose: this is a glance at a pill, not an index of a hidden run. */
export type AnchorFamily = 'files' | 'tools' | 'thoughts' | 'messages';

const WORDS: ReadonlyArray<readonly [AnchorFamily, string, string]> = [
  ['files', 'file', 'files'],
  ['tools', 'tool', 'tools'],
  ['thoughts', 'thought', 'thoughts'],
  ['messages', 'message', 'messages'],
];

/** A row's pill family. A read/edit is work on FILES, which is what a reader
 *  scrolling back wants distinguished; every other call is a plain tool. */
export function anchorFamilyOf(msg: Message): AnchorFamily {
  if (msg.kind === 'user' || msg.kind === 'agent') return 'messages';
  const family = familyOf(msg);
  if (family === 'thoughts') return 'thoughts';
  if (family === 'reads' || family === 'edits') return 'files';
  return 'tools';
}

/**
 * Everything after the row with id `sinceId`, counted by family. `sinceId` is
 * the last row the reader had seen when the transcript stopped following; a
 * null marker (or one whose row has since been dropped by a rewind) means
 * nothing is unseen, so the pill stays away rather than claiming the whole
 * transcript is new.
 */
export function anchorCounts(
  messages: readonly Message[],
  sinceId: number | null,
): Record<AnchorFamily, number> {
  const counts: Record<AnchorFamily, number> = { files: 0, tools: 0, thoughts: 0, messages: 0 };
  if (sinceId === null) return counts;
  const at = messages.findIndex((m) => m.id === sinceId);
  if (at < 0) return counts;
  for (const msg of messages.slice(at + 1)) counts[anchorFamilyOf(msg)] += 1;
  return counts;
}

/** "4 files · 2 tools · 5 messages", or '' when nothing arrived (no pill). */
export function anchorLabel(messages: readonly Message[], sinceId: number | null): string {
  const counts = anchorCounts(messages, sinceId);
  return WORDS.filter(([f]) => counts[f] > 0)
    .map(([f, one, many]) => `${counts[f]} ${counts[f] === 1 ? one : many}`)
    .join(' · ');
}
