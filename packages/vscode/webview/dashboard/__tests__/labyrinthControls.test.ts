// The Labyrinth pane's three new controls, asserted ONLY where jsdom can tell
// the truth: which elements are mounted, what is posted to the host, and what
// the user is TOLD. Nothing here claims anything about size or position —
// jsdom has no layout engine and vitest.config.mts does not set css:true, so
// no <style> reaches this DOM and getComputedStyle would answer "" for every
// one of them. The fit MATH lives in labyrinthColumns.test.ts and the label
// budget in labyrinthThreadFit.test.ts, both as plain numbers.
//
// Whether the fitted map actually looks right, and whether a crowded thread
// stops overlapping, still needs a human eye.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const btn = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

// One plain run and one collab, so the filter has both a header and members.
const RUNS = [
  { sessionId: 'ses_a', title: 'Assess the labyrinth repo', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-08-01T14:05:00.000Z' },
  { sessionId: 'ses_m1', title: 'map the repo', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-08-01T13:00:00.000Z', collabId: 'c1', collabTitle: 'Wave 9 sweep', agentSlug: 'cartographer' },
  { sessionId: 'ses_m2', title: 'write the notes', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-08-01T13:30:00.000Z', collabId: 'c1', collabTitle: 'Wave 9 sweep', agentSlug: 'scribe' },
];

async function listed() {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: RUNS });
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

// The trap this exists for: "collapsed" cannot be a width of 0. The host
// coerces a non-positive width to undefined, so a 0 would ERASE the width the
// user had dragged to and re-opening would snap to the pane default instead.
describe('LabyrinthPane — the inspector column collapses without losing its width', () => {
  it('starts open, with the column and its divider both on screen', () => {
    const { container } = render(LabyrinthPane);
    expect(container.querySelector('.lab-inspect')).not.toBeNull();
    expect(container.querySelectorAll('.lab-divider')).toHaveLength(2);
  });

  it('collapsing removes the column AND its now-undraggable divider', async () => {
    const { container } = render(LabyrinthPane);
    await fireEvent.click(btn(container, 'Inspector'));
    await tick();
    expect(container.querySelector('.lab-inspect')).toBeNull();
    expect(container.querySelectorAll('.lab-divider')).toHaveLength(1);
  });

  it('posts a collapsed FLAG and NO width — a width of 0 would erase the stored one', async () => {
    const { container } = render(LabyrinthPane);
    await fireEvent.click(btn(container, 'Inspector'));
    const post = posts().findLast((p) => p.type === 'resizeLabyrinthColumn')!;
    expect(post).toMatchObject({ column: 'inspect', collapsed: true });
    expect(post).not.toHaveProperty('widthPx');
  });

  it('re-opening restores the REMEMBERED width, not the pane default', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'labyrinthColumns', indexWidthPx: null, inspectWidthPx: 260, inspectCollapsed: false });
    await tick();
    await fireEvent.click(btn(container, 'Inspector'));
    await tick();
    expect(container.querySelector('.lab-inspect')).toBeNull();

    await fireEvent.click(btn(container, 'Inspector'));
    await tick();
    expect((container.querySelector('.lab-inspect') as HTMLElement).style.width).toBe('260px');
  });

  it('a host reply saying collapsed is honoured on mount, so the state survives a reload', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'labyrinthColumns', indexWidthPx: null, inspectWidthPx: 260, inspectCollapsed: true });
    await tick();
    expect(container.querySelector('.lab-inspect')).toBeNull();
  });
});

describe('LabyrinthPane — fit to width is a switch the pane owns', () => {
  it('offers the control and toggles its pressed state', async () => {
    const { container } = render(LabyrinthPane);
    const fit = btn(container, 'Fit');
    expect(fit.classList.contains('active')).toBe(false);
    await fireEvent.click(fit);
    await tick();
    expect(btn(container, 'Fit').classList.contains('active')).toBe(true);
  });
});

// The rule a screenshot cannot show, asserted through the real panel: a collab
// header must survive on a member match, because the member row is ONLY
// reachable underneath it.
describe('LabyrinthPane — filtering the run index', () => {
  const type = async (c: HTMLElement, value: string) => {
    await fireEvent.input(c.querySelector('.lab-search')!, { target: { value } });
    await tick();
  };

  it('lists everything with no query', async () => {
    const { container } = await listed();
    expect(container.querySelectorAll('.lab-run')).toHaveLength(2); // plain + collab header
  });

  it('narrows to the matching run and says shown of total', async () => {
    const { container } = await listed();
    await type(container, 'assess');
    expect(container.querySelectorAll('.lab-run')).toHaveLength(1);
    expect(flat(container.querySelector('.lab-count')!.textContent)).toBe('1/4');
  });

  it('keeps a collab HEADER when only a member matches — the member has no other route in', async () => {
    const { container } = await listed();
    await type(container, 'scribe');
    const rows = container.querySelectorAll('.lab-run');
    expect(rows).toHaveLength(1);
    expect(flat(rows[0]!.textContent)).toContain('Wave 9 sweep');
    // ...and opening it really does reach that member.
    await fireEvent.click(container.querySelector('.lab-expand')!);
    await tick();
    expect(flat(container.textContent)).toContain('scribe');
    expect(flat(container.textContent)).not.toContain('cartographer');
  });

  it('says the FILTER emptied the list — never "you have no past runs"', async () => {
    const { container } = await listed();
    await type(container, 'zzz-nothing');
    const empty = flat(container.querySelector('.lab-empty')!.textContent);
    expect(empty).toContain('No run matches');
    expect(empty).toContain('zzz-nothing');
    expect(empty).not.toContain('No past runs yet');
  });

  it('still distinguishes "still loading" from "genuinely none" — three states, not two', async () => {
    const loading = render(LabyrinthPane);
    expect(flat(loading.container.querySelector('.lab-empty')!.textContent)).toContain('Loading past runs');
    cleanup();

    const none = render(LabyrinthPane);
    send({ type: 'historyList', sessions: [] });
    await tick();
    expect(flat(none.container.querySelector('.lab-empty')!.textContent)).toContain('No past runs yet');
  });
});
