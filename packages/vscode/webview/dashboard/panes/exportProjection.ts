// exportProjection.ts — WHICH of a transcript row's fields survive into a
// markdown export.
//
// EXTRACTED from ChatPane.svelte's `exportSession`, which sat at 2418 of its
// 2420-line cap when the second-opinion result handler needed a line. The
// ratchet's rule is extract-before-raise, and this was the coherent piece to
// take: `exportSession` is two jobs in one function — decide what an export
// contains, then post it — and only the first has a rule that can be wrong.
//
// A pure leaf (no DOM, no Svelte, no `vscode`) beside chatFocus.ts, which
// answers the same SHAPE of question for a different surface: "which rows
// survive focus view" there, "which fields survive an export" here.
//
// THE TWO DECISIONS IT ENCODES, both deliberate and both easy to reverse by
// accident:
//   · IMAGES ARE DROPPED. A pasted screenshot is a base64 data URL running to
//     hundreds of kilobytes; in a markdown file it is an unreadable wall that
//     dwarfs the conversation around it.
//   · TOOL CARDS ARE KEPT. What the agent RAN is most of what a reader of an
//     exported session came for, so the tool name, its status and its result
//     travel even though they are not prose.

import type { Message } from './chatMessage';

/** One exported row. Deliberately NOT `Partial<Message>`: the host renders
 *  whatever it is handed, so the type has to say exactly which fields cross —
 *  a widened type would let a new Message field leak into every export the
 *  first time somebody spread the whole object. */
export interface ExportRow {
  kind: Message['kind'];
  label: string;
  text: string;
  toolName?: string;
  toolStatus?: string;
  toolResult?: string;
}

export function exportRows(messages: readonly Message[]): ExportRow[] {
  return messages.map((m) => ({
    kind: m.kind,
    label: m.label,
    text: m.text,
    toolName: m.toolName,
    toolStatus: m.toolStatus,
    toolResult: m.toolResult,
  }));
}
