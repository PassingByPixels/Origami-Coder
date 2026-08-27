// The Folds board's bucket logic — the rules that decide which of the seven
// columns a fold row or a ticket draws in, tested WITHOUT a DOM because they are
// pure. Three of them are the ones a rendered-pane test could only reach
// indirectly: Blocked is DERIVED (needsYou / error) and never stored, a launched
// ticket is ABSORBED by its fold row so the board draws one card and not two,
// and a merged ticket that never got a fold still has to land somewhere.

import { describe, it, expect } from 'vitest';
import {
  COLUMNS, age, baseName, bucketRow, bucketTicket, buildColumns, clusters,
  rowMatches, ticketMatches, type Row, type TicketRow,
} from '../components/boardBuckets';

const mkRow = (over: Partial<Row>): Row => ({
  id: 'r1', name: 'agent', branch: 'origami/agent', path: '/wt/agent', orphan: false,
  state: 'detached', agentName: 'tsuru', model: '', stopReason: '', errorDetail: '', setupNote: '',
  startedAt: Date.now(), hasSession: false, ahead: 0, adds: 0, dels: 0, queuedPrompt: '',
  mergedAt: 0, groupId: '', ticketId: '', ticketTitle: '', activity: '', needsYou: null,
  ...over,
});
const mkTicket = (over: Partial<TicketRow>): TicketRow => ({
  id: 't-aaa111', title: 'a ticket', status: 'triage', priority: 'normal',
  labels: [], assignee: '', acceptance: { done: 0, total: 0 },
  updatedAt: Date.now(), fold: '', branch: '',
  ...over,
});

describe('COLUMNS — the lifecycle, left to right', () => {
  it('is exactly the seven contract columns in order, each with a subtitle', () => {
    expect(COLUMNS.map((c) => c.id)).toEqual(['triage', 'todo', 'pending', 'doing', 'blocked', 'done', 'merged']);
    expect(COLUMNS.map((c) => c.label)).toEqual(['Triage', 'Todo', 'Pending', 'In progress', 'Blocked', 'Done', 'Merged']);
    for (const c of COLUMNS) expect(c.subtitle.length).toBeGreaterThan(0);
  });
});

describe('bucketRow — the fold-row table', () => {
  it('maps every runtime state to its column', () => {
    expect(bucketRow(mkRow({ state: 'queued' }))).toBe('pending');
    expect(bucketRow(mkRow({ state: 'provisioning' }))).toBe('doing');
    expect(bucketRow(mkRow({ state: 'working' }))).toBe('doing');
    expect(bucketRow(mkRow({ state: 'idle' }))).toBe('done');
    expect(bucketRow(mkRow({ state: 'detached' }))).toBe('done');
    expect(bucketRow(mkRow({ state: 'detached', orphan: true }))).toBe('done');
  });

  // Blocked is the column the old board had no equivalent for: an errored run
  // used to sit in Done, indistinguishable from a clean finish.
  it('DERIVES Blocked from a pending question or a failed run', () => {
    expect(bucketRow(mkRow({ state: 'error', errorDetail: 'boom' }))).toBe('blocked');
    expect(bucketRow(mkRow({ state: 'working', needsYou: { kind: 'question', preview: 'which file?' } }))).toBe('blocked');
    // ...and a working row with nothing pending is NOT blocked.
    expect(bucketRow(mkRow({ state: 'working', needsYou: null }))).toBe('doing');
  });

  it('merged wins over every other state — a merged card is retired, not re-derived', () => {
    const at = Date.now();
    expect(bucketRow(mkRow({ state: 'idle', mergedAt: at }))).toBe('merged');
    expect(bucketRow(mkRow({ state: 'error', errorDetail: 'x', mergedAt: at }))).toBe('merged');
    expect(bucketRow(mkRow({ state: 'working', needsYou: { kind: 'question', preview: 'q' }, mergedAt: at }))).toBe('merged');
  });
});

