// W7-L2: the per-tool checklist draws one row per gate the engine reports —
// ~28 today, per BotContractFields.svelte's own docstring — and Passing
// flagged that the list only grows as tools ship: "should probably be within
// a scroll box... would look cleaner" once it does. Fix: wrap the tick GRID
// itself in its own scrollable container, and leave everything else — the
// Worker/Observer preset buttons, the tick-count summary beside them, the
// "Tools" sub-label and its live/mirror note — in the form's normal flow
// above it, never inside the box that scrolls.
//
// jsdom has no layout engine, so nothing here can assert an actual scrollbar,
// a computed max-height, or how many rows fit before one wraps. What IS
// provable without layout is STRUCTURE: the grid is nested inside its own
// scroll container, and the summary line and any control are OUTSIDE it —
// siblings of the container, never descendants.
//
// (W9 removed the Worker/Observer buttons the original comment named. The
// structural rule is unchanged and is now stated without them.)

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import BotContractFields from '../components/BotContractFields.svelte';
import { TOOL_IDS } from '../../../src/dashboard/botTools';

afterEach(cleanup);

const mount = (tools: string[] | undefined) =>
  render(BotContractFields, {
    props: {
      bot: {},
      tools,
      preset: tools ? undefined : 'worker',
      toolCatalog: TOOL_IDS,
    },
  });

describe('BotContractFields — the tool checklist scrolls, not the whole form', () => {
  it('wraps the tick grid in its own scroll container, with every row inside it', () => {
    const { container } = mount(['read']);
    const scroller = container.querySelector('.bc-picks-scroll');
    const grid = container.querySelector('.bc-picks');
    expect(scroller).not.toBeNull();
    expect(grid).not.toBeNull();
    // The grid is INSIDE the scroll container, not a sibling of it — the box
    // that scrolls has to be the box the rows actually live in.
    expect(scroller!.contains(grid)).toBe(true);
    // The tool catalog is ~28 rows deep; a growing list is the whole point of
    // the box, so every row must land inside the thing that scrolls.
    const rows = grid!.querySelectorAll('.bc-tool');
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) expect(scroller!.contains(row)).toBe(true);
  });

  it('does NOT swallow the tick-count summary, or any control above the grid', () => {
    const { container } = mount(['read']);
    const scroller = container.querySelector('.bc-picks-scroll') as HTMLElement;
    expect(scroller).not.toBeNull();

    // The "N tools" summary sits above the grid and must stay readable without
    // scrolling: it is the one line that says what the whole list adds up to.
    const summary = container.querySelector('.bc-count');
    expect(summary).not.toBeNull();
    expect(scroller.contains(summary)).toBe(false);

    // W9 retired the Worker/Observer buttons — a new bot is born ticked on every
    // tool and the user unticks — so the assertion that used to name them now
    // says the general thing instead: nothing that is not a tick row may end up
    // inside the box that scrolls. A control the user can no longer see is a
    // control they cannot use, whatever it happens to be.
    for (const btn of container.querySelectorAll('.bc-btn')) expect(scroller.contains(btn)).toBe(false);
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent!.trim()))
      .not.toContain('Worker');
  });

  it('draws no scroll container at all when the checklist itself is hidden (hand-tuned block)', () => {
    const { container } = render(BotContractFields, {
      props: { bot: {}, tools: undefined, preset: undefined, handTuned: true, toolCatalog: TOOL_IDS },
    });
    // BotContractFields already refuses to draw the grid over a hand-tuned
    // permission block (see the file's own comment) — the scroll wrapper must
    // not appear either, since there is nothing for it to hold.
    expect(container.querySelector('.bc-picks-scroll')).toBeNull();
    expect(container.querySelector('.bc-picks')).toBeNull();
  });
});
