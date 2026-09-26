// flockThread.test.ts — the messenger's arithmetic, with no DOM in sight.
//
// Every function under test has a WRONG answer that a rendered assertion can
// only catch by accident, which is why they are pure: a thread built
// newest-first reads backwards; a divider on the wrong row splits one
// conversation into two days; a last line taken from the question when a reply
// exists shows the owner their own words in the rail instead of the answer they
// were waiting for; and a default selection that opens one contact while
// another contact's question waits hides the thing the pane is for.
import { describe, expect, it } from 'vitest';
import { ALL_MAIL, contactThreads, defaultSelection, shouldPin, threadDays, timeOf } from '../panes/flockThread';
import type { MailRow } from '../panes/flockMail';
import type { FlockFriendRow } from '../panes/flockTypes';

const ROBIN = 'robin@Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0';
const DANA = 'dana@YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5MDE';
const NOW = new Date('2026-09-06T10:00:00.000Z');

function friend(handle: string, extra: Partial<FlockFriendRow> = {}): FlockFriendRow {
  return {
    handle,
    handleShort: `${handle.slice(0, 12)}…`,
    name: handle.split('@')[0]!,
    addedAt: '2026-08-30T11:00:00.000Z',
    policy: {},
    spentToday: 0,
    effective: { autoAnswer: false },
    ...extra,
  };
}

function row(over: Partial<MailRow> & { id: string; contact: string; sentAt: string }): MailRow {
  const { sentAt, ...rest } = over;
  return {
    direction: 'out',
    question: { text: `q ${over.id}`, sentAt },
    state: 'sent',
    unread: false,
    name: over.contact.split('@')[0]!,
    icon: 'crane',
    handleShort: `${over.contact.slice(0, 12)}…`,
    ...rest,
  } as MailRow;
}

