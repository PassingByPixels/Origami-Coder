// SubagentDrawer.test.ts — the roster's RUNNING / COMPLETE split, the Complete
// band's fold, and the agent-map button, driven through the mounted drawer.
//
// The rule is only half a data rule. `groupSubagents` (subagentRows.test.ts)
// says which array a row goes in; what this asserts is the other half — that
// the drawer draws both bands, puts each row under the right heading, and
// draws NO heading for a band with nothing in it. A standing "Complete 0" on
// a 240px glance surface spends a line saying nothing.
//
// Direct-render, the precedent SubagentRow.test.ts set for this family: the
// pane-level suite covers the wiring, this covers the component.
//
// EVERY prop bag here comes from `drawerProps` (panes/subagentRowFixture.ts).
// The ad-hoc literals this file used to build had drifted — a `stream` field
// deleted months earlier, an `onOpenInTab` renamed to `onOpen` — and stayed
// green, because Svelte drops an undeclared prop in silence and the type gate
// does not read test files. The factory's types live where the gate DOES read.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import SubagentDrawer from './SubagentDrawer.svelte';
import { drawerProps, row } from '../panes/subagentRowFixture';

afterEach(() => cleanup());

/** Open the row list and read the bands. It is collapsed by default UNLESS a
 *  running row revealed it on mount (t-ru13hb item 3, subagentAutoOpen.test.ts),
 *  so this clicks the head only when it is still shut — clicking it regardless
 *  would fold the list away again and every band assertion would read []. */
async function open(rows: ReturnType<typeof row>[]) {
  const { container } = render(SubagentDrawer, drawerProps(rows));
  await tick();
  if (!container.querySelector('.sa-groups')) {
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
  }
  // ...and the COMPLETE band is shut inside it (t-d93fjo). These cases assert
  // which band a row lands in, so open it; the fold has its own suite below.
  const fold = container.querySelector('.sa-group-fold') as HTMLElement | null;
  if (fold) await fireEvent.click(fold);
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
      row({ key: 'a', ordinal: 1, description: 'still going', state: 'running' }),
      row({ key: 'b', ordinal: 3, description: 'finished', state: 'done', settled: true }),
    ]);
    expect(bands(c)).toEqual([
      { label: 'Running', rows: ['T1 · still going'] },
      { label: 'Complete', rows: ['T3 · finished'] },
    ]);
  });

  it('a queued agent is Running and an errored one is Complete', async () => {
    // The two states that are easy to get backwards: `queued` has not started
    // (still out), `error` has stopped (finished, badly).
    const c = await open([
      row({ key: 'a', ordinal: 1, description: 'waiting', state: 'queued' }),
      row({ key: 'b', ordinal: 2, description: 'blew up', state: 'error', settled: true }),
      row({ key: 'c', ordinal: 3, description: 'never spawned', state: 'failed', settled: true }),
    ]);
    expect(bands(c)).toEqual([
      { label: 'Running', rows: ['T1 · waiting'] },
      { label: 'Complete', rows: ['T2 · blew up', 'T3 · never spawned'] },
    ]);
  });

  it('draws NO heading for a band with no rows', async () => {
    const c = await open([row({ state: 'done', settled: true })]);
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
    const { container } = render(SubagentDrawer, drawerProps([
      row({ key: 'a', state: 'running' }),
      row({ key: 'q', state: 'queued' }),
      row({ key: 'b', state: 'done', settled: true }),
      row({ key: 'c', state: 'error', settled: true }),
    ], { open: false }));
    expect(container.querySelector('.sa-tab')?.getAttribute('title')).toBe('1 sub-agent running');
    expect(container.querySelector('.sa-tab-count')?.textContent).toBe('1');
  });

  it('says nothing is running when the only outstanding agent is QUEUED', async () => {
    // The boundary the count has to get right: a queued row still draws the
    // drawer and still sits in the Running band, but the tab must not claim a
    // running agent, and the badge must not appear at all.
    const { container } = render(SubagentDrawer, drawerProps([row({ key: 'q', state: 'queued' })], { open: false }));
    expect(container.querySelector('.sa-tab')?.getAttribute('title')).toBe('0 sub-agents running');
    expect(container.querySelector('.sa-tab-count')).toBeNull();
  });
});

