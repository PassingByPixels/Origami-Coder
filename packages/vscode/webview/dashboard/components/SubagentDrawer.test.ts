// SubagentDrawer.test.ts — the roster's RUNNING / COMPLETE split, driven
// through the mounted drawer.
//
// The rule is only half a data rule. `groupSubagents` (subagentRows.test.ts)
// says which array a row goes in; what this asserts is the other half — that
// the drawer draws both bands, puts each row under the right heading, and
// draws NO heading for a band with nothing in it. A standing "Complete 0" on
// a 240px glance surface spends a line saying nothing.
//
// Direct-render, the precedent SubagentRow.test.ts set for this family: the
// pane-level suite covers the wiring, this covers the component.

import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import SubagentDrawer from './SubagentDrawer.svelte';
import type { SubagentRow as SubagentRowT } from '../panes/subagentRows';

const row = (over: Partial<SubagentRowT> = {}): SubagentRowT => ({
  key: 'child-1',
  taskSessionId: 'child-1',
  title: 'task: audit the bundle',
  state: 'running',
  elapsedMs: 5_000,
  activity: '',
  stream: '',
  ...over,
});

/** The drawer's row list is collapsed by default; open it and read the bands. */
async function open(rows: SubagentRowT[]) {
  const { container } = render(SubagentDrawer, {
    rows, open: true, onToggle: () => {}, onDismiss: () => {}, onOpenInTab: () => {},
  });
  const head = container.querySelector('.sa-head') as HTMLElement;
  await fireEvent.click(head);
  return container;
}

const bands = (c: HTMLElement) =>
  [...c.querySelectorAll('.sa-group')].map((g) => ({
    label: g.querySelector('.sa-group-label')?.textContent ?? '',
    rows: [...g.querySelectorAll('.sa-name')].map((n) => n.textContent ?? ''),
  }));

describe('SubagentDrawer — Running and Complete', () => {
  it('puts a live agent under Running and a settled one under Complete', async () => {
    const c = await open([
      row({ key: 'a', title: 'still going', state: 'running' }),
      row({ key: 'b', title: 'finished', state: 'done' }),
    ]);
    expect(bands(c)).toEqual([
      { label: 'Running', rows: ['still going'] },
      { label: 'Complete', rows: ['finished'] },
    ]);
  });

  it('a queued agent is Running and an errored one is Complete', async () => {
    // The two states that are easy to get backwards: `queued` has not started
    // (still out), `error` has stopped (finished, badly).
    const c = await open([
      row({ key: 'a', title: 'waiting', state: 'queued' }),
      row({ key: 'b', title: 'blew up', state: 'error' }),
      row({ key: 'c', title: 'never spawned', state: 'failed' }),
    ]);
    expect(bands(c)).toEqual([
      { label: 'Running', rows: ['waiting'] },
      { label: 'Complete', rows: ['blew up', 'never spawned'] },
    ]);
  });

  it('draws NO heading for a band with no rows', async () => {
    const c = await open([row({ state: 'done' })]);
    expect(bands(c).map((b) => b.label)).toEqual(['Complete']);
  });

  it('counts only the RUNNING ones on the collapsed tab', async () => {
    // The tab is what a user sees with the drawer shut. Counting settled rows
    // there would say "3 sub-agents running" over a chat with one.
    //
    // QUEUED IS IN THIS FIXTURE ON PURPOSE, and it is the case the test missed
    // when the roster gained its Running/Complete bands: a queued row sits in
    // the RUNNING BAND (it belongs beside the ones working) but is NOT running,
    // so counting the band made the tab say "1 sub-agent running" over a header
    // reading "0 running · 1 queued". Without a queued row here the test passes
    // while the property its own name claims is false.
    const { container } = render(SubagentDrawer, {
      rows: [
        row({ key: 'a', state: 'running' }),
        row({ key: 'q', state: 'queued' }),
        row({ key: 'b', state: 'done' }),
        row({ key: 'c', state: 'error' }),
      ],
      open: false, onToggle: () => {}, onDismiss: () => {}, onOpenInTab: () => {},
    });
    expect(container.querySelector('.sa-tab')?.getAttribute('title')).toBe('1 sub-agent running');
    expect(container.querySelector('.sa-tab-count')?.textContent).toBe('1');
  });

  it('says nothing is running when the only outstanding agent is QUEUED', async () => {
    // The boundary the count has to get right: a queued row still draws the
    // drawer and still sits in the Running band, but the tab must not claim a
    // running agent, and the badge must not appear at all.
    const { container } = render(SubagentDrawer, {
      rows: [row({ key: 'q', state: 'queued' })],
      open: false, onToggle: () => {}, onDismiss: () => {}, onOpenInTab: () => {},
    });
    expect(container.querySelector('.sa-tab')?.getAttribute('title')).toBe('0 sub-agents running');
    expect(container.querySelector('.sa-tab-count')).toBeNull();
  });
});