describe('bucketTicket — the ticket table and the launch dedupe', () => {
  it('draws triage and todo tickets, and hides closed ones', () => {
    expect(bucketTicket(mkTicket({ status: 'triage' }))).toBe('triage');
    expect(bucketTicket(mkTicket({ status: 'todo' }))).toBe('todo');
    expect(bucketTicket(mkTicket({ status: 'closed' }))).toBeNull();
  });

  // The rule that stops a launched ticket drawing twice: its fold row carries
  // ticketId/ticketTitle and IS the card.
  it('a ticket with a fold NEVER draws a ticket card, whatever its status', () => {
    for (const status of ['triage', 'todo', 'pending', 'in_progress', 'done', 'merged']) {
      expect(bucketTicket(mkTicket({ status, fold: 'w-1' }))).toBeNull();
    }
  });

  it('a merged ticket with no fold row still lands in Merged (the unlaunched-file case)', () => {
    expect(bucketTicket(mkTicket({ status: 'merged', fold: '' }))).toBe('merged');
  });

  it('a lifecycle status with no fold draws nothing — the stamp without its run is stale', () => {
    expect(bucketTicket(mkTicket({ status: 'pending' }))).toBeNull();
    expect(bucketTicket(mkTicket({ status: 'in_progress' }))).toBeNull();
    expect(bucketTicket(mkTicket({ status: 'done' }))).toBeNull();
  });

  // Contract §2: a file we cannot parse is never dropped silently.
  it('a malformed file surfaces in Triage, even with an unusable status or a fold', () => {
    expect(bucketTicket(mkTicket({ status: '', malformed: true }))).toBe('triage');
    expect(bucketTicket(mkTicket({ status: 'done', fold: 'w-1', malformed: true }))).toBe('triage');
  });
});

describe('buildColumns — one repo, both card kinds', () => {
  it('places every row and ticket in exactly one column, order preserved', () => {
    const rows = [
      mkRow({ id: 'q', state: 'queued' }),
      mkRow({ id: 'w', state: 'working' }),
      mkRow({ id: 'e', state: 'error', errorDetail: 'boom' }),
      mkRow({ id: 'i', state: 'idle' }),
      mkRow({ id: 'm', state: 'idle', mergedAt: Date.now() }),
    ];
    const tickets = [
      mkTicket({ id: 't-raw', status: 'triage' }),
      mkTicket({ id: 't-spec', status: 'todo' }),
    ];
    const cols = buildColumns(rows, tickets);
    expect(cols.triage.tickets.map((t) => t.id)).toEqual(['t-raw']);
    expect(cols.todo.tickets.map((t) => t.id)).toEqual(['t-spec']);
    expect(cols.pending.rows.map((r) => r.id)).toEqual(['q']);
    expect(cols.doing.rows.map((r) => r.id)).toEqual(['w']);
    expect(cols.blocked.rows.map((r) => r.id)).toEqual(['e']);
    expect(cols.done.rows.map((r) => r.id)).toEqual(['i']);
    expect(cols.merged.rows.map((r) => r.id)).toEqual(['m']);
    // Ticket columns hold no fold rows and vice versa.
    expect(cols.triage.rows).toEqual([]);
    expect(cols.pending.tickets).toEqual([]);
  });

  it('a launched ticket and its fold row are ONE card, in the fold row\'s column', () => {
    const rows = [mkRow({ id: 'w1', state: 'working', ticketId: 't-live', ticketTitle: 'Cap the block width' })];
    const tickets = [mkTicket({ id: 't-live', status: 'in_progress', fold: 'w1' })];
    const cols = buildColumns(rows, tickets);
    expect(cols.doing.rows.map((r) => r.id)).toEqual(['w1']);
    // Nowhere on the board does the ticket draw a second card.
    const drawn = COLUMNS.flatMap((c) => cols[c.id].tickets.map((t) => t.id));
    expect(drawn).toEqual([]);
  });

  it('every column exists even when the repo is empty', () => {
    const cols = buildColumns([], []);
    for (const c of COLUMNS) expect(cols[c.id]).toEqual({ rows: [], tickets: [] });
  });
});