describe('contactThreads', () => {
  it('gives a contact who has said nothing a row anyway', () => {
    // The rail is built from the FRIENDS list first: a contact accepted five
    // seconds ago must be clickable before they have ever said anything, which
    // is exactly the moment an owner looks at this pane.
    const threads = contactThreads([], [friend(ROBIN)]);
    expect(threads.map((t) => t.handle)).toEqual([ROBIN]);
    expect(threads[0]!.rows).toEqual([]);
    expect(threads[0]!.last).toBe('');
  });

  it('leads with the owner’s own label when there is one, else the name they use', () => {
    const threads = contactThreads([], [friend(ROBIN), friend(DANA, { displayName: 'Dana from the gym' })]);
    expect(threads.map((t) => t.name).sort()).toEqual(['Dana from the gym', 'robin']);
  });

  it('sorts each thread oldest-first however the mailbox arrived', () => {
    const rows = [
      row({ id: 'c', contact: ROBIN, sentAt: '2026-09-05T09:00:00.000Z' }),
      row({ id: 'a', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' }),
      row({ id: 'b', contact: ROBIN, sentAt: '2026-09-05T08:00:00.000Z' }),
    ];
    expect(contactThreads(rows, [friend(ROBIN)])[0]!.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('takes the last line from the REPLY when there is one, and its reason on a decline', () => {
    const answered = row({
      id: 'a',
      contact: ROBIN,
      sentAt: '2026-09-05T07:00:00.000Z',
      state: 'answered',
      reply: { text: 'section 4 covers it', at: '2026-09-05T07:05:00.000Z', tokens: 4, signatureOk: true },
    });
    expect(contactThreads([answered], [friend(ROBIN)])[0]!.last).toBe('section 4 covers it');

    // A decline reads as its REASON — the same words the bubble draws. A rail
    // saying "refused" beside a bubble giving a reason is two answers.
    const declined = row({
      id: 'd',
      contact: ROBIN,
      sentAt: '2026-09-05T07:00:00.000Z',
      state: 'declined',
      reply: { text: 'refused', at: '2026-09-05T07:05:00.000Z', tokens: 1, signatureOk: true, declined: { reason: 'not over Flock' } },
    });
    expect(contactThreads([declined], [friend(ROBIN)])[0]!.last).toBe('not over Flock');

    // MUTATION PROOF — with no reply at all it is the question, not ''.
    const asked = row({ id: 'q', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' });
    expect(contactThreads([asked], [friend(ROBIN)])[0]!.last).toBe('q q');
  });

  it('counts waiting and unread separately: they are the two dots’ two reasons', () => {
    const rows = [
      row({ id: 'w', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z', direction: 'in', state: 'pending', unread: true }),
      row({ id: 'u', contact: ROBIN, sentAt: '2026-09-05T08:00:00.000Z', state: 'answered', unread: true }),
      row({ id: 's', contact: ROBIN, sentAt: '2026-09-05T09:00:00.000Z', state: 'sent' }),
    ];
    const thread = contactThreads(rows, [friend(ROBIN)])[0]!;
    expect(thread.waiting).toBe(1);
    expect(thread.unread).toBe(2);
    // An `in` row that has been answered is neither: it is finished business.
    const done = row({ id: 'x', contact: DANA, sentAt: '2026-09-05T07:00:00.000Z', direction: 'in', state: 'answered' });
    const quiet = contactThreads([done], [friend(DANA)])[0]!;
    expect([quiet.waiting, quiet.unread]).toEqual([0, 0]);
  });

  it('orders contacts by their newest activity, and the silent ones by name', () => {
    const rows = [
      row({ id: 'old', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' }),
      row({ id: 'new', contact: DANA, sentAt: '2026-09-05T08:00:00.000Z' }),
    ];
    const zed = friend('zed@0000000000000000000000000000000000000000000');
    const abe = friend('abe@1111111111111111111111111111111111111111111');
    const order = contactThreads(rows, [friend(ROBIN), friend(DANA), zed, abe]).map((t) => t.name);
    expect(order).toEqual(['dana', 'robin', 'abe', 'zed']);
  });

  it('keeps the thread of a contact who has been REVOKED, under the name the row carries', () => {
    // Their mail is still the owner's. Dropping it would delete history to tidy
    // a list, and the row falls back to the handle honestly.
    const orphan = row({ id: 'o', contact: DANA, sentAt: '2026-09-05T07:00:00.000Z', name: '' });
    const threads = contactThreads([orphan], []);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.name).toBe(threads[0]!.handleShort);
  });
});

describe('threadDays', () => {
  it('heads each day once, in order, and calls the current UTC day TODAY', () => {
    const rows = [
      row({ id: 'a', contact: ROBIN, sentAt: '2026-09-04T23:00:00.000Z' }),
      row({ id: 'b', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' }),
      row({ id: 'c', contact: ROBIN, sentAt: '2026-09-05T09:00:00.000Z' }),
      row({ id: 'd', contact: ROBIN, sentAt: '2026-09-06T08:00:00.000Z' }),
    ];
    const days = threadDays(rows, NOW);
    expect(days.map((d) => d.label)).toEqual(['2026-09-04', '2026-09-05', 'TODAY']);
    expect(days.map((d) => d.rows.map((r) => r.id))).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('is driven by `now`, not by the machine clock', () => {
    const rows = [row({ id: 'a', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' })];
    expect(threadDays(rows, new Date('2026-09-05T23:59:59.000Z'))[0]!.label).toBe('TODAY');
    expect(threadDays(rows, new Date('2026-09-06T00:00:01.000Z'))[0]!.label).toBe('2026-09-05');
  });

  it('never merges two visits to one day across a day in between', () => {
    // A grouping keyed by DATE would collapse these into two groups and print
    // the 06 row above the 05 one. The run-based grouping keeps the order.
    const rows = [
      row({ id: 'a', contact: ROBIN, sentAt: '2026-09-04T07:00:00.000Z' }),
      row({ id: 'b', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' }),
      row({ id: 'c', contact: ROBIN, sentAt: '2026-09-04T09:00:00.000Z' }),
    ];
    expect(threadDays(rows, NOW).map((d) => [d.label, d.rows.map((r) => r.id)])).toEqual([
      ['2026-09-04', ['a']],
      ['2026-09-05', ['b']],
      ['2026-09-04', ['c']],
    ]);
  });

  it('draws no divider at all for an empty thread', () => {
    expect(threadDays([], NOW)).toEqual([]);
  });
});

describe('defaultSelection', () => {
  const quiet = contactThreads([row({ id: 'a', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z' })], [friend(ROBIN)]);

  it('opens on All mail whenever a question waits, whoever it is from', () => {
    const waiting = contactThreads(
      [row({ id: 'w', contact: DANA, sentAt: '2026-09-05T07:00:00.000Z', direction: 'in', state: 'pending' })],
      [friend(ROBIN), friend(DANA)],
    );
    expect(defaultSelection(waiting)).toBe(ALL_MAIL);
  });

  it('opens on All mail for an unread reply too — both are somebody’s turn', () => {
    const unread = contactThreads(
      [row({ id: 'u', contact: ROBIN, sentAt: '2026-09-05T07:00:00.000Z', state: 'answered', unread: true })],
      [friend(ROBIN)],
    );
    expect(defaultSelection(unread)).toBe(ALL_MAIL);
  });

  it('opens on the newest contact when nothing wants the owner', () => {
    expect(defaultSelection(quiet)).toBe(ROBIN);
  });

  it('opens on All mail when there are no contacts at all — its empty trays say what to do', () => {
    expect(defaultSelection([])).toBe(ALL_MAIL);
  });
});

describe('timeOf', () => {
  it('is a zero-padded HH:MM, and a different one for a different instant', () => {
    expect(timeOf('2026-09-05T09:41:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(timeOf('2026-09-05T09:41:00.000Z')).not.toBe(timeOf('2026-09-05T10:41:00.000Z'));
  });

  it('says nothing rather than "NaN:NaN" for a date the engine never wrote', () => {
    expect(timeOf('')).toBe('');
    expect(timeOf('not a date')).toBe('');
  });
});

describe('shouldPin', () => {
  it('exactly at the bottom: pinned', () => {
    expect(shouldPin(600, 400, 1000)).toBe(true);
  });

  it('within the ~40px slack of the bottom: still pinned', () => {
    expect(shouldPin(570, 400, 1000)).toBe(true); // 1000 - (570+400) = 30
    expect(shouldPin(560, 400, 1000)).toBe(true); // exactly 40 — the boundary is inclusive
  });

  it('scrolled up more than the slack: not pinned', () => {
    expect(shouldPin(559, 400, 1000)).toBe(false); // 41px short
    expect(shouldPin(0, 400, 1000)).toBe(false); // scrolled to the very top
  });

  it('content shorter than the viewport (nothing to scroll): pinned', () => {
    expect(shouldPin(0, 400, 200)).toBe(true);
  });
});
