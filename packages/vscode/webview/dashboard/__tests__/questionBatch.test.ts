// questionBatch.test.ts — the batched-question `_meta` contract, both
// directions. These shapes come off a wire this package does not control (ACP's
// extension bag, which the spec says implementations MUST NOT make assumptions
// about), so the interesting cases are all the malformed ones.
//
// The WELL-FORMED fixtures are derived from what the engine actually builds:
// packages/engine/src/acp/question.ts `ask()` puts `{ question, header,
// options }` on `_meta.questions`, options carrying stringified indices plus a
// synthetic trailing "Other".

import { describe, expect, it } from 'vitest';
import { questionsFromMeta, replyMeta, questionAnswers } from '../../../src/questionBatch';

const engineMeta = {
  questions: [
    {
      question: 'Which parser?',
      header: 'Parser',
      options: [
        { optionId: '0', kind: 'allow_once', name: 'Rewrite it' },
        { optionId: '1', kind: 'reject_once', name: 'Patch it' },
        { optionId: '2', kind: 'reject_once', name: 'Other' },
      ],
    },
    {
      question: 'Which store?',
      header: 'Store',
      options: [
        { optionId: '0', kind: 'allow_once', name: 'SQLite' },
        { optionId: '1', kind: 'reject_once', name: 'Other' },
      ],
    },
  ],
};

describe('questionsFromMeta', () => {
  it('reads every question, in order, with its own options', () => {
    const parsed = questionsFromMeta(engineMeta);
    expect(parsed?.map((q) => q.title)).toEqual(['Which parser?', 'Which store?']);
    expect(parsed?.[1]!.options.map((o) => o.name)).toEqual(['SQLite', 'Other']);
    expect(parsed?.[0]!.options[2]).toEqual({ optionId: '2', name: 'Other', kind: 'reject_once' });
  });

  it('returns undefined when there is no batch — the BACK-COMPAT signal', () => {
    // An engine that predates batching, and every real permission ask.
    for (const meta of [undefined, null, {}, { questions: [] }, { questions: 'nope' }, 42]) {
      expect(questionsFromMeta(meta)).toBeUndefined();
    }
  });

  it('drops the WHOLE batch when any entry is malformed', () => {
    // Half a batch would leave the user on a modal step they cannot complete;
    // dropping it falls back to title+options, which always answers question 1.
    const bad = [
      { questions: [{ question: 'ok', options: [{ optionId: '0', name: 'A', kind: 'allow_once' }] }, null] },
      { questions: [{ question: 'ok', options: [] }] },
      { questions: [{ question: 42, options: [{ optionId: '0', name: 'A', kind: 'allow_once' }] }] },
      { questions: [{ question: 'ok' }] },
    ];
    for (const meta of bad) expect(questionsFromMeta(meta)).toBeUndefined();
  });

  it('coerces option fields rather than dropping a usable question', () => {
    // A numeric optionId is the engine's own shape stringified; a missing name
    // becomes '' rather than voiding the batch, because one blank label is a
    // cosmetic loss and dropping the batch would cost every other question.
    const parsed = questionsFromMeta({ questions: [{ question: 'Q', options: [{ optionId: 0, name: null }] }] });
    expect(parsed?.[0]!.options[0]).toEqual({ optionId: '0', name: '', kind: 'reject_once' });
  });
});

describe('replyMeta', () => {
  it('is undefined for a plain approval, so an ordinary reply grows no _meta', () => {
    expect(replyMeta(undefined, undefined)).toBeUndefined();
    expect(replyMeta(undefined, [])).toBeUndefined();
  });

  it('carries free text alone (the single-question M4.4 path)', () => {
    expect(replyMeta('revert it', undefined)).toEqual({ answerText: 'revert it' });
  });

  it('carries the batch, and copies the entries', () => {
    const answers = [{ optionId: '1' }, { optionId: '2', answerText: 'solarised' }];
    const meta = replyMeta(undefined, answers)!;
    expect(meta['answers']).toEqual(answers);
    expect((meta['answers'] as unknown[])[0]).not.toBe(answers[0]);
  });
});

describe('questionAnswers', () => {
  it('reads a batch reply and trims typed text', () => {
    expect(questionAnswers([{ optionId: '1' }, { optionId: '2', answerText: '  solarised  ' }])).toEqual([
      { optionId: '1' },
      { optionId: '2', answerText: 'solarised' },
    ]);
  });

  it('returns undefined for a non-batch reply', () => {
    for (const raw of [undefined, null, [], 'nope', {}]) expect(questionAnswers(raw)).toBeUndefined();
  });

  it('drops the whole reply when an entry answers nothing', () => {
    // A short batch would make the engine re-ask the remainder and the user
    // would see the modal a second time.
    expect(questionAnswers([{ optionId: '0' }, { optionId: '' }])).toBeUndefined();
    expect(questionAnswers([{ optionId: '0' }, { optionId: '', answerText: '   ' }])).toBeUndefined();
    expect(questionAnswers([{ optionId: '0' }, null])).toBeUndefined();
  });

  it('keeps an entry that has ONLY typed text', () => {
    expect(questionAnswers([{ answerText: 'just this' }])).toEqual([{ optionId: '', answerText: 'just this' }]);
  });
});
