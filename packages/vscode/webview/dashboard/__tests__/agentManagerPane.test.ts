// Folds board (v2, transposed; regridded by contract §11) — component
// regression tests for the behaviour that lives purely in the Svelte view: the
// repo cards over a 2x3 grid of blocks for one repo, ticket cards vs fold
// cards, quick-add, drag-to-queue, the launch / spec popover, the card filter,
// view-state persistence and the board shortcuts.
//
// Every block lookup here is BY LABEL, never by index. The blocks are a
// lifecycle, so they will be reordered eventually — a positional query would
// keep passing while clicking the wrong block's buttons, which is exactly the
// regression these tests exist to catch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { tick } from 'svelte';
import AgentManagerPane from '../panes/AgentManagerPane.svelte';

interface RowFixture {
  id: string; name: string; branch: string; path: string; orphan: boolean;
  state: 'provisioning' | 'working' | 'idle' | 'error' | 'detached' | 'queued';
  agentName: string; model: string; stopReason: string; errorDetail: string; setupNote: string;
  startedAt: number; hasSession: boolean; ahead: number; adds: number; dels: number; queuedPrompt: string;
  mergedAt: number; groupId: string; ticketId: string; ticketTitle: string; activity: string;
  needsYou: { kind: string; preview: string } | null;
}
interface TicketFixture {
  id: string; title: string; status: string; priority: string;
  labels: string[]; assignee: string; acceptance: { done: number; total: number };
  updatedAt: number; fold: string; branch: string; malformed?: boolean; spec?: boolean;
}
interface RepoFixture {
  root: string; name: string; workspace: boolean; missing: boolean;
  defaultModel: string; rows: RowFixture[]; map: { status: string }; tickets: TicketFixture[];
}

const repo = (root: string, defaultModel = '', rows: RowFixture[] = [], tickets: TicketFixture[] = []): RepoFixture =>
  ({ root, name: root.split('/').pop()!, workspace: false, missing: false, defaultModel, rows, map: { status: 'none' }, tickets });
const mkRow = (over: Partial<RowFixture>): RowFixture => ({
  id: 'r1', name: 'agent', branch: 'origami/agent', path: '/wt/agent', orphan: false,
  state: 'detached', agentName: 'tsuru', model: '', stopReason: '', errorDetail: '', setupNote: '',
  startedAt: Date.now(), hasSession: false, ahead: 0, adds: 0, dels: 0, queuedPrompt: '',
  mergedAt: 0, groupId: '', ticketId: '', ticketTitle: '', activity: '', needsYou: null,
  ...over,
});
const mkTicket = (over: Partial<TicketFixture>): TicketFixture => ({
  id: 't-aaa111', title: 'a ticket', status: 'triage', priority: 'normal',
  labels: [], assignee: '', acceptance: { done: 0, total: 0 },
  updatedAt: Date.now(), fold: '', branch: '',
  ...over,
});

function amState(repos: RepoFixture[], extra: Record<string, unknown> = {}): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'amState', repos, noRepo: repos.length === 0, ...extra },
  }));
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

// A stand-in for the DataTransfer jsdom does not implement. @testing-library
// hands the object straight through to the event, so a plain bag of the two
// methods the components use is enough to drive a real drag.
const dt = () => {
  const store: Record<string, string> = {};
  return {
    effectAllowed: '', dropEffect: '',
    setData: (k: string, v: string) => { store[k] = v; },
    getData: (k: string) => store[k] ?? '',
  };
};

// ---- LABEL-based column access: reordering the board must break nothing here. ----
const columnLabels = (c: HTMLElement): (string | null)[] =>
  Array.from(c.querySelectorAll('.am-scol-name')).map((n) => n.textContent);
function column(c: HTMLElement, label: string): HTMLElement {
  const found = Array.from(c.querySelectorAll('.am-scol'))
    .find((s) => s.querySelector('.am-scol-name')?.textContent?.trim() === label);
  if (!found) throw new Error(`no column labelled "${label}" (have: ${columnLabels(c).join(', ')})`);
  return found as HTMLElement;
}
const count = (c: HTMLElement, label: string): string =>
  column(c, label).querySelector('.am-scol-count')!.textContent!.trim();
const cardsIn = (c: HTMLElement, label: string): Element[] =>
  Array.from(column(c, label).querySelectorAll('.am-card'));
const ticketsIn = (c: HTMLElement, label: string): Element[] =>
  Array.from(column(c, label).querySelectorAll('.am-ticket'));
// Merged is NOT a block of its own (contract §11.1): it is a collapsed divider
// inside Done. Everything about it is reached through that divider, so a test
// cannot accidentally assert against a seventh column that no longer exists.
const merged = (c: HTMLElement): HTMLElement => {
  const found = column(c, 'Done').querySelector('.am-merged');
  if (!found) throw new Error('the Done block has no Merged subsection');
  return found as HTMLElement;
};
const mergedCount = (c: HTMLElement): string =>
  merged(c).querySelector('.am-merged-count')!.textContent!.trim();