// t-d93fjo — the second half of the owner's screenshot: "2 running · 5 done · 4
// error". Nine settled rows pushed the two that were still working off a 220px
// list. The Complete band folds; Running never does.
describe('SubagentDrawer — the Complete band folds, Running does not', () => {
  /** Open the drawer's row list, WITHOUT touching the band folds. */
  async function list(rows: ReturnType<typeof row>[]) {
    const { container } = render(SubagentDrawer, drawerProps(rows));
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    return container;
  }
  const names = (c: HTMLElement) => [...c.querySelectorAll('.sa-name')].map((n) => n.textContent);

  it('hides settled rows by default and keeps every running one visible', async () => {
    const c = await list([
      row({ key: 'a', ordinal: 1, description: 'still going', state: 'running' }),
      row({ key: 'q', ordinal: 2, description: 'waiting', state: 'queued' }),
      row({ key: 'b', ordinal: 3, description: 'finished', state: 'done', settled: true }),
      row({ key: 'e', ordinal: 4, description: 'blew up', state: 'error', settled: true }),
    ]);
    // Both bands still draw their HEADING — the count is the point of a fold —
    // but only the running ones' rows are in the DOM.
    expect(bands(c).map((b) => b.label)).toEqual(['Running', 'Complete']);
    expect(names(c)).toEqual(['T1 · still going', 'T2 · waiting']);
    expect(c.querySelector('.sa-group-fold')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('the Running band has no fold control at all', async () => {
    // Not merely defaulted open: hiding what is still working is the one thing
    // this drawer exists to prevent, so there is no button to do it with. One
    // fold in the DOM, and it is the Complete one.
    const c = await list([row({ key: 'a', state: 'running' }), row({ key: 'b', state: 'done', settled: true })]);
    const folds = [...c.querySelectorAll('.sa-group-fold')];
    expect(folds).toHaveLength(1);
    expect(folds[0].querySelector('.sa-group-label')?.textContent).toBe('Complete');
  });

  it('expands and re-collapses on the heading, and SURVIVES a re-render', async () => {
    const rows = [
      row({ key: 'a', ordinal: 1, description: 'still going', state: 'running' }),
      row({ key: 'b', ordinal: 3, description: 'finished', state: 'done', settled: true }),
    ];
    const { container, rerender } = render(SubagentDrawer, drawerProps(rows));
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    await fireEvent.click(container.querySelector('.sa-group-fold') as HTMLElement);
    expect(names(container)).toEqual(['T1 · still going', 'T3 · finished']);

    // The re-render is the case the fold has to survive: the drawer re-derives
    // its rows once a second while anything is out, so a fold owned by the band
    // (which is rebuilt each time) would snap shut under the user's cursor.
    await rerender(drawerProps([
      row({ key: 'a', ordinal: 1, description: 'still going', state: 'running', elapsedMs: 9_000 }),
      row({ key: 'b', ordinal: 3, description: 'finished', state: 'done', settled: true }),
    ]));
    expect(names(container)).toEqual(['T1 · still going', 'T3 · finished']);

    await fireEvent.click(container.querySelector('.sa-group-fold') as HTMLElement);
    expect(names(container)).toEqual(['T1 · still going']);
  });
});

// t-h8gv8w — the COMPLETE band is a HISTORY. The bulk "Clear complete" link is
// gone (it cleared a record nobody was asked about); the per-row × is the one
// way out, and it is covered by the dismiss cases above.
describe('SubagentDrawer — no bulk clear', () => {
  it('draws NO clear control over the Complete band', async () => {
    const c = await open([
      row({ key: 'a', state: 'running' }),
      row({ key: 'b', state: 'done', settled: true }),
    ]);
    // The band itself is there, with its settled row in it.
    const complete = [...c.querySelectorAll('.sa-group')]
      .find((g) => g.querySelector('.sa-group-label')?.textContent === 'Complete');
    expect(complete, 'the Complete band still lists the finished row').not.toBeUndefined();
    expect(c.querySelector('.sa-group-clear')).toBeNull();
  });
});

describe('SubagentDrawer — the agent-map button', () => {
  it('sits on the pull-out itself and reports the request', async () => {
    const onMap = vi.fn();
    const { container } = render(SubagentDrawer, drawerProps([row()], { onMap }));
    const button = container.querySelector('.sa-map-btn') as HTMLElement;
    expect(button).not.toBeNull();
    await fireEvent.click(button);
    expect(onMap).toHaveBeenCalledTimes(1);
  });

  it('does not fold the list — the two head controls are independent', async () => {
    // Nested inside the fold <button> the map control would both be untrustworthy
    // to click and would collapse the roster on the way past.
    const { container } = render(SubagentDrawer, drawerProps([row()]));
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    await fireEvent.click(container.querySelector('.sa-map-btn') as HTMLElement);
    expect(container.querySelector('.sa-head')?.getAttribute('aria-expanded')).toBe('true');
  });
});
