// W5-L2 — a COUNCIL ROUND as a shape the stream can draw. A pure leaf, like
// collabKinds.ts beside it and for the same reason: which messages belong to
// one round, whether it has closed, and what its one line says are DECISIONS,
// and only the drawing of them is markup.
//
// It runs AFTER `buildStreamRows` rather than replacing it. Grouping a run of
// consecutive same-author messages under one header is right for an opinion
// too, and collabExport.ts renders a shipped transcript from that same builder
// — so this folds the rows it already produced instead of forking the model
// they are built with.
//
// WHAT A ROUND IS ON SCREEN. Four kinds arrive in a fixed order and mean one
// thing together:
//
//   opinion …        every member's INDEPENDENT answer, none of which read
//                    another. Collapsed per member, because the point of a
//                    round is the SPREAD of positions, and three open essays
//                    show the reader one of them.
//   round            the room's own record: n of m answered, and who is not in
//                    the n. Authored by `collab`, which is nobody's slug.
//   synthesis        one member reconciling what it just read.
//
// The QUESTION that opened the round is deliberately NOT folded in. It is what
// the human typed (or, for a follow-up, a `council_question`), and burying it
// inside the answers would hide what was actually asked.
import { kindOf, type StreamMessage, type StreamRow } from './collabKinds';

/** One member's contribution, as the stream had already grouped it. */
export interface RoundVoice<M> {
  authorId: string;
  msgs: M[];
}

export interface RoundRow<M extends StreamMessage> {
  row: 'round';
  /** The first message of the round. Seqs are monotonic, so this is stable. */
  key: number;
  /** One entry per member that spoke, in the order their answers landed. */
  opinions: RoundVoice<M>[];
  /** The room's n-of-m record. ABSENT while the round is still OPEN, which is
   *  the difference between "deliberating" and "this is what they decided". */
  record?: M;
  /** The reconciliation. Absent on an open round, and on a round the human
   *  stopped — a stopped room writes its record and dispatches no synthesis. */
  synthesis?: RoundVoice<M>;
}

export type CouncilRow<M extends StreamMessage> = StreamRow<M> | RoundRow<M>;

/** This row as one member's voice, when EVERY message in it is that council
 *  kind — never a run that is only PARTLY one. An agent's opinion and an
 *  ordinary sentence of its own can share a group, and filing that sentence as
 *  an independent position would attribute a stance nobody took. */
function voiceOf<M extends StreamMessage>(row: StreamRow<M>, kind: string): RoundVoice<M> | undefined {
  if (row.row !== 'group' || row.msgs.length === 0) return undefined;
  if (!row.msgs.every((m) => kindOf(m) === kind)) return undefined;
  return { authorId: row.authorId, msgs: row.msgs };
}

export function buildCouncilRows<M extends StreamMessage>(rows: readonly StreamRow<M>[]): CouncilRow<M>[] {
  const out: CouncilRow<M>[] = [];
  let opinions: RoundVoice<M>[] = [];
  let record: M | undefined;

  /** Emit whatever round is open, if there is one at all. */
  const close = (synthesis?: RoundVoice<M>) => {
    if (opinions.length === 0 && !record) return;
    const key = opinions[0]?.msgs[0]?.seq ?? record?.seq ?? 0;
    out.push({
      row: 'round',
      key,
      opinions,
      ...(record ? { record } : {}),
      ...(synthesis ? { synthesis } : {}),
    });
    opinions = [];
    record = undefined;
  };

  for (const r of rows) {
    const opinion = voiceOf(r, 'opinion');
    if (opinion) {
      // A new round's first opinion after a closed one: the record is already
      // set, so flush before starting to collect again.
      if (record) close();
      opinions.push(opinion);
      continue;
    }
    if (r.row === 'system' && kindOf(r.msg) === 'round') {
      if (record) close();
      record = r.msg;
      continue;
    }
    // Only a synthesis that FOLLOWS a record belongs to this round. One with no
    // record above it is an ordinary message as far as the stream is concerned,
    // which is the safe reading of a transcript this build does not recognise.
    const synthesis = record ? voiceOf(r, 'synthesis') : undefined;
    if (synthesis) {
      close(synthesis);
      continue;
    }
    close();
    out.push(r);
  }
  close();
  return out;
}

/**
 * The one line at the head of a round.
 *
 * A CLOSED round shows the engine's own record VERBATIM, and never a count this
 * file worked out from the rows on screen. The two are not the same number: a
 * member whose turn failed or that a human stopped left no bubble, so counting
 * here would turn "2 of 3 answered — ibis failed" into "2 of 2" and hide the
 * exact fact the record exists to state.
 */
export function roundHeadline<M extends StreamMessage & { text?: string }>(round: RoundRow<M>): string {
  const recorded = round.record?.text?.trim();
  if (recorded) return recorded;
  if (round.opinions.length === 0) return 'Council round — waiting for the first answer…';
  return `Council round — ${round.opinions.length} answered so far…`;
}
