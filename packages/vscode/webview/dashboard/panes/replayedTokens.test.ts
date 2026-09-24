// replayedTokens.test.ts — t-q910fo: a chat recorded before 0.4.140 replays a
// stored `0 / 0` sub-agent token rider, and the row must print NO count.
//
// The defect is a false statement, not a cosmetic one: `0 tokens` on a row says
// the agent spent nothing, when the truth is that nobody ever measured it (the
// old engine summed messages that are written zeroed at turn start). Blank is
// the drawer's honest answer for "no figure" everywhere else.
//
// The restore case is driven through `restoreLog`, the REAL replay path, so what
// is asserted is what a reloaded chat's card ends up holding — not what a helper
// returned in isolation.
import { describe, expect, it } from 'vitest';
import { replayedResult } from './replayedTokens';
import { restoreLog } from './chatRestore';
import type { ToolCardMsg } from './chatToolMsg';
import { tokensText, tokensTotalText } from './subagentTokens';

const ZEROED = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, steps: 0, context: 0 };
const SPENT = { input: 12_400, output: 2_100, steps: 3 };

/** One logged `task` card, as a chat's stored message log holds it. */
const logged = (tokens: unknown) => [
  {
    kind: 'tool' as const,
    text: '',
    timestamp: 1_700_000_000_000,
    tool: {
      call: { toolCallId: 'tc1', toolName: 'task', title: 'audit the bundle', taskSessionId: 'ses_child' },
      result: { toolCallId: 'tc1', status: 'completed', content: 'done', taskSessionId: 'ses_child', taskTokens: tokens },
    },
  },
];

const restoredCard = (tokens: unknown) => {
  let next = 0;
  const out = restoreLog<ToolCardMsg>([], logged(tokens), () => ++next, 'agent');
  return out.find((m) => m.toolCallId === 'tc1');
};

describe('a stored 0 / 0 rider at replay (t-q910fo)', () => {
  it('is dropped, so the restored card carries no figure at all', () => {
    const card = restoredCard(ZEROED);
    expect(card?.taskTokens).toBeUndefined();
    // The two surfaces that would otherwise print the false zero.
    expect(tokensText(card?.taskTokens)).toBe('');
    expect(tokensTotalText(card?.taskTokens)).toBe('');
  });

  it('a REAL spend survives the same replay untouched', () => {
    const card = restoredCard(SPENT);
    expect(card?.taskTokens).toEqual(SPENT);
    expect(tokensTotalText(card?.taskTokens)).toBe('14.5k tokens · 3 steps');
  });

  it('output alone still counts as billed — only all-zero is refused', () => {
    expect(replayedResult({ taskTokens: { input: 0, output: 42 } }).taskTokens).toEqual({ input: 0, output: 42 });
    expect(replayedResult({ taskTokens: { input: 0, output: 0 } }).taskTokens).toBeUndefined();
  });

  it('leaves a result alone when it rides no tokens, or a rider it cannot read', () => {
    const none = { toolCallId: 'tc1' };
    expect(replayedResult(none)).toBe(none);
    // No readable counter: an unknown shape is not the stored-zero case, and
    // dropping it here would be a guess.
    const odd = { taskTokens: { steps: 2 } };
    expect(replayedResult(odd)).toBe(odd);
    const junk = { taskTokens: 'nonsense' };
    expect(replayedResult(junk)).toBe(junk);
  });
});
