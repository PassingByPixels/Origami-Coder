// t-qn09vr: the board card's status-coloured top edge (round-2 proposal 18 /
// CHANGES.md change 35). Pure, so the colour mapping is provable without
// jsdom's layout gap.
import { describe, it, expect } from 'vitest';
import { cardEdgeVar } from '../components/boardCardEdge';

describe('cardEdgeVar', () => {
  it('maps every board column to its own theme token, matching CHANGES.md change 35', () => {
    expect(cardEdgeVar('triage')).toBe('var(--og-text-muted)');
    expect(cardEdgeVar('todo')).toBe('var(--og-chat)');
    expect(cardEdgeVar('pending')).toBe('var(--og-accent)');
    expect(cardEdgeVar('doing')).toBe('var(--og-warning)');
    expect(cardEdgeVar('blocked')).toBe('var(--og-error)');
    expect(cardEdgeVar('done')).toBe('var(--og-success)');
  });

  // Merged cards render nested under Done (t-qn09vr scope decision) and take
  // its colour, not a separate one — there is no "Merged" block on the board.
  it('a merged card reads as done, not a fourth colour', () => {
    expect(cardEdgeVar('merged')).toBe(cardEdgeVar('done'));
  });
});
