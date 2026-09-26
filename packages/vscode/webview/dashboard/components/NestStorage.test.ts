// t-xum9go: the Storage card showed no per-class breakdown on the mother-base
// desk (every class row "—" even though the tab total was measured), and the
// "other desk" footer claimed figures "arrive with the nest index" although
// no verb ever sends them (nestWire.ts NEST_INDEX carries chat rows only).
import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import NestStorage from './NestStorage.svelte';
import type { NestDesk } from './nestsStatus';

afterEach(cleanup);

const STATS = {
  stats: {
    classes: { chats: 8_000_000_000, subagents: 2_000_000_000, toolOutput: 1_000_000_000, journal: 500_000_000, artifacts: 3_000_000_000 },
    journalEventsPerPart: 1,
  },
  measuredAt: Date.now(),
  retention: { windows: { chats: 30, subagents: 14, toolOutput: 7, artifacts: 90 } },
};

function desk(over: Partial<NestDesk>): NestDesk {
  return { id: 'd1', name: 'Desk', self: false, online: true, motherBase: false, os: 'windows', lastSeen: Date.now(), ...over };
}

function classCells(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.classes .cs')).map((n) => n.textContent);
}

describe('NestStorage — mother base desk breakdown (t-xum9go)', () => {
  it('shows this desk\'s per-class Held sizes when this desk is ALSO the mother base', async () => {
    const desks = [desk({ id: 'home', self: true, motherBase: true }), desk({ id: 'other' })];
    const { container } = render(NestStorage, { props: { desks } });
    window.postMessage({ type: 'nestStorageData', ...STATS }, '*');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const cells = classCells(container);
    expect(cells).not.toEqual(cells.map(() => '—'));
    expect(cells).toContain('7.5 GB');
  });

  it('still shows "Everything" in the Keep column for the mother base (unchanged)', async () => {
    const desks = [desk({ id: 'home', self: true, motherBase: true }), desk({ id: 'other' })];
    const { container } = render(NestStorage, { props: { desks } });
    window.postMessage({ type: 'nestStorageData', ...STATS }, '*');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const keepCells = Array.from(container.querySelectorAll('.classes .ck .fixed')).map((n) => n.textContent);
    expect(keepCells).toContain('Everything');
  });
});

describe('NestStorage — another desk\'s footer (t-xum9go)', () => {
  it('does not claim that another desk\'s figures arrive with the nest index', async () => {
    const desks = [desk({ id: 'home', self: true, motherBase: true }), desk({ id: 'other', name: 'Mac' })];
    const { container } = render(NestStorage, { props: { desks } });
    window.postMessage({ type: 'nestStorageData', ...STATS }, '*');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const tabs = Array.from(container.querySelectorAll('.mtab'));
    const other = tabs.find((t) => t.textContent?.includes('Mac'))!;
    (other as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const foot = container.querySelector('.foot')?.textContent ?? '';
    expect(foot).not.toContain('arrive with the nest index');
    // still shows "—" for the other desk's classes: no data was ever received for it.
    const cells = classCells(container);
    expect(cells.every((c) => c === '—')).toBe(true);
  });
});
