// t-s9k0q6 — the host half of the sidebar's Nest view (src/dashboard/nestSidebar.ts).
// What must hold: Nests off = no desks go out, so the control cannot show;
// this desk's own rows never reach the Nest; Continue answers in the
// nestContinueResult shape, forking only a running chat, and refuses while off.
import { afterEach, describe, expect, it, vi } from 'vitest';

let setting: unknown = undefined;
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({ get: (key: string) => (section === 'origamicoder.nests' && key === 'enabled' ? setting : undefined) }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
}));

import {
  handleNestSidebarMessage,
  nestsEnabled,
  otherDeskRows,
  registerNestSource,
  type NestSource,
} from '../../../src/dashboard/nestSidebar';
import { DESKS, ROWS, SELF } from './nestFixture';

afterEach(() => { registerNestSource(null); setting = undefined; });

function host() {
  const sent: Array<Record<string, unknown>> = [];
  return { sent, post: (m: Record<string, unknown>) => { sent.push(m); } };
}
const own = { ...ROWS[0], id: 'mine', desk: SELF.id };
const fixture: NestSource = {
  index: async () => ({ selfId: SELF.id, rows: [...ROWS, own], desks: DESKS }),
  continueHere: async (id, row) => (row?.['state'] === 'running' ? { result: 'forked', newId: id + '-f' } : { result: 'taken', newId: id }),
};

describe('the setting', () => {
  it('is off by default and for anything but an exact true', () => {
    for (const v of [undefined, 'true', 1, false]) { setting = v; expect(nestsEnabled()).toBe(false); }
    setting = true;
    expect(nestsEnabled()).toBe(true);
  });
});

describe('requestNestIndex', () => {
  it('with Nests off posts no rows and no desks, whatever the source holds', async () => {
    registerNestSource(fixture);
    const h = host();
    await handleNestSidebarMessage(h, { type: 'requestNestIndex' }, () => false);
    expect(h.sent).toEqual([{ type: 'origami/nestIndex', rows: [], desks: [], tail: null, away: [] }]); // t-selspn: no tail off the mother base
  });
  it('with Nests on and no L4a index yet (the stub) posts an empty index', async () => {
    const h = host();
    await handleNestSidebarMessage(h, { type: 'requestNestIndex' }, () => true);
    expect(h.sent).toEqual([{ type: 'origami/nestIndex', rows: [], desks: [], tail: null, away: [] }]); // t-selspn: no tail off the mother base
  });
  it('with Nests on drops this desk\'s own rows and keeps the rest', async () => {
    registerNestSource(fixture);
    const h = host();
    await handleNestSidebarMessage(h, { type: 'requestNestIndex' }, () => true);
    const rows = h.sent[0].rows as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).not.toContain('mine');
    expect(rows).toHaveLength(ROWS.length);
    expect(h.sent[0].desks).toEqual(DESKS);
  });
  it('a row filter with no self id keeps every object row and drops junk', () => {
    expect(otherDeskRows([{ id: 'a', desk: 'x' }, null, 'no'], null)).toEqual([{ id: 'a', desk: 'x' }]);
  });
});

describe('nestContinue', () => {
  it('a running chat forks, an idle one is taken, in the result shape the webview reads', async () => {
    registerNestSource(fixture);
    const h = host();
    await handleNestSidebarMessage(h, { type: 'requestNestIndex' }, () => true);
    await handleNestSidebarMessage(h, { type: 'nestContinue', id: 'n-cron' }, () => true);
    await handleNestSidebarMessage(h, { type: 'nestContinue', id: 'n-agent' }, () => true);
    expect(h.sent.slice(1)).toEqual([
      { type: 'nestContinueResult', id: 'n-cron', result: 'forked', newId: 'n-cron-f' },
      { type: 'nestContinueResult', id: 'n-agent', result: 'taken', newId: 'n-agent' },
    ]);
  });
  it('is refused while Nests is off', async () => {
    const h = host();
    await handleNestSidebarMessage(h, { type: 'nestContinue', id: 'n-agent' }, () => false);
    expect(h.sent).toEqual([{ type: 'nestContinueResult', id: 'n-agent', error: 'Nests is off.' }]);
  });
  it('a source that throws becomes an error result, not a silent drop', async () => {
    registerNestSource({ ...fixture, continueHere: async () => { throw new Error('owner desk refused'); } });
    const h = host();
    await handleNestSidebarMessage(h, { type: 'nestContinue', id: 'n-agent' }, () => true);
    expect(h.sent).toEqual([{ type: 'nestContinueResult', id: 'n-agent', error: 'owner desk refused' }]);
  });
});
