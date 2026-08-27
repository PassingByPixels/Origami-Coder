import { describe, expect, it } from 'vitest';
import { buildStreamRows, type MessageKind, type StreamMessage } from './collabKinds';
import { buildCouncilRows, roundHeadline, type RoundRow } from './collabCouncil';

// The COUNCIL round, as a shape the stream can draw — pure, and testable with
// no DOM for the same reason collabKinds.ts is: what a round IS (which
// messages belong to it, whether it has closed, what its one-line headline
// says) is a decision, and only the drawing of it is markup.

interface M extends StreamMessage {
  text: string;
}

let seq = 0;
const msg = (over: Partial<M> & { authorId: string; kind?: MessageKind }): M => ({
  seq: ++seq,
  authorKind: 'agent',
  text: '',
  ...over,
});

const rows = (messages: M[]) => buildCouncilRows(buildStreamRows(messages));
const round = (r: ReturnType<typeof rows>[number]): RoundRow<M> => {
  expect(r.row).toBe('round');
  return r as RoundRow<M>;
};

describe('buildCouncilRows', () => {
  it('leaves a DISCUSS transcript exactly as the stream already built it', () => {
    // The first success criterion of the mode: a room that never opted in is
    // byte-identical on screen. Nothing here may fold an ordinary run.
    const messages = [
      msg({ authorId: 'user', authorKind: 'human', text: 'go' }),
      msg({ authorId: 'crane', text: 'on it' }),
      msg({ authorId: 'crane', kind: 'task_open', text: 'opened a task' }),
    ];
    const built = buildStreamRows(messages);
    expect(buildCouncilRows(built)).toEqual(built);
  });

  it('folds a round of opinions, its record and its synthesis into ONE row', () => {
    const out = rows([
      msg({ authorId: 'user', authorKind: 'human', text: 'should we rewrite it?' }),
      msg({ authorId: 'crane', kind: 'opinion', text: 'rewrite it' }),
      msg({ authorId: 'heron', kind: 'opinion', text: 'keep it' }),
      msg({ authorId: 'ibis', kind: 'opinion', text: 'measure first' }),
      msg({ authorId: 'collab', kind: 'round', text: 'Council round: 3 of 3 answered.' }),
      msg({ authorId: 'crane', kind: 'synthesis', text: 'we measure, then rewrite' }),
    ]);
    // The QUESTION stays an ordinary row: it is what the human typed, and
    // burying it inside the answers would hide what was asked.
    expect(out).toHaveLength(2);
    expect(out[0]!.row).toBe('group');

    const r = round(out[1]!);
    expect(r.opinions.map((o) => o.authorId)).toEqual(['crane', 'heron', 'ibis']);
    expect(r.record?.text).toContain('3 of 3 answered');
    expect(r.synthesis?.authorId).toBe('crane');
  });

  it('shows an OPEN round while its opinions are still landing', () => {
    // No record yet means the round has not closed. That is the difference
    // between "still deliberating" and "this is what they decided", and the
    // stream must be able to draw it rather than waiting for a complete round.
    const r = round(
      rows([
        msg({ authorId: 'crane', kind: 'opinion', text: 'rewrite it' }),
        msg({ authorId: 'heron', kind: 'opinion', text: 'keep it' }),
      ])[0]!,
    );
    expect(r.opinions).toHaveLength(2);
    expect(r.record).toBeUndefined();
    expect(r.synthesis).toBeUndefined();
  });

  it('draws a round NOBODY answered rather than dropping it', () => {
    // The room was stopped under the council. "0 of 3 answered" is the honest
    // record, and a stream that showed nothing at all would read as a question
    // that was never asked.
    const r = round(rows([msg({ authorId: 'collab', kind: 'round', text: 'Council round: 0 of 3 answered.' })])[0]!);
    expect(r.opinions).toHaveLength(0);
    expect(r.record?.text).toContain('0 of 3');
  });

  it('closes a round that never got a synthesis rather than swallowing what follows', () => {
    // A stopped room writes the record and dispatches no synthesis. The next
    // thing said is the next thing said, not this round's conclusion.
    const out = rows([
      msg({ authorId: 'crane', kind: 'opinion', text: 'rewrite it' }),
      msg({ authorId: 'collab', kind: 'round', text: 'Council round: 1 of 3 answered.' }),
      msg({ authorId: 'user', authorKind: 'human', text: 'never mind' }),
    ]);
    expect(out).toHaveLength(2);
    expect(round(out[0]!).synthesis).toBeUndefined();
    expect(out[1]!.row).toBe('group');
  });

  it('keeps TWO rounds apart', () => {
    const out = rows([
      msg({ authorId: 'crane', kind: 'opinion', text: 'a' }),
      msg({ authorId: 'collab', kind: 'round', text: 'Council round: 1 of 1 answered.' }),
      msg({ authorId: 'crane', kind: 'synthesis', text: 'undecided' }),
      msg({ authorId: 'crane', kind: 'council_question', text: 'and what would it cost?' }),
      msg({ authorId: 'heron', kind: 'opinion', text: 'b' }),
      msg({ authorId: 'collab', kind: 'round', text: 'Council round: 1 of 1 answered.' }),
    ]);
    // The follow-up QUESTION is its own row between them, for the same reason
    // the human's question is: it is what opened the second round.
    expect(out.map((r) => r.row)).toEqual(['round', 'group', 'round']);
    expect(round(out[0]!).opinions.map((o) => o.authorId)).toEqual(['crane']);
    expect(round(out[2]!).opinions.map((o) => o.authorId)).toEqual(['heron']);
  });

  it('keys a round on its first message, so re-renders cannot swap two rounds', () => {
    const out = rows([
      msg({ authorId: 'crane', kind: 'opinion', text: 'a' }),
      msg({ authorId: 'collab', kind: 'round', text: 'r' }),
    ]);
    expect(out[0]!.key).toBe(round(out[0]!).opinions[0]!.msgs[0]!.seq);
  });

  it('does not fold a run that is only PARTLY a round', () => {
    // Grouping is by author, so an agent's opinion and an ordinary message of
    // its own could in principle share a run. Folding that would file a
    // sentence somebody said as an independent position they never took.
    const author = 'crane';
    const out = rows([
      msg({ authorId: author, kind: 'opinion', text: 'a' }),
      msg({ authorId: author, kind: 'say', text: 'by the way' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.row).toBe('group');
  });
});

describe('roundHeadline', () => {
  it('reads the count off the RECORD the engine wrote, never off the rows on screen', () => {
    // The engine counts members, the stream counts bubbles, and a member that
    // failed or was stopped left no bubble. Counting here would quietly turn
    // "2 of 3" into "2 of 2" and hide the exact thing the record exists to say.
    expect(
      roundHeadline({
        row: 'round',
        key: 1,
        opinions: [{ authorId: 'crane', msgs: [] }, { authorId: 'heron', msgs: [] }],
        record: msg({ authorId: 'collab', kind: 'round', text: 'Council round: 2 of 3 answered. ibis failed.' }),
      }),
    ).toBe('Council round: 2 of 3 answered. ibis failed.');
  });

  it('says an open round is open, and how far it has got', () => {
    expect(roundHeadline({ row: 'round', key: 1, opinions: [{ authorId: 'crane', msgs: [] }] })).toBe(
      'Council round — 1 answered so far…',
    );
    expect(roundHeadline({ row: 'round', key: 1, opinions: [] })).toBe('Council round — waiting for the first answer…');
  });
});