describe('card filters', () => {
  it('a fold row matches on its name, branch, task AND its ticket', () => {
    const r = mkRow({ name: 'fix-login', branch: 'origami/t-8k2fq1-fix-login', queuedPrompt: 'repair the redirect', ticketId: 't-8k2fq1', ticketTitle: 'Login loops forever' });
    expect(rowMatches(r, '')).toBe(true);
    expect(rowMatches(r, '   ')).toBe(true);
    expect(rowMatches(r, 'LOGIN')).toBe(true);       // case-insensitive
    expect(rowMatches(r, 't-8k2fq1')).toBe(true);    // by ticket id
    expect(rowMatches(r, 'loops forever')).toBe(true); // by ticket title
    expect(rowMatches(r, 'redirect')).toBe(true);
    expect(rowMatches(r, 'nothing-here')).toBe(false);
  });

  it('a ticket matches on id, title, labels and assignee', () => {
    const t = mkTicket({ id: 't-8k2fq1', title: 'Scroll block max-width', labels: ['ui', 'blocks'], assignee: 'heron' });
    expect(t.labels.length).toBe(2);
    expect(ticketMatches(t, 'scroll')).toBe(true);
    expect(ticketMatches(t, 'BLOCKS')).toBe(true);
    expect(ticketMatches(t, 'heron')).toBe(true);
    expect(ticketMatches(t, 't-8k2')).toBe(true);
    expect(ticketMatches(t, 'zzz')).toBe(false);
  });
});

describe('race clustering', () => {
  it('siblings in one column cluster; the cluster carries EVERY sibling, not just this column\'s', () => {
    const all = [
      mkRow({ id: 'a1', name: 'race-1', state: 'idle', groupId: 'g1' }),
      mkRow({ id: 'a2', name: 'race-2', state: 'idle', groupId: 'g1' }),
      mkRow({ id: 'a3', name: 'race-3', state: 'working', groupId: 'g1' }), // a different column
      mkRow({ id: 'solo', name: 'solo', state: 'idle' }),
    ];
    const done = all.filter((r) => r.state === 'idle');
    const out = clusters(done, all);
    expect(out.map((c) => c.kind)).toEqual(['group', 'single']);
    const group = out[0] as { kind: 'group'; base: string; rows: typeof all; siblings: typeof all };
    expect(group.base).toBe('race');
    expect(group.rows.map((r) => r.id)).toEqual(['a1', 'a2']);   // this column's members
    expect(group.siblings.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']); // the whole race
  });

  it('a lone sibling in a column is an ordinary card, not a one-member race', () => {
    const all = [
      mkRow({ id: 'win', name: 'race-1', state: 'idle', mergedAt: Date.now(), groupId: 'g1' }),
      mkRow({ id: 'lose', name: 'race-2', state: 'idle', groupId: 'g1' }),
    ];
    const merged = clusters([all[0]], all);
    expect(merged.map((c) => c.kind)).toEqual(['single']);
  });

  it('baseName strips the variant suffix and never returns empty', () => {
    expect(baseName('race-12')).toBe('race');
    expect(baseName('plain')).toBe('plain');
    expect(baseName('-3')).toBe('-3'); // would strip to '' — keeps the original
  });
});

describe('age — the compact clock', () => {
  const now = 1_000_000_000_000;
  it('prints seconds, minutes, hours and days', () => {
    expect(age(now - 5_000, now)).toBe('5s');
    expect(age(now - 90_000, now)).toBe('1m');
    expect(age(now - 3 * 3600_000 - 30 * 60_000, now)).toBe('3h30m');
    expect(age(now - 2 * 86_400_000, now)).toBe('2d');
  });

  it('prints NOTHING rather than a fake age when there is no timestamp', () => {
    expect(age(0, now)).toBe('');
    // A clock skew (a stamp in the future) reads 0s, never a negative age.
    expect(age(now + 60_000, now)).toBe('0s');
  });
});
