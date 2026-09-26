// FlockMailBubbles.test.ts — the shared conversation markup FlockMail.svelte
// and the sidebar Front Desk both draw a thread with.
//
// What a wrong answer here looks like: a question and a reply rendered as one
// paragraph (the old "parked permission" reading this replaced), a direction
// marker that says "you asked" for a question that came IN, or an origin chip
// that shows up for every row because the guard reading a field a sibling
// lane has not landed yet threw instead of falling back to ''.

import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import FlockMailBubbles from '../components/FlockMailBubbles.svelte';
import type { MailRow } from '../panes/flockMail';

afterEach(() => cleanup());

function row(over: Partial<MailRow> = {}): MailRow {
  return {
    id: 'thr_1',
    contact: 'robin@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0',
    direction: 'in',
    question: { text: 'what does the tax form cover?', sentAt: '2026-09-05T07:00:00.000Z' },
    state: 'pending',
    unread: false,
    name: 'robin',
    icon: 'crane',
    handleShort: 'robin@Zm9vYmFy…',
    ...over,
  };
}

describe('a question with no reply yet', () => {
  it('draws one bubble and the INCOMING marker', () => {
    const { container } = render(FlockMailBubbles, { row: row() });
    const bubbles = container.querySelectorAll('.mk-bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toBe('what does the tax form cover?');
    expect(container.querySelector('.mk-dir')!.textContent).toBe('← they asked');
  });
});

describe('our own question, answered', () => {
  const answered = row({
    direction: 'out',
    state: 'answered',
    reply: { text: 'section 4 covers it', at: '', tokens: 12, signatureOk: true },
  });

  it('draws BOTH bubbles and the OUTGOING marker', () => {
    const { container } = render(FlockMailBubbles, { row: answered });
    const bubbles = container.querySelectorAll('.mk-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]!.textContent).toBe('what does the tax form cover?');
    expect(bubbles[1]!.textContent!.trim()).toBe('section 4 covers it');
    expect(container.querySelector('.mk-dir')!.textContent).toBe('→ you asked');
  });

  it('puts the QUESTION on the owner\'s side and the REPLY on the contact\'s', () => {
    const { container } = render(FlockMailBubbles, { row: answered });
    const bubbles = Array.from(container.querySelectorAll('.mk-bubble'));
    expect(bubbles[0]!.classList.contains('mine')).toBe(true);
    expect(bubbles[1]!.classList.contains('mine')).toBe(false);
  });

  it('has no origin chip when the row carries no `origin` field', () => {
    const { container } = render(FlockMailBubbles, { row: answered });
    expect(container.querySelector('.mk-origin')).toBeNull();
  });
});

describe('a decline', () => {
  it('shows the decline reason in the reply bubble, not the raw reply text', () => {
    const declined = row({
      direction: 'out',
      state: 'declined',
      reply: { text: 'refused', at: '', tokens: 0, signatureOk: true, declined: { reason: 'not something I share' } },
    });
    const { container } = render(FlockMailBubbles, { row: declined });
    const bubbles = container.querySelectorAll('.mk-bubble');
    expect(bubbles[1]!.textContent!.trim()).toBe('not something I share');
  });
});

describe('origin — a field this lane does not own', () => {
  it('renders "asked from <origin>" only when the row carries one', () => {
    const withOrigin = { ...row({ direction: 'out', state: 'sent' }), origin: { sessionID: 'ses_1', title: 'the Aetheron chat' } } as MailRow;
    const { container } = render(FlockMailBubbles, { row: withOrigin });
    expect(container.querySelector('.mk-origin')!.textContent).toBe('asked from the Aetheron chat');
  });

  it('stays silent on a blank origin, so a field that is present but empty draws nothing', () => {
    const blank = { ...row({ direction: 'out', state: 'sent' }), origin: { sessionID: 'ses_1', title: '   ' } } as MailRow;
    const { container } = render(FlockMailBubbles, { row: blank });
    expect(container.querySelector('.mk-origin')).toBeNull();
  });
});
