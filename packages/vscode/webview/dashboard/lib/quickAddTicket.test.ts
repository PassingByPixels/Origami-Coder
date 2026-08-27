// The quick-capture wire shape, stated as requirements rather than as a reading
// of the builder. Until this file existed the rules below were reachable only
// through AgentManagerPane's rendered board, so the two that matter most — a
// blank title is not a ticket, and a field left at its default is left OUT of
// the message — were only ever exercised on the title/body pair. The priority,
// labels and acceptance fields arrived with no direct cover at all.

import { describe, expect, it } from 'vitest';
import { buildQuickAddTicket, quickAddRows, type QuickAddDraft } from './quickAddTicket';

/** An empty form: every box as QuickAdd mounts it. */
const blank: QuickAddDraft = {
  root: '/repo/a', title: '', body: '', priority: 'normal', labels: '', acceptance: '',
};
const draft = (over: Partial<QuickAddDraft>): QuickAddDraft => ({ ...blank, ...over });

describe('buildQuickAddTicket — what reaches the extension', () => {
  it('refuses a draft with no title, however much else was typed', () => {
    // The title names the ticket file. Posting without one would create a
    // ticket nobody can find, so the capture must stay open instead.
    expect(buildQuickAddTicket(blank)).toBeNull();
    expect(buildQuickAddTicket(draft({ title: '   ' }))).toBeNull();
    expect(buildQuickAddTicket(draft({ title: '  ', body: 'measure it\nclamp it' }))).toBeNull();
    expect(buildQuickAddTicket(draft({ title: '', acceptance: 'it works' }))).toBeNull();
  });

  it('posts a title-only capture as exactly four keys, with title and body trimmed', () => {
    // The shape the board has always posted. An extra key here (priority:
    // 'normal', labels: []) is a silent change to the message contract.
    expect(buildQuickAddTicket(draft({ title: '  Scroll block needs a max-width  ' }))).toEqual({
      type: 'amTicketQuickAdd', root: '/repo/a', title: 'Scroll block needs a max-width', body: '',
    });
    expect(buildQuickAddTicket(draft({ title: 'Cap the block', body: 'measure it\nclamp it\n' }))).toEqual({
      type: 'amTicketQuickAdd', root: '/repo/a', title: 'Cap the block', body: 'measure it\nclamp it',
    });
  });

  it('omits priority while it is normal, and sends it once it is not', () => {
    expect(buildQuickAddTicket(draft({ title: 't' }))).not.toHaveProperty('priority');
    expect(buildQuickAddTicket(draft({ title: 't', priority: 'high' }))).toMatchObject({ priority: 'high' });
    expect(buildQuickAddTicket(draft({ title: 't', priority: 'low' }))).toMatchObject({ priority: 'low' });
  });

  it('splits labels on commas and acceptance on newlines, dropping the empties', () => {
    // Both boxes are free text, so trailing separators and stray blank lines are
    // normal typing — they must not become empty labels or a blank criterion.
    const msg = buildQuickAddTicket(draft({
      title: 't', labels: ' ui , board ,, perf, ', acceptance: 'it renders\n\n  it scrolls  \n',
    }));
    expect(msg).toMatchObject({
      labels: ['ui', 'board', 'perf'],
      acceptance: ['it renders', 'it scrolls'],
    });
  });

  it('omits labels and acceptance when the boxes hold only separators', () => {
    // ',,,' is not three labels, and a box of newlines is not a checklist:
    // either would land the ticket in Todo with an empty acceptance section.
    const msg = buildQuickAddTicket(draft({ title: 't', labels: ' , , ', acceptance: '\n \n' }));
    expect(msg).not.toHaveProperty('labels');
    expect(msg).not.toHaveProperty('acceptance');
  });
});

describe('quickAddRows — the tasks box height', () => {
  it('starts at two rows and never shows fewer', () => {
    // One visible row hides the line above whatever you are typing.
    expect(quickAddRows('')).toBe(2);
    expect(quickAddRows('a')).toBe(2);
    expect(quickAddRows('a\nb')).toBe(2);
  });

  it('grows with the list up to four, then stops and lets the box scroll', () => {
    expect(quickAddRows('a\nb\nc')).toBe(3);
    expect(quickAddRows('a\nb\nc\nd')).toBe(4);
    expect(quickAddRows('a\nb\nc\nd\ne\nf')).toBe(4); // a taller box eats the column
  });
});
