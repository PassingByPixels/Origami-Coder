// flockMail.test.ts — the mail manager's arithmetic, and the sidebar badge.
//
// Every function under test has a wrong answer that a rendered test can only
// catch by accident: a reply filed under Sent is a reply the owner never sees,
// a badge that counts an archived row is a badge that never goes out, and a
// prompt that dropped the original question makes a chat that is answering a
// stranger's sentence with no idea what it replies to. So they are asserted
// here against every input that reaches them, not through a component.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { badgeCount, bucket, labelOf, stateLabel, trayOf, type MailRow } from '../panes/flockMail';
import { deliverMessage, deliverTargets, type MailSession } from '../panes/flockDeliverTargets';
import FrontDeskSection from '../../chat/FrontDeskSection.svelte';

const CHRIS = 'chris@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';

function row(over: Partial<MailRow> = {}): MailRow {
  return {
    id: 'thr_1',
    contact: CHRIS,
    direction: 'out',
    question: { text: 'what does the MOT check?', sentAt: '2026-09-05T07:00:00.000Z' },
    state: 'sent',
    unread: false,
    name: 'chris',
    icon: 'crane',
    handleShort: 'chris@Zm9vYmFy…',
    ...over,
  };
}

describe('which tray a row belongs in', () => {
  it('an inbound question is in the Inbox until it is decided, then archived', () => {
    expect(trayOf(row({ direction: 'in', state: 'pending' }))).toBe('inbox');
    expect(trayOf(row({ direction: 'in', state: 'answering' }))).toBe('inbox');
    expect(trayOf(row({ direction: 'in', state: 'answered' }))).toBe('archive');
    expect(trayOf(row({ direction: 'in', state: 'declined' }))).toBe('archive');
  });

  it('our own question is in Sent while it is out, and in the Inbox once it is answered', () => {
    expect(trayOf(row({ state: 'sent' }))).toBe('sent');
    // UNREAD is what moves it, not the state: "answered" says what the contact
    // did and nothing about whether anyone here has looked at it.
    expect(trayOf(row({ state: 'answered', unread: true }))).toBe('inbox');
    expect(trayOf(row({ state: 'answered', unread: false }))).toBe('archive');
    expect(trayOf(row({ state: 'declined', unread: false }))).toBe('archive');
    expect(trayOf(row({ state: 'expired' }))).toBe('archive');
    expect(trayOf(row({ state: 'delivered' }))).toBe('archive');
  });

  it('a row is in EXACTLY one tray — an owner who has to check two places checks neither', () => {
    const rows = [
      row({ id: 'a', direction: 'in', state: 'pending' }),
      row({ id: 'b', state: 'sent' }),
      row({ id: 'c', state: 'answered', unread: true }),
      row({ id: 'd', state: 'answered' }),
    ];
    const trays = bucket(rows);
    expect(trays.inbox.map((r) => r.id)).toEqual(['a', 'c']);
    expect(trays.sent.map((r) => r.id)).toEqual(['b']);
    expect(trays.archive.map((r) => r.id)).toEqual(['d']);
    expect(trays.inbox.length + trays.sent.length + trays.archive.length).toBe(rows.length);
  });
});

describe('the badge', () => {
  it('counts the questions waiting and the replies nobody has read, and nothing else', () => {
    expect(
      badgeCount([
        row({ id: 'a', direction: 'in', state: 'pending' }),
        row({ id: 'b', state: 'answered', unread: true }),
        row({ id: 'c', state: 'sent' }),
        row({ id: 'd', state: 'answered' }),
        row({ id: 'e', direction: 'in', state: 'answered' }),
      ]),
    ).toBe(2);
  });

  it('counts a row that is both ONCE — it is "how many things want you", not a sum', () => {
    expect(badgeCount([row({ direction: 'in', state: 'pending', unread: true })])).toBe(1);
  });

  it('is zero on an empty mailbox, so no badge is drawn at all', () => {
    expect(badgeCount([])).toBe(0);
  });
});

