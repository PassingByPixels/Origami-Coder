// A council round as a shape the stream can draw. A pure leaf, like
// collabKinds.ts beside it: which messages belong to one round, whether
// it has closed, and what its one line says are decisions; only the
// drawing of them is markup.
//
// It runs AFTER `buildStreamRows` rather than replacing it, folding the
// rows that builder already produced instead of forking the model.
//
// Four kinds arrive in a fixed order and mean one thing together:
//   opinion    every member's independent answer, collapsed per member so
//              the round shows the SPREAD of positions, not three open essays.
//   round      the room's own n-of-m record, authored by `collab`.
//   synthesis  one member reconciling what it just read.
//
// The QUESTION that opened the round is deliberately not folded in, so
// burying it inside the answers can't hide what was actually asked.
import { kindOf, type StreamMessage, type StreamRow } from './collabKinds';

/** One member's contribution, as the stream had already grouped it. */
export interface RoundVoice<M> {
  authorId: string;
  msgs: M[];
}

export interface RoundRow<M extends StreamMessage> {
  row: 'round';
  key: number;
  /** One entry per member that spoke, in the order their answers landed. */
  opinions: RoundVoice<M>[];
  /** The room's n-of-m record; ABSENT while the round is still OPEN. */
  record?: M;
  /** The reconciliation; absent on an open round, or one a human stopped. */
  synthesis?: RoundVoice<M>;
}

export type CouncilRow<M extends StreamMessage> = StreamRow<M> | RoundRow<M>;

/** This row as one member's voice, when EVERY message in it is that kind
 *  — never a run only PARTLY one. An opinion and an ordinary sentence can
 *  share a group, and filing the sentence as a stance nobody took is wrong. */
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
      // A new round's first opinion after a closed one: flush the old record first.
      if (record) close();
      opinions.push(opinion);
      continue;
    }
    if (r.row === 'system' && kindOf(r.msg) === 'round') {
      if (record) close();
      record = r.msg;
      continue;
    }
    // Only a synthesis that FOLLOWS a record belongs to this round; one
    // with no record above it is an ordinary message.
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
 * A CLOSED round shows the engine's own record VERBATIM, never a count
 * this file works out from the rows on screen — a failed or stopped
 * member leaves no bubble, so counting here would hide that exact fact.
 */
export function roundHeadline<M extends StreamMessage & { text?: string }>(round: RoundRow<M>): string {
  const recorded = round.record?.text?.trim();
  if (recorded) return recorded;
  if (round.opinions.length === 0) return 'Council round — waiting for the first answer…';
  return `Council round — ${round.opinions.length} answered so far…`;
}
