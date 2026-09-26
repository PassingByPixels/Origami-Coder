// t-s9k0q6 — the Nest view's rules 1-5, on the pure leaf. Each test names the
// rule it holds; the fixture is the round-7 demo data in the L4a wire shape.
import { describe, expect, it } from 'vitest';
import {
  ageText,
  continueKind,
  continueTip,
  filterText,
  hereHiddenIds,
  nestGateOn,
  nestRows,
  parseNestIndex,
  readText,
  type NestIndex,
} from './nestIndex';
import { DESKS, MAC, NOW, ROWS, RTX, SELF } from '../dashboard/__tests__/nestFixture';

const index: NestIndex = { rows: ROWS, desks: DESKS };
const none = new Set<string>();
const titles = (rows: { title: string }[]) => rows.map((r) => r.title);
const byId = (id: string) => ROWS.find((r) => r.id === id)!;

describe('rule 1 — the gate', () => {
  it('is shut with no desks (Nests off) and with this desk alone', () => {
    expect(nestGateOn({ rows: [], desks: [] })).toBe(false);
    expect(nestGateOn({ rows: [], desks: [SELF] })).toBe(false);
  });
  it('opens once another desk is registered', () => {
    expect(nestGateOn({ rows: [], desks: [SELF, RTX] })).toBe(true);
  });
});

describe('rule 3 — order', () => {
  it('running first, then open by last activity newest first', () => {
    expect(titles(nestRows(index, '', none).open)).toEqual([
      'Coder: Cron sweep for the board',
      'Element: Agent message',
      'Element: Peer message',
    ]);
  });
  it('a running chat sorts first even when an idle one is newer', () => {
    const rows = [
      { ...byId('n-agent'), lastAt: NOW },
      { ...byId('n-cron'), lastAt: NOW - 3_600_000 },
    ];
    expect(nestRows({ rows, desks: DESKS }, '', none).open[0].id).toBe('n-cron');
  });
  it('a "running" chat on an offline desk is stale and sorts by time', () => {
    const rows = [
      { ...byId('n-peer'), state: 'running' as const, lastAt: NOW - 600_000 },
      { ...byId('n-agent'), lastAt: NOW },
    ];
    expect(nestRows({ rows, desks: DESKS }, '', none).open.map((r) => r.id)).toEqual(['n-agent', 'n-peer']);
  });
  it('closed chats are History, newest first', () => {
    expect(titles(nestRows(index, '', none).closed)).toEqual([
      'Spark: DFlash acceptance sweep',
      'iOS: TestFlight notes',
      'Aetheron: snow shader pass',
      'Coder: relay heartbeat bug',
      'Relay: phone page CSP',
      'WH3: dwarf unit table',
    ]);
  });
});

describe('rule 3 — search', () => {
  it('filters both parts by title', () => {
    const r = nestRows(index, 'sweep', none);
    expect(titles(r.open)).toEqual(['Coder: Cron sweep for the board']);
    expect(titles(r.closed)).toEqual(['Spark: DFlash acceptance sweep']);
    expect(r.total).toBe(9);
  });
  it('matches the desk name too, case-insensitively', () => {
    const r = nestRows(index, 'macbook', none);
    expect([...r.open, ...r.closed].map((x) => x.id).sort()).toEqual(['n-csp', 'n-peer', 'n-tf']);
  });
  it('says how many match, or that none do', () => {
    expect(filterText(2, 9, ' sweep ')).toBe('2 of 9 match "sweep"');
    expect(filterText(0, 9, 'godot')).toBe('No chat in the nest matches "godot"');
    expect(filterText(9, 9, '  ')).toBe('');
  });
});

describe('rule 2 — a chat is in one list, never both', () => {
  it('a moved id leaves the Nest list and the total', () => {
    const r = nestRows(index, '', new Set(['n-agent']));
    expect(r.open.map((x) => x.id)).not.toContain('n-agent');
    expect(r.total).toBe(8);
  });
  it('Here hides every nest chat except the ones that moved here', () => {
    const hidden = hereHiddenIds(index, new Set(['n-agent']));
    expect(hidden.has('n-cron')).toBe(true);
    expect(hidden.has('n-agent')).toBe(false);
  });
});

describe('rule 5 — Continue here', () => {
  it('an idle chat, an offline desk\'s chat and a closed chat move; a running one forks', () => {
    expect(continueKind(byId('n-agent'), RTX)).toBe('moved');
    expect(continueKind({ ...byId('n-peer'), state: 'running' }, MAC)).toBe('moved');
    expect(continueKind(byId('n-snow'), RTX)).toBe('moved');
    expect(continueKind(byId('n-cron'), RTX)).toBe('forked');
  });
  it('a desk the list does not name counts as offline, so it moves', () => {
    expect(continueKind(byId('n-cron'), undefined)).toBe('moved');
  });
  it('the tooltip names the case', () => {
    expect(continueTip(byId('n-cron'), RTX, '5090')).toBe('5090 is mid-turn: this makes a fork here');
    expect(continueTip(byId('n-agent'), RTX, '5090')).toBe('5090 is idle: this moves the chat here');
    expect(continueTip(byId('n-peer'), MAC, 'MacBook')).toContain('comes back as a fork');
    expect(continueTip(byId('n-snow'), RTX, '5090')).toBe('Closed on 5090: this opens the chat again here');
  });
  it('the read-only sentence for an offline desk names the mother base', () => {
    expect(readText(byId('n-peer'), MAC, 'MacBook', RTX, NOW)).toContain('mother base (5090)');
  });
});

describe('rule 4 — ages', () => {
  it.each([
    [0, 'now'], [59_000, 'now'], [8 * 60_000, '8 min'], [3 * 3_600_000, '3 h'],
    [26 * 3_600_000, '1 d'], [7 * 86_400_000, '1 w'],
  ])('%i ms ago reads %s', (ago, text) => {
    expect(ageText(NOW - ago, NOW)).toBe(text);
  });
  it('a clock behind the host does not print a negative age', () => {
    expect(ageText(NOW + 60_000, NOW)).toBe('now');
  });
});

describe('the host push is parsed, not trusted', () => {
  it('drops rows with no id, no desk or an unknown state, and keeps the rest', () => {
    const got = parseNestIndex({
      rows: [
        { id: 'ok', desk: 'd', state: 'open', title: 'T', lastAt: 5 },
        { desk: 'd', state: 'open' },
        { id: 'x', state: 'open' },
        { id: 'y', desk: 'd', state: 'paused' },
        null,
      ],
      desks: [{ id: 'd', name: 'D', online: 'yes' }, { name: 'no id' }],
    });
    expect(got.rows.map((r) => r.id)).toEqual(['ok']);
    expect(got.desks).toEqual([{ id: 'd', name: 'D', os: '', online: false, lastSeen: 0, motherBase: false }]);
  });
  it('a push with no arrays at all is an empty index, not a throw', () => {
    expect(parseNestIndex({})).toEqual({ rows: [], desks: [], away: [] });
  });
  it('t-t7lfho: an away record needs an id and a desk; a bad one is dropped, not guessed at', () => {
    expect(parseNestIndex({ away: [{ id: 's1', desk: 'd', at: 5 }, { id: 's2' }, { desk: 'd' }, null, 'x', { id: 's3', desk: 'd', at: 'noon' }] }).away)
      .toEqual([{ id: 's1', desk: 'd', at: 5 }, { id: 's3', desk: 'd', at: 0 }]);
  });
});