describe('what a row says it is', () => {
  it('reads as prose a person can act on, not as a state id', () => {
    expect(stateLabel(row({ direction: 'in', state: 'pending' }))).toBe('waiting on you');
    expect(stateLabel(row({ direction: 'in', state: 'answering' }))).toBe('drafting…');
    expect(
      stateLabel(row({ direction: 'in', state: 'answering', reply: { text: 'x', at: '', tokens: 0, signatureOk: true } })),
    ).toBe('drafted — review it');
    expect(stateLabel(row({ state: 'sent' }))).toBe('sent — no answer yet');
    expect(stateLabel(row({ state: 'expired' }))).toBe('expired — never answered');
  });

  it('says WHO did it, because the same state means opposite things per direction', () => {
    expect(stateLabel(row({ direction: 'in', state: 'answered' }))).toBe('you answered');
    expect(stateLabel(row({ direction: 'out', state: 'answered' }))).toBe('they answered');
    expect(stateLabel(row({ direction: 'in', state: 'declined' }))).toBe('you declined');
    expect(stateLabel(row({ direction: 'out', state: 'declined' }))).toBe('they declined');
  });

  it('falls back to the short handle when a contact has been revoked since', () => {
    expect(labelOf(row({ name: '' }))).toBe('chris@Zm9vYmFy…');
    expect(labelOf(row({ name: '   ' }))).toBe('chris@Zm9vYmFy…');
  });
});

// THE PICKER'S ORDER IS THE FEATURE. A reply used to offer nothing but "open in
// a NEW chat", so the conversation that had asked never got its answer and a
// fresh one got an answer to a question it had never asked.
describe('where a reply can be sent', () => {
  const answered = row({
    state: 'answered',
    unread: true,
    reply: { text: 'section 4 covers it', at: '', tokens: 12, signatureOk: true },
    origin: { sessionID: 'ses_engine_7', title: 'chat 3' },
  });
  const chats: MailSession[] = [
    { id: 'session-1', label: 'chat 1' },
    { id: 'session-3', label: 'chat 3', engineId: 'ses_engine_7' },
    { id: 'session-9', label: 'chat 9', engineId: 'ses_engine_9' },
  ];

  it('puts the chat that ASKED first, then a new chat, then the rest', () => {
    expect(deliverTargets(answered, chats)).toEqual([
      { value: 'session-3', label: 'chat 3 \u00b7 asked from here' },
      { value: 'new', label: 'New chat' },
      { value: 'session-1', label: 'chat 1' },
      { value: 'session-9', label: 'chat 9' },
    ]);
  });

  // The right chat closed is still a better destination than a blank one.
  it('offers to RECALL the chat that asked when it is no longer open', () => {
    const [first, ...rest] = deliverTargets(answered, [chats[0]!, chats[2]!]);
    expect(first).toEqual({ value: 'recall', label: 'chat 3 \u00b7 recall it', recall: 'ses_engine_7' });
    expect(rest.map((t) => t.value)).toEqual(['new', 'session-1', 'session-9']);
  });

  // The webview names its chats session-1, session-2...; the engine names its
  // own. Matching an origin on the LOCAL id would silently offer New chat first.
  it('matches the origin on the ENGINE id, never the webview one', () => {
    const decoys: MailSession[] = [{ id: 'ses_engine_7', label: 'a chat whose LOCAL id looks like an engine id' }];
    const targets = deliverTargets(answered, decoys);
    // The decoy is NOT the chat that asked, so it is an ordinary entry at the
    // back and the origin is still offered for recall at the front.
    expect(targets[0]!.value).toBe('recall');
    expect(targets.at(-1)).toEqual({ value: 'ses_engine_7', label: 'a chat whose LOCAL id looks like an engine id' });
  });

  it('a row nobody asked from starts at New chat', () => {
    expect(deliverTargets(row({ state: 'answered' }), chats)[0]).toEqual({ value: 'new', label: 'New chat' });
  });

  // NO `send`. The engine writes the envelope; a pick posts a row id and a
  // destination, and nothing a model could read as the user speaking.
  it('posts flock_deliver-shaped messages, never a user turn', () => {
    expect(deliverMessage(answered, { value: 'session-3', label: 'x' })).toEqual({
      type: 'flockDeliver',
      thread: answered.id,
      sessionID: 'session-3',
    });
    expect(deliverMessage(answered, { value: 'new', label: 'New chat' })).toEqual({
      type: 'flockOpenChat',
      thread: answered.id,
    });
    expect(deliverMessage(answered, { value: 'recall', label: 'x', recall: 'ses_engine_7' })).toEqual({
      type: 'flockOpenChat',
      thread: answered.id,
      recall: 'ses_engine_7',
    });
    for (const target of [{ value: 'new', label: 'n' }, { value: 'session-3', label: 'c' }]) {
      expect(JSON.stringify(deliverMessage(answered, target))).not.toContain('"send"');
    }
  });
});

