// Defect B — a LIVE session vanishes from the run index and the chat history.
//
// The fixture below is shaped like a real history row set: for directory
// `C:/Users/dev/Desktop/Workspace` there are 95 unarchived root sessions,
// 12 of them turnless
// "New session - <ISO>" placeholders, 83 real chats. The run index drew 82.
//
// 95 − 12 placeholders − 1 "the chat you have open" = 82. The missing one was
// `ses_fd0417e1effe1dM6tpyzmy7lQr` ("Origami Media Gen UI and workflow
// overhaul") — 406 messages, 30 children, `time_archived` NULL, ranked 14th
// most recent, and returned by `origami session list`. It was absent from the
// extension for one reason only: it was the open chat, and the projection
// dropped the open chat.
import { describe, expect, it } from 'vitest';
import { historyRows, isTurnless, openTabFor, type HistorySession } from '../../../src/dashboard/historyRows';
import type { CollabMark } from '../../../src/dashboard/collabSteps';

const MEDIAGEN = 'ses_fd0417e1effe1dM6tpyzmy7lQr';
const CWD = 'C:/Users/dev/Desktop/Workspace';

/** The real store's shape: 95 roots, 12 of them placeholders, MediaGen 14th. */
function cortexStore(): HistorySession[] {
  const rows: HistorySession[] = [];
  // Ranks 0..12 — the twelve most recent, some placeholders, as on disk.
  const head = [
    'New session - 2026-08-25T20:38:29.822Z',
    'Only War 1200 XP last stand build',
    'New session - 2026-08-25T19:10:27.040Z',
    'New session - 2026-08-25T18:53:20.977Z',
    'Sub agent counting 1-100',
    'New session - 2026-08-25T15:58:20.923Z',
    'Sub agent harness test 1-100',
    'New session - 2026-08-25T15:51:15.235Z',
    'New session - 2026-08-25T15:46:06.909Z',
    'Greeting',
    'New session - 2026-08-25T14:56:53.370Z',
    'Reply with OK',
    'New session - 2026-08-25T14:00:33.929Z',
  ];
  // 8 of the 12 placeholders are in this head block.
  head.forEach((title, i) => rows.push({ sessionId: `ses_head_${i}`, cwd: CWD, title, updatedAt: `2026-08-25T20:00:00.000Z` }));
  // Rank 13 — the session that went missing.
  rows.push({ sessionId: MEDIAGEN, cwd: CWD, title: 'Origami Media Gen UI and workflow overhaul', updatedAt: '2026-08-25T10:11:06.399Z' });
  // Ranks 14..90 — 77 more real chats.
  for (let i = 0; i < 77; i++) {
    rows.push({ sessionId: `ses_tail_${i}`, cwd: CWD, title: `Real chat ${i}`, updatedAt: '2026-08-24T00:00:00.000Z' });
  }
  // Ranks 91..94 — the remaining 4 placeholders, 12 in total.
  for (let i = 0; i < 4; i++) {
    rows.push({ sessionId: `ses_old_${i}`, cwd: CWD, title: `New session - 2026-08-2${i}T01:00:00.000Z`, updatedAt: '2026-08-20T00:00:00.000Z' });
  }
  return rows;
}

describe('historyRows — the live session must survive the projection', () => {
  it('keeps every real chat, including the one currently open (95 → 83, not 82)', () => {
    const store = cortexStore();
    expect(store).toHaveLength(95);
    expect(store.filter((s) => isTurnless(s.title))).toHaveLength(12);

    // MediaGen is the chat the answering client has open — the exact condition
    // under which it used to disappear.
    const rows = historyRows(store, MEDIAGEN);

    expect(rows).toHaveLength(83);
    expect(rows.map((r) => r.sessionId)).toContain(MEDIAGEN);
  });

  it('marks the open chat rather than removing it', () => {
    const rows = historyRows(cortexStore(), MEDIAGEN);
    const mine = rows.find((r) => r.sessionId === MEDIAGEN);
    expect(mine?.current).toBe(true);
    expect(mine?.title).toBe('Origami Media Gen UI and workflow overhaul');
    // Every other row is not the current one.
    expect(rows.filter((r) => r.current)).toHaveLength(1);
  });

  it('still drops turnless placeholders — including one that is the open chat', () => {
    const rows = historyRows(cortexStore(), 'ses_head_0');
    expect(rows).toHaveLength(83);
    expect(rows.map((r) => r.sessionId)).not.toContain('ses_head_0');
  });

  it('with no open chat the count is the same 83 — `current` never subtracts', () => {
    expect(historyRows(cortexStore(), null)).toHaveLength(83);
  });
});

describe('openTabFor — recalling an already-open chat', () => {
  const tab = (engineId: string | null) => ({ client: { currentSessionId: engineId } });
  const tabs = (): Array<[string, { client?: { currentSessionId: string | null } | null }]> => [
    ['session-1', tab('ses_one')],
    ['session-2', tab(MEDIAGEN)],
    ['session-3', tab(null)],
  ];

  it('finds the local tab bound to an engine session', () => {
    expect(openTabFor(tabs(), MEDIAGEN)).toBe('session-2');
  });

  it('answers undefined for a session no tab holds — that one gets a new tab', () => {
    expect(openTabFor(tabs(), 'ses_not_open')).toBeUndefined();
  });

  it('never matches a tab that has no engine session yet', () => {
    // A fresh tab's currentSessionId is null; '' must not match it.
    expect(openTabFor(tabs(), '')).toBeUndefined();
  });

  it('tolerates a tab with no client at all', () => {
    expect(openTabFor([['session-1', {}], ['session-2', { client: null }]], 'ses_x')).toBeUndefined();
  });
});

describe('historyRows — row shape', () => {
  const one: HistorySession[] = [{ sessionId: 'ses_a', cwd: 'C:/Repos/Thing', title: '  Spaced  ', updatedAt: 'T' }];

  it('carries the full cwd as well as the basename', () => {
    const [row] = historyRows(one, null);
    expect(row?.folder).toBe('Thing');
    expect(row?.cwd).toBe('C:/Repos/Thing');
  });

  it('trims the title and falls back for a whitespace-only one', () => {
    expect(historyRows(one, null)[0]?.title).toBe('Spaced');
    // A row whose title is only whitespace is turnless, so it is dropped, not
    // renamed — the fallback is for a row that reaches the map some other way.
    expect(historyRows([{ ...one[0]!, title: '   ' }], null)).toHaveLength(0);
  });

  it('applies collab marks and collapses duplicate ids', () => {
    const marks = new Map<string, CollabMark>([['ses_a', { collabId: 'c1', collabTitle: 'Pair', agentSlug: 'build' }]]);
    const rows = historyRows([one[0]!, one[0]!], null, marks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.collabId).toBe('c1');
    expect(rows[0]?.agentSlug).toBe('build');
  });

  it('survives a malformed row without throwing', () => {
    const rows = historyRows(
      [{ sessionId: '', cwd: '', title: 'x', updatedAt: '' }, { sessionId: 'ses_ok', cwd: '', title: 'ok', updatedAt: '' }],
      null,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['ses_ok']);
    expect(rows[0]?.folder).toBe('');
  });
});
