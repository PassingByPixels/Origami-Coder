// CollabsList — the sidebar's Collabs half.
//
// GOAL 1 root cause, pinned down here: the New-collab form used to gate the
// Create button on `pickedSlugs.length > 0`, and pickedSlugs was populated
// ASYNCHRONOUSLY by CollabRosterPicker's own roster fetch. A user who typed a
// title and clicked Create before that roster arrived (or after it came back
// empty/failed, which silently WIPED an already-populated list — see
// CollabRosterPicker's now-removed `$effect`) hit a DISABLED button: no click
// event fires on a disabled element, so `commitNewCollab()` — which already
// carried an explicit refusal message for an empty roster — never even ran.
// Title typed, click, nothing: no collab, no error.
//
// The fix (Slack model, per the owner's call): create is TITLE-ONLY. There is
// no roster gate left to race, so this also verifies the create path never
// depends on any agent list having arrived.
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { tick } from 'svelte';
import CollabsList from './CollabsList.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

function posts(): Array<Record<string, unknown>> {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
}

async function openNewCollab(): Promise<HTMLInputElement> {
  await fireEvent.click(screen.getByRole('button', { name: /New collab/ }));
  return screen.getByLabelText('New collab title') as HTMLInputElement;
}

describe('CollabsList — create is title-only (Goal 1 regression)', () => {
  it('Create posts newCollab with an empty agentSlugs array, even before any agent roster has arrived', async () => {
    render(CollabsList);
    const input = await openNewCollab();
    await fireEvent.input(input, { target: { value: 'Storm plan' } });

    // No `collabAgents` reply was ever posted to this webview — the OLD roster
    // picker would still be showing "No collab-capable agents found" and its
    // Create button would be permanently disabled. The new form must not care.
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(posts()).toContainEqual({ type: 'newCollab', title: 'Storm plan', agentSlugs: [] });
  });

  it('the Create button stays disabled — and posts nothing — while the title is blank', async () => {
    render(CollabsList);
    await openNewCollab();
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await fireEvent.click(create);
    expect(posts().filter((p) => p.type === 'newCollab')).toEqual([]);
  });

  it('pressing Enter on an empty title closes the form without posting anything', async () => {
    render(CollabsList);
    const input = await openNewCollab();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(posts().filter((p) => p.type === 'newCollab')).toEqual([]);
    expect(screen.queryByLabelText('New collab title')).toBeNull();
  });
});