const toggleMerged = async (c: HTMLElement): Promise<void> => {
  await fireEvent.click(merged(c).querySelector('.am-merged-head')!);
  await tick();
};
const card = (c: HTMLElement, name: string): HTMLButtonElement => {
  const found = Array.from(c.querySelectorAll('.am-repocard'))
    .find((p) => (p.querySelector('.am-repocard-name')?.textContent ?? '').includes(name));
  if (!found) throw new Error(`no repo card for "${name}"`);
  return found as HTMLButtonElement;
};
const byTitle = (scope: Element, needle: string): HTMLButtonElement => {
  const found = Array.from(scope.querySelectorAll('button'))
    .find((b) => (b.getAttribute('title') ?? '').toLowerCase().includes(needle.toLowerCase()));
  if (!found) throw new Error(`no button titled ~"${needle}"`);
  return found as HTMLButtonElement;
};
const byText = (scope: Element, text: string): HTMLButtonElement => {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button reading "${text}"`);
  return found as HTMLButtonElement;
};

// jsdom has no layout: every getBoundingClientRect is a box of zeros, so the
// anchoring rules below are untestable without saying where things ARE. This
// stubs the rect BY SELECTOR (the opening card, the popover's own size) and
// hands back the restore, so no other suite inherits a faked layout.
const ZERO = { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
function fakeRects(map: Record<string, Partial<typeof ZERO>>): () => void {
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    for (const [sel, r] of Object.entries(map)) {
      if (this.matches(sel)) return { ...ZERO, ...r, toJSON: () => ({}) } as DOMRect;
    }
    return orig.call(this);
  };
  return () => { Element.prototype.getBoundingClientRect = orig; };
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  globalThis.__vscodeApiMock.getState.mockReset();
  globalThis.__vscodeApiMock.getState.mockReturnValue(undefined);
  globalThis.__vscodeApiMock.setState.mockClear();
});
afterEach(() => cleanup());

describe('Folds board — the 2x3 grid of blocks', () => {
  it('renders SIX blocks, in lifecycle order, each with a one-line subtitle', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    // Seven columns side by side did not fit a pane (UAT round 1) — six blocks,
    // three per row, and Merged folded into Done.
    expect(columnLabels(container)).toEqual(['Triage', 'Todo', 'Pending', 'In progress', 'Blocked', 'Done']);
    for (const label of columnLabels(container)) {
      expect(column(container, label!).querySelector('.am-scol-sub')!.textContent!.trim().length).toBeGreaterThan(0);
    }
    expect(column(container, 'Triage').querySelector('.am-scol-sub')!.textContent)
      .toContain('raw ideas');
  });

  it('an empty repo shows all six blocks at 0 — the board never hides a stage', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    for (const label of columnLabels(container)) expect(count(container, label!)).toBe('0');
    expect(mergedCount(container)).toBe('0');
  });

  it('Merged is a COLLAPSED subsection of Done: divider + count, open on click', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'm1', name: 'shipped', state: 'idle', mergedAt: Date.now() }),
      mkRow({ id: 'd1', name: 'finished', state: 'idle' }),
    ])]);
    await tick();
    // Collapsed by default: the merged card is NOT drawn, only counted.
    expect(mergedCount(container)).toBe('1');
    expect(count(container, 'Done')).toBe('1'); // Done's own head counts only its own
    expect(cardsIn(container, 'Done').length).toBe(1);
    expect(merged(container).querySelector('.am-merged-head')!.getAttribute('aria-expanded')).toBe('false');

    await toggleMerged(container);
    expect(merged(container).querySelector('.am-merged-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(merged(container).querySelectorAll('.am-card').length).toBe(1);
    expect(merged(container).querySelector('.am-name')!.textContent).toBe('shipped');

    // ...and a poll-tick broadcast must not fold it back under you.
    amState([repo('/repo/a', '', [mkRow({ id: 'm1', name: 'shipped', state: 'idle', mergedAt: Date.now() })])]);
    await tick();
    expect(merged(container).querySelectorAll('.am-card').length).toBe(1);
    await toggleMerged(container);
    expect(merged(container).querySelectorAll('.am-card').length).toBe(0);
  });
});

describe('Folds board — the bucket table, rendered', () => {
  it('every state lands in its column: queued/working/idle/merged + triage/todo tickets', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'q', state: 'queued', queuedPrompt: 'do' }),
      mkRow({ id: 'p', state: 'provisioning' }),
      mkRow({ id: 'w', state: 'working', hasSession: true }),
      mkRow({ id: 'i', state: 'idle' }),
      mkRow({ id: 'd', state: 'detached' }),
      mkRow({ id: 'm', state: 'idle', mergedAt: Date.now() }),
    ], [
      mkTicket({ id: 't-raw', status: 'triage' }),
      mkTicket({ id: 't-spec', status: 'todo', acceptance: { done: 0, total: 2 } }),
      mkTicket({ id: 't-hidden', status: 'closed' }),
    ])]);
    await tick();
    expect(count(container, 'Triage')).toBe('1');
    expect(count(container, 'Todo')).toBe('1');
    expect(count(container, 'Pending')).toBe('1');
    expect(count(container, 'In progress')).toBe('2'); // provisioning + working
    expect(count(container, 'Blocked')).toBe('0');
    expect(count(container, 'Done')).toBe('2');        // idle + detached
    expect(mergedCount(container)).toBe('1');
    // A closed ticket draws nowhere at all.
    expect(container.textContent).not.toContain('T-HIDDEN');
  });

  // Blocked is DERIVED in the view, never stored — the whole reason it is a
  // column at all. On the old board an errored run sat in Done next to a clean
  // finish, and a card waiting on an answer looked like a card that was running.
  it('DERIVES Blocked from needsYou or error, and marks those cards amber', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'e', name: 'failed', state: 'error', errorDetail: 'engine died' }),
      mkRow({ id: 'q', name: 'asking', state: 'working', hasSession: true, needsYou: { kind: 'question', preview: 'which file?' } }),
      mkRow({ id: 'w', name: 'busy', state: 'working', hasSession: true }),
    ])]);
    await tick();
    expect(count(container, 'Blocked')).toBe('2');
    expect(count(container, 'In progress')).toBe('1');
    expect(count(container, 'Done')).toBe('0'); // the errored run no longer squats in Done
    for (const card of cardsIn(container, 'Blocked')) expect(card.classList.contains('blocked')).toBe(true);
    expect(cardsIn(container, 'In progress')[0].classList.contains('blocked')).toBe(false);
  });

  it('a merged row retires to Merged whatever its runtime state', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'm', name: 'winner', state: 'error', errorDetail: 'late failure', mergedAt: Date.now() }),
    ])]);
    await tick();
    expect(mergedCount(container)).toBe('1');
    expect(count(container, 'Blocked')).toBe('0');
  });
});

describe('Folds board — a launched ticket is ONE card', () => {
  it('the fold row absorbs its ticket: no ticket card anywhere, and the fold headlines the ticket title', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'w1', name: 'agent-1', state: 'working', hasSession: true, ticketId: 't-8k2fq1', ticketTitle: 'Scroll block needs a max-width' }),
    ], [
      mkTicket({ id: 't-8k2fq1', title: 'Scroll block needs a max-width', status: 'in_progress', fold: 'w1' }),
    ])]);
    await tick();
    expect(cardsIn(container, 'In progress').length).toBe(1);
    expect(container.querySelectorAll('.am-ticket').length).toBe(0); // never drawn twice
    const card = cardsIn(container, 'In progress')[0];
    expect(card.querySelector('.am-name')!.textContent).toBe('Scroll block needs a max-width');
    expect(card.querySelector('.am-tk-chip')!.textContent).toBe('T-8K2FQ1'); // id chip, uppercased
  });

  it('a merged ticket that never got a fold still lands in Merged', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [mkTicket({ id: 't-old', title: 'done by hand', status: 'merged' })])]);
    await tick();
    expect(mergedCount(container)).toBe('1');
    await toggleMerged(container);
    expect(merged(container).querySelectorAll('.am-ticket').length).toBe(1);
  });

  // Two malformed files can both parse to an empty id. A duplicate {#each} key
  // throws inside Svelte and takes the WHOLE board down with it.
  it('two unidentifiable tickets both render instead of blanking the board', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [
      mkTicket({ id: '', title: 'first broken', malformed: true }),
      mkTicket({ id: '', title: 'second broken', malformed: true }),
    ])]);
    await tick();
    expect(ticketsIn(container, 'Triage').length).toBe(2);
    expect(count(container, 'Triage')).toBe('2');
  });

  // Lane B ships `tickets` on the wire; an older host (or a repo read before the
  // ticket dir existed) simply has no such field, and the board must still draw.
  it('an amState with no tickets field at all still renders the board', async () => {
    const { container } = render(AgentManagerPane);
    const legacy = repo('/repo/a', '', [mkRow({ id: 'r1', name: 'plain', state: 'idle' })]) as Partial<RepoFixture>;
    delete legacy.tickets;
    amState([legacy as RepoFixture]);
    await tick();
    expect(columnLabels(container).length).toBe(6);
    expect(cardsIn(container, 'Done').length).toBe(1);
    expect(count(container, 'Triage')).toBe('0');
  });

  it('a malformed ticket file surfaces in Triage with a warning, never dropped', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [mkTicket({ id: 't-bad', title: '', status: '', malformed: true })])]);
    await tick();
    const card = ticketsIn(container, 'Triage')[0];
    expect(card).toBeDefined();
    expect(card.textContent).toContain('malformed');
    // One action only — open the file and fix it.
    expect(card.querySelectorAll('.am-tk-btn').length).toBe(1);
  });
});

describe('Folds board — the repo cards', () => {
  it('one card per REPOSITORY, not per registered path, plus the ghost add card', async () => {
    const { container } = render(AgentManagerPane);
    // alpha and alpha-wt are two checkouts of ONE repository (same groupId), so
    // they draw ONE card; beta is its own. The old pill bar drew three.
    amState([
      { ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' },
      { ...repo('/x/alpha-wt'), groupId: 'g1', primary: '/x/alpha', branch: 'feature' },
      { ...repo('/x/beta'), groupId: 'g2', primary: '/x/beta', branch: 'main' },
    ]);
    await tick();
    expect(Array.from(container.querySelectorAll('.am-repocard:not(.ghost)')).length).toBe(2);
    expect(container.querySelector('.am-repocard.ghost')!.textContent).toContain('Add repo');
    // The face is the name and the PRIMARY's branch — and nothing else. The
    // working / blocked / queued badges are gone on purpose: the In progress and
    // Blocked columns two inches below already say it.
    expect(card(container, 'alpha').querySelector('.am-repocard-branch')!.textContent).toBe('trunk');
    expect(card(container, 'alpha').querySelectorAll('.am-badge').length).toBe(0);
  });

  // UAT round 2 on §11.6: ONE wrapping line used to hold the explainer, the cards
  // and the open card's worktree reveal at once, so every extra repo pushed the
  // board further down. Three panes share the row now, and the cards live in the
  // MIDDLE one — the only one that scrolls.
  it('the top strip is three panes: the explainer, the card strip, the selected repo', async () => {
    const { container } = render(AgentManagerPane);
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' }]);
    await tick();
    expect(container.querySelector('.am-topline'), 'the old single top line is gone').toBeNull();
    const top = container.querySelector('.am-toppanes') as HTMLElement;
    expect(top).not.toBeNull();
    expect(top.querySelector('.am-explain .am-title')!.textContent).toContain('isolated git worktrees');
    expect(top.querySelector('.am-detail')).not.toBeNull();
    // EVERY card is in the strip, ghost included — none of them beside the text.
    expect(top.querySelectorAll('.am-strip .am-repocard').length).toBe(2); // alpha + the ghost
    expect(container.querySelectorAll('.am-repocard').length).toBe(2);
    expect(card(container, 'alpha').querySelector('.am-repocard-name')).not.toBeNull();
  });

  // UAT round 3: "the middle panel should be two cards tall". One short row of
  // cards floated in a pane tall enough for two, so the strip wasted the height
  // it already had. The cards container is now a TWO-ROW grid that flows column
  // first — an extra card adds a column, never a third row, and the strip around
  // it still scrolls sideways.
  it('every card, ghost last, is a direct child of ONE cards container', async () => {
    const { container } = render(AgentManagerPane);
    amState([
      { ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' },
      { ...repo('/x/beta'), groupId: 'g2', primary: '/x/beta', branch: 'main' },
      { ...repo('/x/gamma'), groupId: 'g3', primary: '/x/gamma', branch: 'main' },
    ]);
    await tick();
    const grid = container.querySelector('.am-strip .am-cards') as HTMLElement;
    expect(grid).not.toBeNull();
    // Three wraps + the ghost, all siblings: nothing may sit in a sub-row of its
    // own, or the column-first flow would put it in the wrong place.
    const kids = Array.from(grid.children);
    expect(kids.length).toBe(4);
    expect(kids.slice(0, 3).every((k) => k.classList.contains('am-repocard-wrap'))).toBe(true);
    expect(kids[3].classList.contains('ghost')).toBe(true); // the ghost stays LAST in the flow
  });

  // jsdom has no layout, so the two-row rule itself can only be read off the
  // stylesheet — the same way the popover's "no transform" rule is asserted
  // below. A flex row here would pass every DOM assertion above and still ship
  // the one-row strip UAT threw out.
  it('the cards container is declared a two-row, column-flowing grid', () => {
    const src = readFileSync('webview/dashboard/components/RepoCards.svelte', 'utf8');
    const rule = /\.am-cards\s*\{([\s\S]*?)\}/.exec(src)?.[1] ?? '';
    expect(rule, '.am-cards rule not found').not.toBe('');
    expect(rule).toMatch(/display:\s*grid/);
    expect(rule).toMatch(/grid-template-rows:\s*repeat\(2,/);
    expect(rule).toMatch(/grid-auto-flow:\s*column/);
    expect(rule).not.toMatch(/display:\s*flex/);
  });

  it('a repo whose branch has not been resolved yet says "detached", never an empty line', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/x/alpha')]); // an older host: no groupId, no branch
    await tick();
    expect(card(container, 'alpha').querySelector('.am-repocard-branch')!.textContent).toBe('detached');
  });

  it('the first repo is selected by default; clicking another card swaps the board', async () => {
    const { container } = render(AgentManagerPane);
    amState([
      repo('/x/alpha', '', [mkRow({ id: 'a1', name: 'alpha-card', state: 'idle' })]),
      repo('/x/beta', '', [mkRow({ id: 'b1', name: 'beta-card', state: 'idle' })]),
    ]);
    await tick();
    expect(card(container, 'alpha').classList.contains('on')).toBe(true);
    expect(cardsIn(container, 'Done')[0].querySelector('.am-name')!.textContent).toBe('alpha-card');

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(card(container, 'beta'));
    await tick();
    expect(card(container, 'beta').classList.contains('on')).toBe(true);
    expect(cardsIn(container, 'Done')[0].querySelector('.am-name')!.textContent).toBe('beta-card');
    // Which repo you LOOK at is still view state — the only message a select
    // sends is the request for that card's worktree rows.
    expect(posts()).toEqual([{ type: 'amRepoWorktrees', root: '/x/beta' }]);
  });

  it('a missing repo is dimmed and offers unregister, and its board is not drawn', async () => {
    const { container } = render(AgentManagerPane);
    const gone = { ...repo('/x/gone'), missing: true };
    amState([gone]);
    await tick();
    expect(container.querySelector('.am-repocard-wrap.missing')).not.toBeNull();
    expect(container.querySelector('.am-scol')).toBeNull();
    expect(container.querySelector('.am-missing')!.textContent).toContain('missing');
    // ...and the detail pane lists no checkout it could not read — it says why.
    const detail = container.querySelector('.am-detail') as HTMLElement;
    expect(detail.querySelectorAll('.am-wtrow').length).toBe(0);
    expect(detail.textContent).toContain('folder missing from disk');
    await fireEvent.click(container.querySelector('.am-repocard-x')!);
    expect(posts()).toContainEqual({ type: 'amRemoveRepo', root: '/x/gone' });
  });

  // Cards carry NO rename pencil (round 4 added one; UAT round 5 removed it as
  // noise) — rename lives on the repo toolbar's pencil alone. The field FOCUSES on
  // open (an unfocused field strands the keyboard), Escape cancels without a post,
  // and the unmount's blur after Enter must not commit a second time or reopen it.
  it('rename is header-only; the field takes focus on open; Escape cancels; a blur after Enter is one commit', async () => {
    const { container } = render(AgentManagerPane);
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' }], { displayNames: { '/x/alpha': 'Alpha Board' } });
    await tick();
    expect(container.querySelector('.am-repocard-pencil'), 'no pencil on a card').toBeNull();
    const openRename = () => fireEvent.click(byTitle(container.querySelector('.am-repohead') as HTMLElement, 'Rename how this repo'));
    await openRename();
    await tick();
    let box = container.querySelector('.am-repo-rename') as HTMLInputElement;
    expect(box.value).toBe('Alpha Board'); // seeded with the board label, not the folder name
    expect(document.activeElement, 'the field owns the keyboard on open').toBe(box);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.keyDown(box, { key: 'Escape' });
    await tick();
    expect(container.querySelector('.am-repo-rename'), 'Escape closes').toBeNull();
    expect(posts().filter((p) => p.type === 'amRenameRepo'), 'Escape never posts').toEqual([]);
    await openRename();
    await tick();
    box = container.querySelector('.am-repo-rename') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: '  Alpha Prime  ' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await fireEvent.blur(box); // the unmounting input's blur — the double-commit trap
    await tick();
    expect(posts().filter((p) => p.type === 'amRenameRepo'))
      .toEqual([{ type: 'amRenameRepo', root: '/x/alpha', displayName: 'Alpha Prime' }]);
    expect(container.querySelector('.am-repo-rename'), 'and it stays closed').toBeNull();
  });

  it('the ghost card posts amAddRepo; an empty board explains itself', async () => {
    const { container } = render(AgentManagerPane);
    amState([]);
    await tick();
    expect(container.querySelector('.am-hub')!.textContent).toContain('No repositories');
    // ...and so does the detail pane, rather than standing there as an empty box.
    expect(container.querySelector('.am-detail')!.textContent).toContain('Pick a repository');
    await fireEvent.click(container.querySelector('.am-repocard.ghost')!);
    expect(posts()).toContainEqual({ type: 'amAddRepo' });
  });
});

// Selecting a card fills the top strip's DETAIL pane — 0.4.53 revealed the rows
// under the card itself, which is the design UAT round 2 threw out. The content
// is host truth (`git worktree list` + `for-each-ref` at the primary), so the
// pane asks for it and RepoDetail draws what comes back: the checkouts with
// their three actions, then the repository's branches, read-only.
describe('Folds board — the selected repo fills the detail pane', () => {
  const wt = (over: Partial<{ name: string; branch: string; path: string; primary: boolean; fold: boolean }> = {}) =>
    ({ name: 'main', branch: 'trunk', path: '/x/alpha', primary: true, fold: false, ...over });
  const detail = (c: HTMLElement) => c.querySelector('.am-detail') as HTMLElement;
  const rowsOf = (c: HTMLElement) => Array.from(detail(c).querySelectorAll('.am-wtrow')) as HTMLElement[];
  const branchesOf = (c: HTMLElement) => Array.from(detail(c).querySelectorAll('.am-brrow')) as HTMLElement[];
  // UAT round 4 replaced the two stacked sections with a toggle, so the branch list
  // is not on screen until you ask for it — every branch test flips it first.
  const views = (c: HTMLElement) => Array.from(detail(c).querySelectorAll('.am-viewbtn')) as HTMLButtonElement[];
  const showBranches = async (c: HTMLElement) => { await fireEvent.click(views(c)[1]); await tick(); };
  const sendWorktrees = (root: string, worktrees: unknown[], branches?: string[]) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: branches === undefined
        ? { type: 'amWorktrees', root, worktrees }        // an older host: no branches at all
        : { type: 'amWorktrees', root, worktrees, branches },
    }));
  };

  async function openBoard(): Promise<HTMLElement> {
    const { container } = render(AgentManagerPane);
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' }]);
    await tick();
    // The primary row is sent SECOND on purpose: the pane promises the checkout
    // that owns the work reads first, whatever order the reply arrives in.
    sendWorktrees('/x/alpha', [
      wt({ name: 'feature', branch: 'origami/feature', path: '/x/alpha/.origami/worktrees/feature', primary: false, fold: true }),
      wt(),
      wt({ name: 'spike', branch: '', path: '/x/spike', primary: false }),
    ], ['trunk', 'origami/feature', 'shelved']);
    await tick();
    return container;
  }

  it('asks the host for the rows of the repo it selected on the first broadcast', async () => {
    render(AgentManagerPane);
    amState([repo('/x/alpha')]);
    await tick();
    expect(posts()).toContainEqual({ type: 'amRepoWorktrees', root: '/x/alpha' });
    // ...and only ONCE: a poll-tick broadcast must not re-ask every five seconds.
    globalThis.__vscodeApiMock.postMessage.mockClear();
    amState([repo('/x/alpha')]);
    await tick();
    expect(posts().filter((p) => p.type === 'amRepoWorktrees')).toEqual([]);
  });

  it('heads with the repo and leads with the PRIMARY, then a row per checkout with its badges', async () => {
    const container = await openBoard();
    expect(detail(container).querySelector('.am-detail-head')!.textContent).toBe('alpha');
    const rows = rowsOf(container);
    expect(rows.map((r) => r.querySelector('.am-wtrow-name')!.textContent)).toEqual(['main', 'feature', 'spike']);
    expect(rows[0].querySelector('.am-wtbadge.primary')).not.toBeNull();
    expect(rows[1].querySelector('.am-wtbadge.fold')).not.toBeNull();
    expect(rows[1].querySelector('.am-wtbadge.primary')).toBeNull();
    // A detached checkout says so rather than showing an empty branch cell.
    expect(rows[2].querySelector('.am-wtrow-branch')!.textContent).toBe('detached');
  });

  // UAT round 3 gave each list a mini-header; round 4 asked what actually separates
  // them and answered it — two buttons in the pane's top right, ONE list at a time,
  // so each gets the pane's whole height instead of half of it.
  it('the two lists are a TOGGLE carrying their counts, Checkouts by default', async () => {
    const container = await openBoard();
    expect(detail(container).querySelector('.am-detail-sec'), 'the stacked sections are gone').toBeNull();
    const btns = views(container);
    expect(btns.map((b) => b.querySelector('.am-view-name')!.textContent)).toEqual(['Checkouts', 'Branches']);
    // The count you are NOT looking at still says how much is over there.
    expect(btns.map((b) => b.querySelector('.am-view-count')!.textContent)).toEqual(['3', '3']);
    expect(btns.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(rowsOf(container)).toHaveLength(3);
    expect(branchesOf(container), 'the other list is not drawn at all').toHaveLength(0);
    // Branches SWAPS the list over rather than adding a second one below it.
    await showBranches(container);
    expect(views(container).map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(branchesOf(container)).toHaveLength(3);
    expect(rowsOf(container)).toHaveLength(0);
    // The head still names the repository, beside the toggle rather than above it.
    expect(detail(container).querySelector('.am-detail-head')!.textContent).toBe('alpha');
  });

  // The row is a FIXED two lines, not a wrap: name + badges, then branch and the
  // actions. A wrapping row put those on three ragged lines at 262px, which is
  // what "disorganized" was pointing at.
  it('every checkout row is two lines: name + badges, then branch + its actions', async () => {
    const container = await openBoard();
    for (const row of rowsOf(container)) {
      const lines = Array.from(row.querySelectorAll('.am-wtline'));
      expect(lines.length).toBe(2);
      expect(lines[0].querySelector('.am-wtrow-name')).not.toBeNull();
      expect(lines[0].querySelector('.am-wtrow-branch')).toBeNull();      // never on line 1
      expect(lines[1].querySelector('.am-wtrow-branch')).not.toBeNull();
      expect(lines[1].querySelector('.am-wtrow-actions')).not.toBeNull(); // the cluster rides line 2
      expect(row.querySelectorAll('.am-wtrow-actions').length).toBe(1);   // ONE cluster, not three loose buttons
    }
    // The badges stay on line 1, beside the name they qualify.
    const rows = rowsOf(container);
    expect(rows[0].querySelectorAll('.am-wtline')[0].querySelector('.am-wtbadge.primary')).not.toBeNull();
    expect(rows[1].querySelectorAll('.am-wtline')[0].querySelector('.am-wtbadge.fold')).not.toBeNull();
  });

  // The cluster is REVEALED, not created, on hover. Every button must stay in the
  // DOM at rest or a keyboard user could never reach one — and the payloads must
  // be exactly what they were when the row lived under the card.
  it('all three actions are in the DOM with no hover, primary row included', async () => {
    const container = await openBoard();
    const rows = rowsOf(container);
    const labels = (r: HTMLElement) =>
      Array.from(r.querySelectorAll('.am-wtact')).map((b) => b.textContent!.trim());
    expect(labels(rows[0])).toEqual(['Terminal', 'Chat here']);            // already primary
    expect(labels(rows[1])).toEqual(['Terminal', 'Chat here', 'Make primary']);
    expect(labels(rows[2])).toEqual(['Terminal', 'Chat here', 'Make primary']);
    // ...and a row nobody is hovering still answers a click, exactly as before.
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(byText(rows[1], 'Terminal'));
    expect(posts()).toEqual([
      { type: 'amWorktreeTerminal', root: '/x/alpha', path: '/x/alpha/.origami/worktrees/feature' },
    ]);
  });

  // jsdom applies no component CSS, so the reveal rule is read off the source.
  // `visibility: hidden` or `display: none` would take the buttons out of the tab
  // order, and then :focus-within could never bring them back.
  it('the action cluster is hidden by OPACITY and revealed by hover AND focus', () => {
    const src = readFileSync('webview/dashboard/components/RepoCheckoutRow.svelte', 'utf8');
    const cluster = /\.am-wtrow-actions\s*\{([\s\S]*?)\}/.exec(src)?.[1] ?? '';
    expect(cluster, '.am-wtrow-actions rule not found').not.toBe('');
    expect(cluster).toMatch(/opacity:\s*0\b/);
    expect(cluster).not.toMatch(/visibility:\s*hidden/);
    expect(cluster).not.toMatch(/display:\s*none/);
    expect(src).toMatch(/\.am-wtrow:hover \.am-wtrow-actions/);
    expect(src).toMatch(/\.am-wtrow:focus-within \.am-wtrow-actions/);
    expect(src).toMatch(/\.am-wtrow\.is-primary \.am-wtrow-actions/); // the primary's stays on
  });

  // At this width a long name must ellipsize, and the only place the whole
  // string then survives is the tooltip.
  it('names and branches carry a title, so an ellipsis never loses the text', async () => {
    const container = await openBoard();
    const rows = rowsOf(container);
    expect(rows[1].querySelector('.am-wtrow-name')!.getAttribute('title'))
      .toBe('/x/alpha/.origami/worktrees/feature');
    expect(rows[1].querySelector('.am-wtrow-branch')!.getAttribute('title')).toBe('origami/feature');
    expect(detail(container).querySelector('.am-detail-head')!.getAttribute('title')).toBe('/x/alpha');
    await showBranches(container);
    expect(branchesOf(container)[0].querySelector('.am-brrow-name')!.getAttribute('title')).toBe('trunk');
  });

  it('each row opens a terminal and a chat AT ITS OWN PATH', async () => {
    const container = await openBoard();
    const row = rowsOf(container)[1];
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(byText(row, 'Terminal'));
    await fireEvent.click(byText(row, 'Chat here'));
    expect(posts()).toEqual([
      { type: 'amWorktreeTerminal', root: '/x/alpha', path: '/x/alpha/.origami/worktrees/feature' },
      { type: 'amWorktreeChat', root: '/x/alpha', path: '/x/alpha/.origami/worktrees/feature' },
    ]);
  });

  it('Make primary is offered on every row EXCEPT the one already primary, and drops the stale rows', async () => {
    const container = await openBoard();
    const rows = rowsOf(container);
    expect(rows[0].textContent).not.toContain('Make primary'); // it already is
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(byText(rows[2], 'Make primary'));
    expect(posts()).toContainEqual({ type: 'amMakePrimary', root: '/x/alpha', path: '/x/spike' });
    // The primary flag and the fold prefix both move, so the cached detail is
    // dropped and the next broadcast re-asks rather than drawing stale badges.
    await tick();
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/spike', branch: 'trunk' }]);
    await tick();
    expect(posts()).toContainEqual({ type: 'amRepoWorktrees', root: '/x/alpha' });
  });

  it('branches are READ-ONLY and say which checkout has one out', async () => {
    const container = await openBoard();
    await showBranches(container);
    const brs = branchesOf(container);
    expect(brs.map((b) => b.querySelector('.am-brrow-name')!.textContent))
      .toEqual(['trunk', 'origami/feature', 'shelved']);
    // A branch is not a place to act — every action belongs to a CHECKOUT.
    expect(brs.every((b) => b.querySelectorAll('button').length === 0)).toBe(true);
    // The mark is DERIVED from the rows, so it names the checkout, not the branch.
    expect(brs[0].querySelector('.am-brrow-at')!.textContent).toBe('in main');
    expect(brs[1].querySelector('.am-brrow-at')!.textContent).toBe('in feature');
    // ...and a branch nothing has out carries no mark at all.
    expect(brs[2].querySelector('.am-brrow-at')).toBeNull();
  });

  // The section asks ONE question — "is that work already open somewhere" — so
  // the branches that answer it yes come first, whatever order git listed them
  // in. The rest keep git's order rather than being re-sorted into a new one.
  it('branches that ARE checked out lead the list, the rest keep git order', async () => {
    const { container } = render(AgentManagerPane);
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' }]);
    await tick();
    sendWorktrees('/x/alpha', [wt(), wt({ name: 'spike', branch: 'wip', path: '/x/spike', primary: false })],
      ['alpha-old', 'wip', 'zeta', 'trunk']);
    await tick();
    await showBranches(container);
    expect(branchesOf(container).map((b) => b.querySelector('.am-brrow-name')!.textContent))
      .toEqual(['wip', 'trunk', 'alpha-old', 'zeta']);
    // The count on the toggle is the whole list, not just the checked-out head.
    expect(views(container)[1].querySelector('.am-view-count')!.textContent).toBe('4');
  });

  it('an older host that sends no branches still draws the checkouts, and the Branches view says why', async () => {
    const { container } = render(AgentManagerPane);
    amState([{ ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' }]);
    await tick();
    sendWorktrees('/x/alpha', [wt()]);
    await tick();
    expect(rowsOf(container)).toHaveLength(1);
    expect(branchesOf(container)).toHaveLength(0);
    // The toggle still offers Branches, reading 0 — and the view behind it explains
    // itself rather than standing there as an empty box.
    expect(views(container)[1].querySelector('.am-view-count')!.textContent).toBe('0');
    await showBranches(container);
    expect(branchesOf(container)).toHaveLength(0);
    expect(detail(container).textContent).toContain('No local branches read yet.');
  });

  it('there is ONE detail pane, and it follows the selection', async () => {
    const { container } = render(AgentManagerPane);
    amState([
      { ...repo('/x/alpha'), groupId: 'g1', primary: '/x/alpha', branch: 'trunk' },
      { ...repo('/x/beta'), groupId: 'g2', primary: '/x/beta', branch: 'main' },
    ]);
    await tick();
    sendWorktrees('/x/alpha', [wt()], ['trunk']);
    await tick();
    expect(container.querySelectorAll('.am-detail').length).toBe(1);
    expect(detail(container).querySelector('.am-detail-head')!.textContent).toBe('alpha');
    expect(rowsOf(container)).toHaveLength(1);
    // Selecting the other card swaps the pane over — and shows NOTHING of alpha's
    // while beta's own reply is still in flight.
    await showBranches(container);
    await fireEvent.click(card(container, 'beta'));
    await tick();
    expect(detail(container).querySelector('.am-detail-head')!.textContent).toBe('beta');
    // ...and a repository you have never toggled opens on Checkouts, whatever list
    // the one before it was left showing.
    expect(views(container)[0].getAttribute('aria-pressed')).toBe('true');
    expect(rowsOf(container)).toHaveLength(0);
    expect(branchesOf(container)).toHaveLength(0);
    expect(detail(container).textContent).toContain('Reading worktrees');
  });
});

// Contract §12.2: the form is gone until you ask for it. An always-open capture
// ate the top of the Triage block, so Triage now shows the same dashed ghost the
// repo bar uses for "+ Add repo", and the form lives behind it.
describe('Folds board — quick-add hides behind "+ Add ticket"', () => {
  const ghost = (c: HTMLElement) => column(c, 'Triage').querySelector('.am-qa-open') as HTMLButtonElement;
  const titleBox = (c: HTMLElement) => column(c, 'Triage').querySelector('.am-quickadd') as HTMLInputElement;
  const tasksBox = (c: HTMLElement) => column(c, 'Triage').querySelector('.am-qa-tasks') as HTMLTextAreaElement;
  const expand = async (c: HTMLElement) => { await fireEvent.click(ghost(c)); await tick(); };

  it('starts collapsed to a "+ Add ticket" row, and only in Triage', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    expect(ghost(container)).not.toBeNull();
    expect(ghost(container).textContent).toContain('Add ticket');
    expect(titleBox(container)).toBeNull();  // no form eating the column
    expect(tasksBox(container)).toBeNull();
    // A raw idea belongs in Triage; no other block offers the capture at all.
    for (const label of ['Todo', 'Pending', 'In progress', 'Blocked', 'Done']) {
      expect(column(container, label).querySelector('.am-qa-open')).toBeNull();
      expect(column(container, label).querySelector('.am-quickadd')).toBeNull();
    }
  });

  it('clicking it expands the title + tasks form with the title already focused', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await expand(container);
    expect(ghost(container)).toBeNull();     // the ghost gives way to the form
    expect(titleBox(container)).not.toBeNull();
    expect(tasksBox(container)).not.toBeNull();
    expect(document.activeElement).toBe(titleBox(container)); // type straight away
  });

  it('Enter in the title posts a title-only ticket (empty body) and collapses', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await expand(container);
    await fireEvent.input(titleBox(container), { target: { value: '  Scroll block needs a max-width  ' } });
    await fireEvent.keyDown(titleBox(container), { key: 'Enter' });
    await tick();
    expect(posts()).toContainEqual({
      type: 'amTicketQuickAdd', root: '/repo/a', title: 'Scroll block needs a max-width', body: '',
    });
    expect(titleBox(container)).toBeNull();
    expect(ghost(container)).not.toBeNull();
  });

  // Contract §11.2: the second field becomes the ticket BODY, so the tasks you
  // already had in your head never need a trip through the file to get written.
  it('the tasks box rides along as the body, and Add posts the same shape then collapses', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await expand(container);
    await fireEvent.input(titleBox(container), { target: { value: 'Cap the block' } });
    await fireEvent.input(tasksBox(container), { target: { value: 'measure it\nclamp it\n' } });
    await tick();
    await fireEvent.click(byText(column(container, 'Triage'), 'Add'));
    await tick();
    expect(posts()).toContainEqual({
      type: 'amTicketQuickAdd', root: '/repo/a', title: 'Cap the block', body: 'measure it\nclamp it',
    });
    expect(ghost(container)).not.toBeNull();
    // ...and nothing is carried over into the next capture.
    await expand(container);
    expect(titleBox(container).value).toBe('');
    expect(tasksBox(container).value).toBe('');
  });

  it('the tasks box grows from 2 rows to 4 and stops there', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await expand(container);
    expect(tasksBox(container).getAttribute('rows')).toBe('2');
    await fireEvent.input(tasksBox(container), { target: { value: 'a\nb\nc' } });
    await tick();
    expect(tasksBox(container).getAttribute('rows')).toBe('3');
    await fireEvent.input(tasksBox(container), { target: { value: 'a\nb\nc\nd\ne\nf' } });
    await tick();
    expect(tasksBox(container).getAttribute('rows')).toBe('4'); // then it scrolls
  });

  it('an empty or whitespace title posts nothing and does NOT collapse', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await expand(container);
    await fireEvent.keyDown(titleBox(container), { key: 'Enter' });
    await fireEvent.input(titleBox(container), { target: { value: '   ' } });
    await fireEvent.input(tasksBox(container), { target: { value: 'some tasks' } });
    await fireEvent.keyDown(titleBox(container), { key: 'Enter' });
    await tick();
    expect(posts().some((p) => p.type === 'amTicketQuickAdd')).toBe(false);
    expect((byText(column(container, 'Triage'), 'Add') as HTMLButtonElement).disabled).toBe(true);
    expect(titleBox(container)).not.toBeNull(); // a refused Enter must not eat the typing
  });

  it('Escape collapses the capture and drops what was in it, never reaching the board behind', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({ id: 'q', name: 'q', state: 'queued', queuedPrompt: 'task' })])]);
    await tick();
    await expand(container);
    await fireEvent.input(titleBox(container), { target: { value: 'half a thought' } });
    await fireEvent.input(tasksBox(container), { target: { value: 'and a task' } });
    await tick();
    await fireEvent.keyDown(titleBox(container), { key: 'Escape' });
    await tick();
    expect(ghost(container)).not.toBeNull();
    expect(posts().some((p) => p.type === 'amTicketQuickAdd')).toBe(false);
    // Reopening starts empty: the half-typed thought went with the form.
    await expand(container);
    expect(titleBox(container).value).toBe('');
    expect(tasksBox(container).value).toBe('');
  });

  // The form is bound to the repo it was opened in. Carrying a half-typed title
  // across a card click is how a ticket lands in the wrong board's Triage.
  it('collapses when you switch repo, and does not carry the typing across', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/x/alpha'), repo('/x/beta')]);
    await tick();
    await expand(container);
    await fireEvent.input(titleBox(container), { target: { value: 'meant for alpha' } });
    await tick();
    await fireEvent.click(card(container, 'beta'));
    await tick();
    expect(titleBox(container)).toBeNull();
    expect(ghost(container)).not.toBeNull();
    await expand(container);
    expect(titleBox(container).value).toBe('');
    await fireEvent.input(titleBox(container), { target: { value: 'meant for beta' } });
    await fireEvent.keyDown(titleBox(container), { key: 'Enter' });
    await tick();
    expect(posts()).toContainEqual({
      type: 'amTicketQuickAdd', root: '/x/beta', title: 'meant for beta', body: '',
    });
  });

  it('the n key expands it, and typing n inside a box stays typing', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    await fireEvent.keyDown(window, { key: 'n' });
    await tick();
    expect(document.activeElement).toBe(titleBox(container));

    await fireEvent.keyDown(titleBox(container), { key: 'Escape' });
    await tick();
    const filter = container.querySelector('.am-cardfilter') as HTMLInputElement;
    filter.focus();
    await fireEvent.keyDown(filter, { key: 'n' });
    await tick();
    expect(titleBox(container)).toBeNull(); // the board shortcut never fired
    expect(document.activeElement).toBe(filter);
  });
});

describe('Folds board — the ticket card and its launch popover', () => {
  const todoRepo = () => repo('/repo/a', '', [], [mkTicket({
    id: 't-8k2fq1', title: 'Scroll block needs a max-width', status: 'todo',
    priority: 'high', labels: ['ui'], assignee: 'heron', acceptance: { done: 1, total: 3 },
  })]);

  it('a Todo ticket shows the Hermes anatomy: id chip, priority, labels, title, assignee, acceptance', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    const card = ticketsIn(container, 'Todo')[0];
    expect(card.querySelector('.am-tk-id')!.textContent).toBe('T-8K2FQ1');
    expect(card.querySelector('.am-tk-pri')!.textContent!.trim()).toBe('high');
    expect(card.querySelector('.am-tk-pri')!.classList.contains('high')).toBe(true);
    expect(Array.from(card.querySelectorAll('.am-tk-label')).map((l) => l.textContent)).toEqual(['ui']);
    expect(card.querySelector('.am-tk-title')!.textContent).toBe('Scroll block needs a max-width');
    expect(card.querySelector('.am-tk-assignee')!.textContent).toBe('@heron');
    expect(card.querySelector('.am-tk-acc')!.textContent).toContain('1/3');
  });

  it('✎ posts amTicketOpen, ✕ posts amTicketClose, and only Todo carries the launch action', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [
      mkTicket({ id: 't-raw', status: 'triage' }),
      mkTicket({ id: 't-spec', status: 'todo' }),
    ])]);
    await tick();
    const raw = ticketsIn(container, 'Triage')[0];
    const spec = ticketsIn(container, 'Todo')[0];
    expect(raw.querySelector('.am-tk-btn.go')).toBeNull();       // unspec'd — nothing to launch
    expect(spec.querySelector('.am-tk-btn.go')).not.toBeNull();
    // ...and the mirror image: Spec belongs to the unspec'd card only.
    expect(raw.querySelector('.am-tk-btn.spec')).not.toBeNull();
    expect(spec.querySelector('.am-tk-btn.spec')).toBeNull();

    await fireEvent.click(byTitle(raw, 'Open the ticket file'));
    await fireEvent.click(byTitle(raw, 'Close this ticket'));
    expect(posts()).toContainEqual({ type: 'amTicketOpen', root: '/repo/a', id: 't-raw' });
    expect(posts()).toContainEqual({ type: 'amTicketClose', root: '/repo/a', id: 't-raw' });
  });

  it('launch opens the popover; Start posts amTicketLaunch carrying the ticket id', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    expect(container.querySelector('.am-launch')).toBeNull();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    const popover = container.querySelector('.am-launch') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain('T-8K2FQ1'); // it says which ticket it will launch

    await fireEvent.click(byText(popover, 'Start'));
    await tick();
    const launch = posts().find((p) => p.type === 'amTicketLaunch')!;
    expect(launch).toEqual({
      type: 'amTicketLaunch', root: '/repo/a', id: 't-8k2fq1',
      agentName: 'tsuru', model: '', start: true,
    });
    expect(container.querySelector('.am-launch')).toBeNull(); // closes on submit
  });

  it('Queue posts the same payload with start:false', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    await fireEvent.click(byText(container.querySelector('.am-launch')!, 'Queue'));
    await tick();
    const launch = posts().find((p) => p.type === 'amTicketLaunch')!;
    expect(launch.start).toBe(false);
    expect(launch.id).toBe('t-8k2fq1');
  });

  // UAT round 1 read the race feature as REMOVED, so the toggle's presence is
  // now asserted outright: a labelled checkbox on the popover itself, not a
  // control you have to already know is there.
  it('the Race toggle is visible and labelled the moment the popover opens', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    const row = container.querySelector('.am-launch .am-race') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('Race');
    const box = row.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(container.querySelector('.am-variant-row')).toBeNull(); // off until you ask
  });

  it('the dedupe hint clears once two rows actually differ', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()], { agentTypes: [{ id: 'tsuru', name: 'tsuru' }, { id: 'ask', name: 'ask' }] });
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    const rows = () => Array.from(container.querySelectorAll('.am-variant-row'));
    await fireEvent.click(container.querySelector('.am-race input[type=checkbox]')!);
    await tick();
    expect(container.querySelector('.am-race-dupe')).not.toBeNull(); // two blanks = one model

    // Give row 2 a different agent: the pair is now unique, so the warning goes.
    await fireEvent.click(rows()[1].querySelector('.am-agenttype')!);
    await tick();
    await fireEvent.click(container.querySelector('.am-agenttype-option[data-value="ask"]')!);
    await tick();
    expect(container.querySelector('.am-race-dupe')).toBeNull();
  });

  it('Race fans the SAME ticket across variants — 2 rows, up to 4, one variants payload', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    const popover = () => container.querySelector('.am-launch') as HTMLElement;
    await fireEvent.click(popover().querySelector('.am-race input[type=checkbox]')!);
    await tick();
    // Two blank rows resolve to the SAME model, which fanout.ts collapses — say
    // so here rather than letting Start come back as an error banner.
    expect(popover().querySelector('.am-race-dupe')!.textContent).toContain('collapse');
    expect(popover().querySelectorAll('.am-variant-row').length).toBe(2);
    await fireEvent.click(popover().querySelector('.am-add-variant')!);
    await tick();
    await fireEvent.click(popover().querySelector('.am-add-variant')!);
    await tick();
    expect(popover().querySelectorAll('.am-variant-row').length).toBe(4);
    expect(popover().querySelector('.am-add-variant')).toBeNull(); // capped at 4

    await fireEvent.click(byText(popover(), 'Start'));
    await tick();
    const launch = posts().find((p) => p.type === 'amTicketLaunch')!;
    expect(launch.id).toBe('t-8k2fq1');
    expect(launch.variants).toEqual([
      { agentName: 'tsuru', model: '' }, { agentName: 'tsuru', model: '' },
      { agentName: 'tsuru', model: '' }, { agentName: 'tsuru', model: '' },
    ]);
    expect(launch.model).toBeUndefined(); // no top-level model in a race
  });

  it('the popover closes when the ticket it was opened for gets launched under it', async () => {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    expect(container.querySelector('.am-launch')).not.toBeNull();
    // The host stamped it: the ticket now carries a fold, so there is nothing to launch.
    amState([repo('/repo/a', '', [mkRow({ id: 'w1', state: 'working', ticketId: 't-8k2fq1' })],
      [mkTicket({ id: 't-8k2fq1', status: 'in_progress', fold: 'w1' })])]);
    await tick();
    expect(container.querySelector('.am-launch')).toBeNull();
  });
});

// Contract §12.1. The popover used to centre itself with
// `top/left: 50%; transform: translate(-50%,-50%)`, and a transform on an
// element makes its DESCENDANTS' `position: fixed` resolve against that element
// instead of the viewport — which is why the model menu inside it landed in a
// far corner of the screen. So the rule under test is two-part: the box is
// placed from the opening card's rect, and it carries no transform at all.
describe('Folds board — the popover is ANCHORED to the card, never centred', () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  const todoRepo = () => repo('/repo/a', '', [], [mkTicket({ id: 't-8k2fq1', title: 'anchor me', status: 'todo' })]);
  // Open the launch popover with a known card rect and a known popover size.
  async function openAt(card: Partial<typeof ZERO>, box: Partial<typeof ZERO> = { width: 380, height: 220 }) {
    const { container } = render(AgentManagerPane);
    amState([todoRepo()]);
    await tick();
    restore = fakeRects({ '.am-ticket': card, '.am-launch': box });
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    await tick();
    return { container, popover: container.querySelector('.am-launch') as HTMLElement };
  }

  it('sits just below the card it was opened from, with NO transform on the box', async () => {
    const { popover } = await openAt({ top: 100, bottom: 140, left: 60, width: 200, height: 40 });
    expect(popover.style.top).toBe('146px');   // card bottom + the 6px connector
    expect(popover.style.left).toBe('60px');   // card left edge
    expect(popover.style.transform).toBe('');
    // ...and no ANCESTOR carries one either: a transform anywhere above the box
    // hijacks the model menu's `position: fixed` just as badly.
    for (let n = popover.parentElement; n; n = n.parentElement) expect(n.style.transform).toBe('');
  });

  // The inline style above cannot see a `transform` written in the component's
  // own stylesheet (vitest does not apply component CSS), and the stylesheet is
  // exactly where the centring lived. So this reads the source.
  it('the component stylesheet declares no transform for the popover box', () => {
    // Relative to the vitest root (packages/vscode). `import.meta.url` is NOT a
    // file: URL in a suite vite transforms for the .svelte imports above.
    const src = readFileSync('webview/dashboard/components/LaunchPopover.svelte', 'utf8');
    expect(src).not.toMatch(/transform\s*:/);
    expect(src).not.toMatch(/\.am-launch\s*\{[^}]*top:\s*50%/);
  });

  it('flips above the card when hanging below would run off the bottom', async () => {
    const { popover } = await openAt({ top: 700, bottom: 740, left: 60 }, { width: 380, height: 220 });
    // 740 + 6 + 220 = 966 > the 768-high viewport, so it goes above: 700 - 6 - 220.
    expect(popover.style.top).toBe('474px');
  });

  it('a box too tall for either side is pinned inside the viewport, never off the top', async () => {
    const { popover } = await openAt({ top: 40, bottom: 80, left: 60 }, { width: 380, height: 900 });
    expect(popover.style.top).toBe('6px');
  });

  it('clamps to the viewport when the card sits at either edge', async () => {
    const far = await openAt({ top: 100, bottom: 140, left: 900 }, { width: 380, height: 220 });
    expect(far.popover.style.left).toBe('638px'); // 1024 - 380 - 6, not off the right
    far.container.remove();
    restore?.(); restore = null;
    cleanup();

    const off = await openAt({ top: 100, bottom: 140, left: -50 }, { width: 380, height: 220 });
    expect(off.popover.style.left).toBe('6px');
  });

  it('the spec picker anchors off ITS card the same way', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [mkTicket({ id: 't-raw1', status: 'triage' })])]);
    await tick();
    restore = fakeRects({ '.am-ticket': { top: 210, bottom: 250, left: 12 }, '.am-launch': { width: 380, height: 100 } });
    await fireEvent.click(ticketsIn(container, 'Triage')[0].querySelector('.am-tk-btn.spec')!);
    await tick();
    await tick();
    const popover = container.querySelector('.am-launch') as HTMLElement;
    expect(popover.style.top).toBe('256px');
    expect(popover.style.left).toBe('12px');
    expect(popover.style.transform).toBe('');
  });

  // The anchor is a snapshot of where the card WAS. Scrolling the block slides
  // the card out from under it, so the popover closes rather than hovering over
  // whatever moved into that spot. The listener is on the window in CAPTURE
  // phase — a scroll inside a block's own body never bubbles that far.
  it('closes when the block underneath it scrolls', async () => {
    const { container, popover } = await openAt({ top: 100, bottom: 140, left: 60 });
    expect(popover).not.toBeNull();
    column(container, 'Todo').querySelector('.am-scol-body')!
      .dispatchEvent(new Event('scroll', { bubbles: false }));
    await tick();
    expect(container.querySelector('.am-launch')).toBeNull();
  });
});

// Contract §11.3, webview half: Triage -> a chat that writes the acceptance.
// Same picker as launch, two questions, one button — and NO worktree wording,
// because nothing is provisioned until the ticket reaches Todo.
describe('Folds board — the Spec action', () => {
  const rawRepo = (over: Partial<TicketFixture> = {}) =>
    repo('/repo/a', '', [], [mkTicket({ id: 't-raw1', title: 'something vague', status: 'triage', ...over })]);
  const openSpec = async (c: HTMLElement) => {
    await fireEvent.click(ticketsIn(c, 'Triage')[0].querySelector('.am-tk-btn.spec')!);
    await tick();
  };

  it('opens the picker in spec mode: agent + model only — no Race, no Queue', async () => {
    const { container } = render(AgentManagerPane);
    amState([rawRepo()]);
    await tick();
    await openSpec(container);
    const popover = container.querySelector('.am-launch') as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.textContent).toContain('T-RAW1');
    expect(popover.querySelector('.am-race')).toBeNull();     // a spec is one chat, never a race
    expect(() => byText(popover, 'Queue')).toThrow();         // and nothing to queue
    expect(byText(popover, 'Spec in chat')).not.toBeNull();
  });

  it('Spec in chat posts amTicketSpec with the chosen agent and model, then closes', async () => {
    const { container } = render(AgentManagerPane);
    amState([rawRepo()]);
    await tick();
    await openSpec(container);
    await fireEvent.click(byText(container.querySelector('.am-launch')!, 'Spec in chat'));
    await tick();
    expect(posts()).toContainEqual({
      type: 'amTicketSpec', root: '/repo/a', id: 't-raw1', agentName: 'tsuru', model: '',
    });
    expect(posts().some((p) => p.type === 'amTicketLaunch')).toBe(false); // never a fold
    expect(container.querySelector('.am-launch')).toBeNull();
  });

  it('a ticket already being spec\'d shows the pulsing chip and cannot be spec\'d twice', async () => {
    const { container } = render(AgentManagerPane);
    amState([rawRepo({ spec: true })]);
    await tick();
    const card = ticketsIn(container, 'Triage')[0];
    expect(card.querySelector('.am-tk-spec')!.textContent).toContain('speccing');
    expect((card.querySelector('.am-tk-btn.spec') as HTMLButtonElement).disabled).toBe(true);
  });

  // `spec` is lane G's field: an older host sends a ticket without it, and an
  // undefined must read as "no spec session", never as one stuck open.
  it('a ticket with NO spec field at all is not speccing', async () => {
    const { container } = render(AgentManagerPane);
    const legacy = mkTicket({ id: 't-old1', status: 'triage' }) as Partial<TicketFixture>;
    delete legacy.spec;
    amState([repo('/repo/a', '', [], [legacy as TicketFixture])]);
    await tick();
    const card = ticketsIn(container, 'Triage')[0];
    expect(card.querySelector('.am-tk-spec')).toBeNull();
    expect((card.querySelector('.am-tk-btn.spec') as HTMLButtonElement).disabled).toBe(false);
  });
});

// Contract §11.4: drag a spec'd ticket onto Pending to queue it. The card hands
// over a bare id; the BOARD owns the rule for what that id may do.
describe('Folds board — drag a Todo ticket onto Pending', () => {
  const mixed = () => repo('/repo/a', '', [], [
    mkTicket({ id: 't-spec1', title: 'ready to go', status: 'todo', acceptance: { done: 0, total: 2 } }),
    mkTicket({ id: 't-raw1', title: 'still vague', status: 'triage' }),
  ]);

  it('only a Todo card is draggable, and it carries its own id', async () => {
    const { container } = render(AgentManagerPane);
    amState([mixed()]);
    await tick();
    const todo = ticketsIn(container, 'Todo')[0];
    expect(todo.getAttribute('draggable')).toBe('true');
    expect(ticketsIn(container, 'Triage')[0].getAttribute('draggable')).toBe('false');

    const data = dt();
    await fireEvent.dragStart(todo, { dataTransfer: data });
    expect(data.getData('text/plain')).toBe('t-spec1');
  });

  it('the Pending block highlights while a ticket is over it, and drops it as a QUEUED launch', async () => {
    const { container } = render(AgentManagerPane);
    amState([mixed()]);
    await tick();
    const pending = column(container, 'Pending');
    expect(pending.classList.contains('dragover')).toBe(false);

    const data = dt();
    await fireEvent.dragStart(ticketsIn(container, 'Todo')[0], { dataTransfer: data });
    await fireEvent.dragOver(pending, { dataTransfer: data });
    await tick();
    expect(pending.classList.contains('dragover')).toBe(true); // an invisible target reads as broken

    await fireEvent.drop(pending, { dataTransfer: data });
    await tick();
    expect(posts()).toContainEqual({
      type: 'amTicketLaunch', root: '/repo/a', id: 't-spec1', agentName: '', model: '', start: false,
    });
    expect(pending.classList.contains('dragover')).toBe(false); // highlight lifts on drop
  });

  it('leaving the block without dropping lifts the highlight and posts nothing', async () => {
    const { container } = render(AgentManagerPane);
    amState([mixed()]);
    await tick();
    const pending = column(container, 'Pending');
    await fireEvent.dragOver(pending, { dataTransfer: dt() });
    await tick();
    expect(pending.classList.contains('dragover')).toBe(true);
    await fireEvent.dragLeave(pending);
    await tick();
    expect(pending.classList.contains('dragover')).toBe(false);
    expect(posts().some((p) => p.type === 'amTicketLaunch')).toBe(false);
  });

  // The payload is a bare string, so the drop must not be trusted: only a
  // spec'd, unlaunched ticket of the repo on screen may be queued.
  it('a drop that is not a launchable ticket of this repo is a no-op', async () => {
    const { container } = render(AgentManagerPane);
    amState([mixed()]);
    await tick();
    const pending = column(container, 'Pending');
    for (const payload of ['t-raw1', 't-nosuch', '', 'C:\\some\\dragged\\file.txt']) {
      const data = dt();
      data.setData('text/plain', payload);
      await fireEvent.drop(pending, { dataTransfer: data });
    }
    await tick();
    expect(posts().some((p) => p.type === 'amTicketLaunch')).toBe(false);
  });

  it('only Pending accepts a drop — Todo and Done do not', async () => {
    const { container } = render(AgentManagerPane);
    amState([mixed()]);
    await tick();
    for (const label of ['Todo', 'Done', 'Blocked']) {
      const data = dt();
      data.setData('text/plain', 't-spec1');
      const block = column(container, label);
      await fireEvent.dragOver(block, { dataTransfer: data });
      await fireEvent.drop(block, { dataTransfer: data });
      await tick();
      expect(block.classList.contains('dragover')).toBe(false);
    }
    expect(posts().some((p) => p.type === 'amTicketLaunch')).toBe(false);
  });
});

describe('Folds board — the fold card', () => {
  it('headlines the ticket title, else the queued task\'s first line, else the worktree name', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'a', name: 'wt-a', state: 'queued', queuedPrompt: 'first line\nsecond line', ticketTitle: 'The ticket wins' }),
      mkRow({ id: 'b', name: 'wt-b', state: 'queued', queuedPrompt: 'first line\nsecond line' }),
      mkRow({ id: 'c', name: 'wt-c', state: 'queued', queuedPrompt: '' }),
    ])]);
    await tick();
    const names = cardsIn(container, 'Pending').map((c) => c.querySelector('.am-name')!.textContent);
    expect(names).toEqual(['The ticket wins', 'first line', 'wt-c']);
  });

  it('shows a live activity line only while working, and only when there is one', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'w', name: 'busy', state: 'working', hasSession: true, activity: 'Reading src/tool/board.ts' }),
      mkRow({ id: 'w2', name: 'quiet', state: 'working', hasSession: true, activity: '' }),
      mkRow({ id: 'i', name: 'done', state: 'idle', activity: 'stale line from before' }),
    ])]);
    await tick();
    const doing = cardsIn(container, 'In progress');
    expect(doing[0].querySelector('.am-activity')!.textContent).toBe('Reading src/tool/board.ts');
    expect(doing[1].querySelector('.am-activity')).toBeNull();
    expect(cardsIn(container, 'Done')[0].querySelector('.am-activity')).toBeNull();
  });

  it('line2 carries at most three chips; the rest moves into its tooltip', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({
      id: 'r1', name: 'x', state: 'error', errorDetail: 'boom', branch: 'origami/t-1-x',
      agentName: 'tsuru', model: 'lmstudio/qwen', groupId: 'g1', setupNote: 'npm install failed',
      needsYou: { kind: 'question', preview: 'which file?' },
    })])]);
    await tick();
    const line2 = cardsIn(container, 'Blocked')[0].querySelector('.am-line2') as HTMLElement;
    expect(line2.children.length).toBe(3); // agent · model · state/elapsed
    const tip = line2.getAttribute('title') ?? '';
    expect(tip).toContain('origami/t-1-x');   // branch
    expect(tip).toContain('which file?');     // the pending question
    expect(tip).toContain('race');            // race membership
    expect(tip).toContain('npm install failed');
  });

  it('the rail keeps two actions; the rest are worded overflow entries, and prune confirms first', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({ id: 'r1', name: 'done', state: 'idle', adds: 3 })])]);
    await tick();
    const card = cardsIn(container, 'Done')[0];
    expect(card.querySelectorAll('.am-rail-btn').length).toBe(2); // Chat + Merge
    await fireEvent.click(card.querySelector('.am-of-btn')!);
    await tick();
    const entries = Array.from(card.querySelectorAll('.am-of-item')).map((i) => i.textContent!.trim());
    expect(entries).toEqual([
      'Delete — remove the worktree, keep the branch',
      'Prune — remove the worktree AND the branch',
    ]);

    // First click on prune ARMS it and sends nothing; the second click sends.
    const prune = () => Array.from(card.querySelectorAll('.am-of-item'))
      .find((i) => (i.textContent ?? '').includes('Prune') || (i.textContent ?? '').includes('for real'))!;
    await fireEvent.click(prune());
    await tick();
    expect(posts().some((p) => p.type === 'amDelete')).toBe(false);
    expect(prune().textContent).toContain('for real');
    await fireEvent.click(prune());
    await tick();
    expect(posts()).toContainEqual({ type: 'amDelete', root: '/repo/a', id: 'r1', deleteBranch: true });
  });

  // The menu stays open while poll-tick broadcasts keep arriving, and a row that
  // changes state changes its entries. A positional memory of "which entry is
  // armed" would fire whatever action slid into that slot.
  it('an armed prune does NOT survive the entries changing under it', async () => {
    const { container } = render(AgentManagerPane);
    const errored = (queuedPrompt: string) => repo('/repo/a', '', [
      mkRow({ id: 'r1', name: 'x', state: 'error', errorDetail: 'died', adds: 1, queuedPrompt }),
    ]);
    amState([errored('')]); // menu: [Delete, Prune] — prune is entry 2 of 2
    await tick();
    const menu = () => cardsIn(container, 'Blocked')[0];
    const clickPrune = (scope: Element) => fireEvent.click(Array.from(scope.querySelectorAll('.am-of-item'))
      .find((i) => (i.textContent ?? '').includes('Prune') || (i.textContent ?? '').includes('for real'))!);
    await fireEvent.click(menu().querySelector('.am-of-btn')!);
    await tick();
    expect(menu().querySelectorAll('.am-of-item').length).toBe(2);
    await clickPrune(menu());
    await tick();

    // The card stays in Blocked (still errored) so the OPEN menu is the same
    // component — but the row now carries a queued task, so Retry appears and
    // every entry shifts down. The arm must follow the ENTRY, not the slot.
    amState([errored('run me')]);
    await tick();
    expect(menu().querySelectorAll('.am-of-item').length).toBe(3); // [Retry, Delete, Prune]
    const armedEntries = Array.from(menu().querySelectorAll('.am-of-item.confirming'))
      .map((i) => i.textContent!.trim());
    expect(armedEntries).toEqual(['Prune for real? the work is gone']); // NOT Delete, which slid into the old slot
    // Clicking anything else still sends nothing on its own account.
    expect(posts().some((p) => p.type === 'amDelete' || p.type === 'amStart')).toBe(false);
    // ...and the deliberate second click on the entry you armed still prunes.
    await clickPrune(menu());
    await tick();
    expect(posts()).toContainEqual({ type: 'amDelete', root: '/repo/a', id: 'r1', deleteBranch: true });
  });

  it('a queued card offers Start + Edit on the rail, and an errored one offers Retry in the menu', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'q', name: 'q', state: 'queued', queuedPrompt: 'do' }),
      mkRow({ id: 'e', name: 'e', state: 'error', errorDetail: 'pin failed', queuedPrompt: 'run me' }),
    ])]);
    await tick();
    const queued = cardsIn(container, 'Pending')[0];
    await fireEvent.click(byTitle(queued, 'Run this task now'));
    expect(posts()).toContainEqual({ type: 'amStart', root: '/repo/a', id: 'q' });

    const errored = cardsIn(container, 'Blocked')[0];
    await fireEvent.click(errored.querySelector('.am-of-btn')!);
    await tick();
    expect(Array.from(errored.querySelectorAll('.am-of-item')).map((i) => i.textContent!.trim()))
      .toContain('Retry — run the queued task');
  });

  it('Run all appears in Pending only, and posts amStartAll', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'q1', state: 'queued', queuedPrompt: 'a' }),
      mkRow({ id: 'q2', state: 'queued', queuedPrompt: 'b' }),
    ])]);
    await tick();
    expect(column(container, 'Todo').querySelector('.am-runall')).toBeNull();
    const runall = column(container, 'Pending').querySelector('.am-runall') as HTMLButtonElement;
    expect(runall.textContent).toContain('2');
    await fireEvent.click(runall);
    expect(posts()).toContainEqual({ type: 'amStartAll', root: '/repo/a' });
  });
});

describe('Folds board — race clustering survives the transposition', () => {
  it('siblings in one column cluster under a race header; a sibling elsewhere does not split it', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'a1', name: 'race-1', state: 'idle', adds: 1, groupId: 'g1' }),
      mkRow({ id: 'a2', name: 'race-2', state: 'idle', adds: 2, groupId: 'g1' }),
      mkRow({ id: 'a3', name: 'race-3', state: 'working', hasSession: true, groupId: 'g1' }),
      mkRow({ id: 'solo', name: 'solo', state: 'idle' }),
    ])]);
    await tick();
    const heads = Array.from(column(container, 'Done').querySelectorAll('.am-group-head'));
    expect(heads.length).toBe(1);
    expect(heads[0].textContent).toContain('2'); // the two siblings in THIS column
    expect(cardsIn(container, 'Done').length).toBe(3); // 2 siblings + solo
    // The lone sibling in In progress is an ordinary card, not a one-member race.
    expect(column(container, 'In progress').querySelector('.am-group-head')).toBeNull();
  });

  it('Prune rest discards only the losing siblings, across columns', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'win', name: 'race-1', state: 'idle', adds: 3, mergedAt: Date.now(), groupId: 'g1' }),
      mkRow({ id: 'lose2', name: 'race-2', state: 'idle', adds: 2, groupId: 'g1' }),
      mkRow({ id: 'lose3', name: 'race-3', state: 'idle', adds: 1, groupId: 'g1' }),
    ])]);
    await tick();
    await fireEvent.click(column(container, 'Done').querySelector('.am-group-prune')!);
    const deletes = posts().filter((p) => p.type === 'amDelete');
    expect(deletes.map((d) => d.id).sort()).toEqual(['lose2', 'lose3']);
    expect(deletes.every((d) => d.deleteBranch === true)).toBe(true);
    expect(deletes.some((d) => d.id === 'win')).toBe(false); // the merged winner is kept
  });
});

describe('Folds board — the card filter', () => {
  it('narrows fold cards AND ticket cards, and every column count follows', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [
      mkRow({ id: 'r1', name: 'login-fix', state: 'queued', queuedPrompt: 'repair the redirect' }),
      mkRow({ id: 'r2', name: 'other', state: 'queued', queuedPrompt: 'something else' }),
    ], [
      mkTicket({ id: 't-1', title: 'login loops forever', status: 'triage' }),
      mkTicket({ id: 't-2', title: 'unrelated', status: 'triage' }),
    ])]);
    await tick();
    expect(count(container, 'Pending')).toBe('2');
    expect(count(container, 'Triage')).toBe('2');

    await fireEvent.input(container.querySelector('.am-cardfilter')!, { target: { value: 'login' } });
    await tick();
    expect(count(container, 'Pending')).toBe('1');
    expect(count(container, 'Triage')).toBe('1');
    // Matched on the worktree NAME, though the card headlines its task.
    expect(cardsIn(container, 'Pending')[0].querySelector('.am-name')!.textContent).toBe('repair the redirect');
    expect(ticketsIn(container, 'Triage')[0].textContent).toContain('login loops forever');
  });

  it('the filter is per repo and survives an amState refresh', async () => {
    const { container } = render(AgentManagerPane);
    const rows = [mkRow({ id: 'r1', name: 'keep', state: 'queued', queuedPrompt: 'a' }), mkRow({ id: 'r2', name: 'drop', state: 'queued', queuedPrompt: 'b' })];
    amState([repo('/x/alpha', '', rows), repo('/x/beta', '', rows)]);
    await tick();
    await fireEvent.input(container.querySelector('.am-cardfilter')!, { target: { value: 'keep' } });
    await tick();
    expect(count(container, 'Pending')).toBe('1');

    amState([repo('/x/alpha', '', rows), repo('/x/beta', '', rows)]); // a poll tick must not reset it
    await tick();
    expect(count(container, 'Pending')).toBe('1');

    await fireEvent.click(card(container, 'beta')); // ...and it does not follow you to another repo
    await tick();
    expect(count(container, 'Pending')).toBe('2');
    expect((container.querySelector('.am-cardfilter') as HTMLInputElement).value).toBe('');
  });
});

describe('Folds board — view state persists through the webview state API', () => {
  it('picking a repo writes it under origami.folds.view and a fresh mount reads it back', async () => {
    const { container, unmount } = render(AgentManagerPane);
    amState([repo('/x/alpha'), repo('/x/beta')]);
    await tick();
    await fireEvent.click(card(container, 'beta'));
    await tick();
    const saved = globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0];
    expect(saved).toMatchObject({ 'origami.folds.view': { selectedRepo: '/x/beta' } });
    unmount();

    globalThis.__vscodeApiMock.getState.mockReturnValue(saved);
    const { container: again } = render(AgentManagerPane);
    amState([repo('/x/alpha'), repo('/x/beta')]);
    await tick();
    expect(card(again, 'beta').classList.contains('on')).toBe(true);
    expect(card(again, 'alpha').classList.contains('on')).toBe(false);
  });

  it('a saved repo that is no longer registered falls back to the first card, not a blank board', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.folds.view': { selectedRepo: '/x/unregistered' } });
    const { container } = render(AgentManagerPane);
    amState([repo('/x/alpha')]);
    await tick();
    expect(card(container, 'alpha').classList.contains('on')).toBe(true);
    expect(container.querySelectorAll('.am-scol').length).toBe(6);
    expect(globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0])
      .toMatchObject({ 'origami.folds.view': { selectedRepo: '/x/alpha' } });
  });

  it('an empty board never overwrites a saved pick', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'origami.folds.view': { selectedRepo: '/x/alpha' } });
    render(AgentManagerPane);
    amState([]);
    await tick();
    expect(globalThis.__vscodeApiMock.setState).not.toHaveBeenCalled();
  });
});

describe('Folds board — keyboard shortcuts', () => {
  // 'n' is covered with the capture it opens (quick-add, above); this holds the
  // OTHER half of the rule — a single-letter shortcut must never fire while you
  // are typing into a box.
  it('/ focuses the card filter, and does not fire while you are typing', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a')]);
    await tick();
    const filter = container.querySelector('.am-cardfilter') as HTMLInputElement;

    await fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(filter);

    // Typing '/' INSIDE the filter must land in the filter, not re-fire the jump.
    await fireEvent.input(filter, { target: { value: 'lo' } });
    await fireEvent.keyDown(filter, { key: '/' });
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe('lo');
  });

  it('Escape closes the launch popover, then the inline editor', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({ id: 'q', name: 'q', state: 'queued', queuedPrompt: 'task' })],
      [mkTicket({ id: 't-1', status: 'todo' })])]);
    await tick();
    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    expect(container.querySelector('.am-launch')).not.toBeNull();
    // While it is open the board shortcuts are dead — no capture opening behind it.
    await fireEvent.keyDown(window, { key: 'n' });
    await tick();
    expect(container.querySelector('.am-quickadd')).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(container.querySelector('.am-launch')).toBeNull();

    await fireEvent.click(byTitle(cardsIn(container, 'Pending')[0], 'Edit the queued task'));
    await tick();
    expect(container.querySelector('.am-editor')).not.toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(container.querySelector('.am-editor')).toBeNull();
  });
});

describe('Folds board — the single-editor invariant survives the rewrite', () => {
  const openEditor = async (container: HTMLElement) => {
    await fireEvent.click(byTitle(cardsIn(container, 'Pending')[0], 'Edit the queued task'));
    await tick();
  };

  it('Save posts only the changed fields and waits for the host to confirm', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({ id: 'r1', name: 'q', state: 'queued', model: 'lmstudio/old', queuedPrompt: 'old task' })])]);
    await tick();
    await openEditor(container);
    const ta = container.querySelector('.am-editor textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('old task');
    await fireEvent.input(ta, { target: { value: 'new task' } });
    await fireEvent.click(byText(container.querySelector('.am-editor')!, 'Save'));
    await tick();
    const upd = posts().find((p) => p.type === 'amUpdateQueued')!;
    expect(upd).toEqual({ type: 'amUpdateQueued', root: '/repo/a', id: 'r1', prompt: 'new task' });
    expect(container.querySelector('.am-editor')).not.toBeNull(); // no optimistic close

    amState([repo('/repo/a', '', [mkRow({ id: 'r1', name: 'q', state: 'queued', model: 'lmstudio/old', queuedPrompt: 'new task' })])]);
    await tick();
    expect(container.querySelector('.am-editor')).toBeNull(); // the host's ack closes it
  });

  it('a refused Save (amError) keeps the editor open with the edit intact', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [mkRow({ id: 'r1', name: 'q', state: 'queued', queuedPrompt: 'old task' })])]);
    await tick();
    await openEditor(container);
    const ta = container.querySelector('.am-editor textarea') as HTMLTextAreaElement;
    await fireEvent.input(ta, { target: { value: 'my careful new task' } });
    await fireEvent.click(byText(container.querySelector('.am-editor')!, 'Save'));
    await tick();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'amError', message: 'This agent has no queued task to edit.' } }));
    await tick();
    expect((container.querySelector('.am-editor textarea') as HTMLTextAreaElement).value).toBe('my careful new task');
    expect(container.querySelector('.am-error')!.textContent).toContain('no queued task');
  });
});

describe('Folds board — the error banner accumulates', () => {
  it('two failures interleaved with broadcasts BOTH stay visible, and a launch clears them', async () => {
    const { container } = render(AgentManagerPane);
    amState([repo('/repo/a', '', [], [mkTicket({ id: 't-1', status: 'todo' })])]);
    await tick();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'amError', message: 'Launch failed for "race-1": disk full' } }));
    await tick();
    amState([repo('/repo/a', '', [], [mkTicket({ id: 't-1', status: 'todo' })])]); // a sibling's broadcast must not wipe it
    await tick();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'amError', message: 'Launch failed for "race-2": disk full' } }));
    await tick();
    const shown = Array.from(container.querySelectorAll('.am-error')).map((e) => e.textContent).join(' | ');
    expect(shown).toContain('race-1');
    expect(shown).toContain('race-2');

    await fireEvent.click(ticketsIn(container, 'Todo')[0].querySelector('.am-tk-btn.go')!);
    await tick();
    expect(container.querySelector('.am-error')).toBeNull(); // a fresh attempt dismisses stale failures
  });
});

describe('Folds board — the repo toolbar', () => {
  it('carries the default model, the map controls and auto-approve for the SELECTED repo', async () => {
    const { container } = render(AgentManagerPane);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelOptions', options: [{ value: 'openrouter/live', name: 'Live Model' }] } }));
    amState([repo('/repo/a', 'lmstudio/gone-old')], { autoApprove: false });
    await tick();
    const head = container.querySelector('.am-repohead') as HTMLElement;
    // A persisted default absent from the live list is surfaced, not silently swallowed.
    expect(head.querySelector('.ams-trigger')!.textContent).toContain('gone-old');
    expect(head.querySelector('.ams-trigger')!.textContent).toContain('unavailable');
    expect(byTitle(head, 'cartographer').textContent).toContain('Map repo');

    const box = head.querySelector('.am-autoapprove input') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await fireEvent.click(box);
    expect(posts()).toContainEqual({ type: 'amSetAutoApprove', on: true });
  });
});
