// What a message's kind means on screen, as a pure leaf.
//
// The stream carries a protocol, not just prose: an `ask` is a question with
// an owner, an `answer` belongs to one, a `task_*` row is bookkeeping and a
// `system` line is the room talking about itself. Rendering all ten as
// identical bubbles would hide the protocol; rendering each with its own
// component would spread the vocabulary across five files. So it lives
// here, testable with no DOM, and the components below only draw.
//
// Absent kind is `say`: an older engine sends no `kind` at all, and both
// must read as an ordinary message, never as an error.
//
// The shapes below mirror src/acpExtTypes.ts rather than importing it, since
// a webview .ts can't reach into src/.

/** Mirrors `CollabMessageKind`. */
export type MessageKind =
  | 'say' | 'ask' | 'answer' | 'handoff'
  | 'task_open' | 'task_claim' | 'task_done' | 'task_accept' | 'task_reopen'
  | 'system'
  // W5-L2 — COUNCIL rooms only (meanings: acpExtTypes.ts; folding: collabCouncil.ts).
  | 'opinion' | 'round' | 'synthesis' | 'council_question';

/** The part of a `CollabMessage` this leaf reads. Everything else on the wire
 *  (text, trace, timestamps) is the components' business, not the protocol's. */
export interface StreamMessage {
  seq: number;
  authorId: string;
  authorKind: 'human' | 'agent';
  kind?: MessageKind;
  mentions?: string[];
}

/** The kinds that render as a compact one-line row instead of a bubble:
 *  bookkeeping, plus `round`, the room's own record authored by nobody's slug. */
const SYSTEM_KINDS = new Set<string>([
  'task_open', 'task_claim', 'task_done', 'task_accept', 'task_reopen', 'system', 'round',
]);

/** The message's kind, with the absent case resolved ONCE, here. */
export const kindOf = (m: { kind?: MessageKind }): MessageKind => m.kind ?? 'say';

export const isSystemMessage = (m: { kind?: MessageKind }): boolean => SYSTEM_KINDS.has(kindOf(m));

/** The kinds a bubble TINTS: the directed ones. Everything else is ''. */
export function kindTone(m: { kind?: MessageKind }): 'ask' | 'handoff' | 'council' | '' {
  const k = kindOf(m);
  if (k === 'ask' || k === 'handoff') return k;
  // A follow-up is directed at the whole council. An `opinion` gets no tint:
  // the round frame around it already says what it is.
  return k === 'council_question' ? 'council' : '';
}

const SYSTEM_VERBS: Record<string, string> = {
  // No `round` verb: its own text already reads "Council round: 3 of 3 answered".
  synthesis: 'reconciled the round',
  council_question: 'asked the council',
  task_open: 'opened a task',
  task_claim: 'claimed a task',
  task_done: 'finished a task',
  task_accept: 'accepted a task',
  task_reopen: 'reopened a task',
};

/** The one-line label above (or instead of) the text. `nameOf` resolves a
 *  slug to whatever the surface calls that agent. A directed kind with no
 *  mention still gets its verb rather than a dangling "asked @". Given the
 *  author's name too, a directed kind reads as `A -> B` instead of a bare
 *  verb; `task_done` points at the board, the real place it's now waiting.
 *  `authorName` is optional since collabExport.ts renders a shipped
 *  transcript from this same leaf and must keep getting the old label back. */
export function kindLabel(
  m: { kind?: MessageKind; mentions?: string[] },
  nameOf: (slug: string) => string,
  authorName?: string,
): string {
  const k = kindOf(m);
  const target = (m.mentions ?? [])[0];
  const verb = k === 'ask' ? 'asked' : k === 'handoff' ? 'handed on' : k === 'system' ? '' : SYSTEM_VERBS[k] ?? '';
  if (authorName) {
    // Only ever drawn from the data: no target, no arrow — never a half-drawn one.
    const to = k === 'task_done' ? 'board' : (k === 'ask' || k === 'handoff') && target ? nameOf(target) : '';
    if (to) return `${authorName} → ${to} · ${verb}`;
    return verb;
  }
  if (k === 'ask') return `asked${target ? ` @${nameOf(target)}` : ''}`;
  if (k === 'handoff') return target ? `handed to @${nameOf(target)}` : 'handed on';
  return verb;
}

/** One rendered row: a GROUP of consecutive same-author bubbles, or a single
 *  system line that belongs to nobody's run. Generic over the message so the
 *  caller keeps its own full wire type on the way through. */
export type StreamRow<M extends StreamMessage> =
  | { row: 'group'; key: number; authorId: string; authorKind: 'human' | 'agent'; msgs: M[] }
  | { row: 'system'; key: number; msg: M };

/** The stream's render list. A run of consecutive messages from one author
 *  collapses under one header (author and kind, so a human and agent
 *  sharing an id can't merge); a system row breaks the run rather than
 *  joining it, since bookkeeping isn't part of anyone's speaking turn.
 *  Keyed on seq, monotonic per collab, so a key is stable across re-renders. */
export function buildStreamRows<M extends StreamMessage>(messages: readonly M[]): StreamRow<M>[] {
  const out: StreamRow<M>[] = [];
  for (const m of messages) {
    if (isSystemMessage(m)) {
      out.push({ row: 'system', key: m.seq, msg: m });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.row === 'group' && last.authorId === m.authorId && last.authorKind === m.authorKind) {
      last.msgs.push(m);
    } else {
      out.push({ row: 'group', key: m.seq, authorId: m.authorId, authorKind: m.authorKind, msgs: [m] });
    }
  }
  return out;
}