// Flock M4 wave X2 — the draft moved to CollabCreateForm.svelte (CollabsList
// was at 418/420) and grew the collab's standing OBJECTIVE. The field is
// optional, so the two states that matter are "sent when typed" and "the
// message is byte-identical to today's when it is not".
describe('CollabsList — the objective (flock M4)', () => {
  it('sends the objective alongside the title when one was typed', async () => {
    render(CollabsList);
    const input = await openNewCollab();
    await fireEvent.input(input, { target: { value: 'Storm plan' } });
    await fireEvent.input(screen.getByLabelText('Collab objective'), { target: { value: 'Ship the wire by Friday' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(posts()).toContainEqual({
      type: 'newCollab', title: 'Storm plan', agentSlugs: [], objective: 'Ship the wire by Friday',
    });
  });

  it('omits the field entirely when it was left blank — an empty objective is not an objective', async () => {
    render(CollabsList);
    const input = await openNewCollab();
    await fireEvent.input(input, { target: { value: 'Storm plan' } });
    await fireEvent.input(screen.getByLabelText('Collab objective'), { target: { value: '   ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(posts()).toContainEqual({ type: 'newCollab', title: 'Storm plan', agentSlugs: [] });
  });

  it('Escape from the objective box closes the draft without posting', async () => {
    render(CollabsList);
    await openNewCollab();
    await fireEvent.keyDown(screen.getByLabelText('Collab objective'), { key: 'Escape' });
    expect(screen.queryByLabelText('New collab title')).toBeNull();
    expect(posts().filter((p) => p.type === 'newCollab')).toEqual([]);
  });
});

describe('CollabsList — error surfacing (Goal 3)', () => {
  it('a create refusal from the host is shown where the user clicked', async () => {
    const { container } = render(CollabsList);
    const input = await openNewCollab();
    await fireEvent.input(input, { target: { value: 'Storm plan' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await post({ type: 'collabCreated', collab: null, error: 'the engine refused: title already in use' });
    expect(container.querySelector('.collab-error')!.textContent).toContain('title already in use');
  });
});

// Same native HTML5 DnD as SidebarLauncher's Chats list (see its "drag to
// reorder chats" describe block); the difference is what a drop DOES with it —
// the order is persisted host-side (workspaceState) rather than in the engine,
// since a collab has no order field of its own. See DashboardPanel's
// rankedCollabList/reorderCollabs for the host half.
function collabListMsg(rows: Array<{ id: string; title: string; archivedAt?: string }>): unknown {
  return { type: 'collabList', collabs: rows.map((r) => ({ ...r, createdAt: '', loopBreakerCap: null })) };
}
function liveRows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('.collab-list .session-row');
}
function liveTitles(container: HTMLElement): string[] {
  return Array.from(liveRows(container)).map((r) => r.querySelector('.session-name')?.textContent ?? '');
}
async function dragRowOnto(container: HTMLElement, from: number, to: number) {
  const rows = liveRows(container);
  await fireEvent.dragStart(rows[from]);
  await fireEvent.dragOver(rows[to]);
  await fireEvent.drop(rows[to]);
}

describe('CollabsList — drag to reorder', () => {
  it('dropping onto an earlier row moves it there and posts every live id', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]));
    expect(liveTitles(container)).toEqual(['A', 'B', 'C']);

    await dragRowOnto(container, 2, 0);

    expect(liveTitles(container)).toEqual(['C', 'A', 'B']);
    expect(posts()).toContainEqual({ type: 'reorderCollabs', order: ['c', 'a', 'b'] });
  });

  it('dropping onto a later row moves it down', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]));
    await dragRowOnto(container, 0, 2);
    expect(liveTitles(container)).toEqual(['B', 'C', 'A']);
    expect(posts()).toContainEqual({ type: 'reorderCollabs', order: ['b', 'c', 'a'] });
  });

  it('dropping a collab back on itself is a no-op — no order posted for a drag that changed nothing', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]));
    await dragRowOnto(container, 1, 1);
    expect(liveTitles(container)).toEqual(['A', 'B']);
    expect(posts().filter((p) => (p as { type: string }).type === 'reorderCollabs')).toEqual([]);
  });

  it('a drop with no drag in progress is ignored', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]));
    await fireEvent.drop(liveRows(container)[0]);
    expect(liveTitles(container)).toEqual(['A', 'B']);
    expect(posts().filter((p) => (p as { type: string }).type === 'reorderCollabs')).toEqual([]);
  });

  it('the drop indicator marks the edge the row would land on, and clears when the drag ends', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]));
    const rows = () => liveRows(container);

    await fireEvent.dragStart(rows()[2]);
    await fireEvent.dragOver(rows()[0]);           // moving UP -> land above row 0
    expect(rows()[0].className).toContain('drop-above');
    expect(rows()[0].className).not.toContain('drop-below');
    expect(rows()[2].className).toContain('dragging');

    await fireEvent.dragEnd(rows()[2]);
    expect(container.querySelector('.drop-above')).toBeNull();
    expect(container.querySelector('.dragging')).toBeNull();
  });

  it('dragging DOWN marks the lower edge instead', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]));
    const rows = liveRows(container);
    await fireEvent.dragStart(rows[0]);
    await fireEvent.dragOver(rows[2]);
    expect(rows[2].className).toContain('drop-below');
    expect(rows[2].className).not.toContain('drop-above');
  });

  it('an archived row is not draggable — History is a list to read, not to order', async () => {
    // The archived rows moved into the shared HistoryDropdown, so the property
    // that matters is unchanged and the selector is not: an archived room must
    // not join the live order, or a drop on one would post an order the engine
    // has no row for.
    const { container } = render(CollabsList);
    await post(collabListMsg([{ id: 'a', title: 'A' }, { id: 'z', title: 'Z', archivedAt: '2026-01-01' }]));
    await fireEvent.click(screen.getByRole('button', { name: /History/ }));
    const archivedRow = container.querySelector('.history-dropdown .history-row');
    expect(archivedRow).not.toBeNull();
    expect(archivedRow!.getAttribute('draggable')).toBeNull();
    // ...and it is not one of the live, draggable rows either.
    expect(Array.from(liveRows(container)).map((r) => r.textContent)).not.toContain('Z');
  });

  it('the posted order excludes archived ids when both sections are populated', async () => {
    const { container } = render(CollabsList);
    await post(collabListMsg([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'z', title: 'Z', archivedAt: '2026-01-01' },
    ]));
    await dragRowOnto(container, 1, 0);
    expect(posts()).toContainEqual({ type: 'reorderCollabs', order: ['b', 'a'] });
  });
});