// ------------------------------------------------------------- sidebar --

describe('the sidebar Front Desk section', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
  });
  afterEach(() => cleanup());

  const send = async (msg: Record<string, unknown>) => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
    await vi.waitFor(() => {});
  };

  const sent = () =>
    globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

  it('reads the MAILBOX on mount, not a queue of its own', async () => {
    render(FrontDeskSection);
    expect(sent().map((m) => m['type'])).toContain('flockMailboxRequest');
  });

  it('REPORTS the count of questions waiting plus replies unread, and zero when there are none', async () => {
    // The badge itself is the DOCK's now (change 1). What this section owes the
    // dock is the number, so the number is what is asserted here.
    const counts: number[] = [];
    render(FrontDeskSection, { props: { oncount: (n: number) => counts.push(n) } });
    await send({
      type: 'flockMailbox',
      threads: [
        row({ id: 'a', direction: 'in', state: 'pending' }),
        row({ id: 'b', state: 'answered', unread: true, reply: { text: 'hi', at: '', tokens: 1, signatureOk: true } }),
        row({ id: 'c', state: 'sent' }),
      ],
    });
    expect(counts.at(-1)).toBe(2);

    await send({ type: 'flockMailbox', threads: [row({ id: 'c', state: 'sent' })] });
    // Zero is reported as zero; the dock is what decides a 0 draws no badge.
    expect(counts.at(-1)).toBe(0);
  });

  it('decides a question inline, and offers the third choice: think about it in a chat', async () => {
    // Opened through the prop the dock drives; the header button is gone.
    const { container } = render(FrontDeskSection, { props: { collapsed: false } });
    await send({ type: 'flockMailbox', threads: [row({ id: 'a', direction: 'in', state: 'pending' })] });

    const buttons = Array.from(container.querySelectorAll('.fd-btn'));
    await fireEvent.click(buttons[0]!);
    expect(sent().at(-1)).toEqual({ type: 'flockDecide', thread: 'a', action: 'answer' });
    await fireEvent.click(buttons[1]!);
    expect(sent().at(-1)).toEqual({ type: 'flockDecide', thread: 'a', action: 'decline' });

    // "Open in chat" on a QUESTION: it posts flock_deliver's door, not a `send`
    // - the engine writes an envelope telling the chat to ask the user first.
    await fireEvent.click(buttons[2]!);
    expect(sent().at(-1)).toEqual({ type: 'flockOpenChat', thread: 'a' });
  });

  it('sends a reply to the chat that ASKED, first in the picker', async () => {
    const { container } = render(FrontDeskSection, { props: { collapsed: false } });
    const reply = row({
      id: 'b',
      state: 'answered',
      unread: true,
      reply: { text: 'section 4 covers it', at: '', tokens: 1, signatureOk: true },
      origin: { sessionID: 'ses_engine_7', title: 'chat 3' },
    });
    await send({ type: 'flockMailbox', threads: [reply] });
    await send({ type: 'flockSessions', sessions: [{ id: 'session-3', label: 'chat 3', engineId: 'ses_engine_7' }] });

    const picker = container.querySelector('.fd-pick') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual([
      'Send to chat\u2026',
      'chat 3 \u00b7 asked from here',
      'New chat',
    ]);
    await fireEvent.change(picker, { target: { value: 'session-3' } });
    expect(sent().at(-1)).toEqual({ type: 'flockDeliver', thread: 'b', sessionID: 'session-3' });
  });
});