// --- History is the shared HistoryDropdown, fed from the list this half
// ALREADY holds. Two properties matter and neither is cosmetic: it makes NO
// host round trip (so it must never render a loading state it can never leave),
// and it filters on the TITLE — a collab has no folder to match on.
describe('CollabsList — the History panel', () => {
  const WITH_ARCHIVE = collabListMsg([
    { id: 'a', title: 'Storm plan' },
    { id: 'z1', title: 'Old parser room', archivedAt: '2026-01-01' },
    { id: 'z2', title: 'Retired grammar room', archivedAt: '2026-01-02' },
  ]);
  const openHistory = () => fireEvent.click(screen.getByRole('button', { name: /History/ }));
  const titles = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('.history-row .history-title')).map((n) => n.textContent);

  it('lists the archived rooms with no second request to the host', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    const before = posts().length;
    await openHistory();

    expect(titles(container)).toEqual(['Old parser room', 'Retired grammar room']);
    // The rooms were already resident: opening the panel asks for nothing.
    expect(posts().length).toBe(before);
    // ...so it must never claim to be loading — that state has no way out here.
    expect(container.textContent).not.toContain('Loading…');
  });

  it('marks each row as archived, and says the tab opens read-only', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    await openHistory();
    const row = container.querySelector('.history-row')!;
    expect(row.querySelector('.history-meta')!.textContent).toBe('archived');
    expect(row.getAttribute('title')).toContain('read-only');
  });

  it('searches by title', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    await openHistory();

    await fireEvent.input(container.querySelector('.history-search') as HTMLInputElement, { target: { value: 'grammar' } });
    await tick();
    expect(titles(container)).toEqual(['Retired grammar room']);
    // The LIVE list is untouched by the archive search.
    expect(liveTitles(container)).toEqual(['Storm plan']);
  });

  it('says so when the search matches nothing, rather than going blank', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    await openHistory();
    await fireEvent.input(container.querySelector('.history-search') as HTMLInputElement, { target: { value: 'zzz' } });
    await tick();
    expect(container.querySelector('.history-empty')!.textContent).toBe('No matches.');
  });

  it('picking one opens THAT collab, through the same path a live row uses', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    await openHistory();
    await fireEvent.click(container.querySelectorAll('.history-row')[1] as HTMLElement);
    expect(posts()).toContainEqual({ type: 'openCollab', collabId: 'z2', title: 'Retired grammar room' });
  });

  it('a stale search does not survive closing and reopening the panel', async () => {
    const { container } = render(CollabsList);
    await post(WITH_ARCHIVE);
    await openHistory();
    await fireEvent.input(container.querySelector('.history-search') as HTMLInputElement, { target: { value: 'grammar' } });
    await tick();

    await openHistory(); // close
    await openHistory(); // reopen
    expect(titles(container)).toEqual(['Old parser room', 'Retired grammar room']);
  });
});
