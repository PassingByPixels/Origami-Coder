// t-s9k0q6 — the sidebar's Here | Nest control and the flat Nest tab, driven
// the way the host drives it: window messages in, postMessage out. The index
// is the round-7 demo data in the L4a wire shape (nestFixture.ts). Each test
// names the acceptance line it holds.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import ChatsHereNest from './ChatsHereNest.svelte';
import { nestPush, NOW, ROWS, SELF } from '../dashboard/__tests__/nestFixture';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  globalThis.__vscodeApiMock.setState.mockClear();
  globalThis.__vscodeApiMock.getState.mockReset();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

function sessionList(...rows: Array<[string, string]>): unknown {
  return { type: 'sessionList', sessions: rows.map(([id, title], n) => ({ id, number: n + 1, agentName: 'Tsuru', title })) };
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(ChatsHereNest);
  // 'n-agent' is ALSO in this window's list: a read-only open of a chat 5090 owns.
  await post(sessionList(['a', 'Godot rig'], ['n-agent', 'Element: Agent message']));
  await post(nestPush());
  return container as HTMLElement;
}
const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
async function openNest(c: HTMLElement) { await fireEvent.click(tabs(c)[1]); await tick(); }
const hereNames = (c: HTMLElement) => Array.from(c.querySelectorAll('.session-list .session-name')).map((n) => n.textContent);
const nestTitles = (c: HTMLElement) => Array.from(c.querySelectorAll('.nest-row .session-name')).map((n) => n.textContent);
const nestRow = (c: HTMLElement, id: string) => c.querySelector(`.nest-row[data-id="${id}"]`) as HTMLElement;

describe('rule 1 — the control', () => {
  it('shows under Chats once another desk is registered, with Here selected', async () => {
    const c = await mount();
    expect(tabs(c).map((t) => t.textContent?.trim())).toEqual(['Here', 'Nest']);
    expect(tabs(c)[0].getAttribute('aria-selected')).toBe('true');
    expect(posts()).toContainEqual({ type: 'requestNestIndex' });
  });
  it('goes again when the host stops sending other desks, and Here shows every chat again', async () => {
    const c = await mount();
    await post(nestPush([], [SELF]));
    expect(tabs(c)).toHaveLength(0);
    expect(hereNames(c)).toContain('Tsuru: Element: Agent message');
  });
  it('a gate that flips does not remount the list: a turn that was running still shows as running', async () => {
    const c = await mount();
    await post({ type: 'sessionStatus', sessionId: 'a', status: 'busy' });
    const ring = () => c.querySelector('.session-ring')?.getAttribute('data-state');
    expect(ring()).toBe('working');
    await post(nestPush([], []));
    expect(ring()).toBe('working');
    await post(nestPush());
    expect(ring()).toBe('working');
  });
  it('remembers the chosen view per viewer (webview state)', async () => {
    const c = await mount();
    await openNest(c);
    expect(globalThis.__vscodeApiMock.setState).toHaveBeenLastCalledWith(expect.objectContaining({ chatsView: 'nest' }));
  });
});

describe('rule 2 — one list or the other, never both', () => {
  it('Here drops a chat another desk owns, and the section count drops with it', async () => {
    const c = await mount();
    expect(hereNames(c)).toEqual(['Tsuru: Godot rig']);
    expect(c.querySelector('.chat-section-count')?.textContent).toBe('1');
  });
  it('the Nest tab replaces the Here sections with the one flat list', async () => {
    const c = await mount();
    await openNest(c);
    expect(c.querySelector('.chat-section-header')).toBeNull();
    expect(nestTitles(c)).toHaveLength(9);
  });
});

describe('rule 3 — order, History, search', () => {
  it('running first, then open by last activity, a History divider, then closed newest first', async () => {
    const c = await mount();
    await openNest(c);
    const rowsEl = c.querySelector('.nest-rows') as HTMLElement;
    const seq = Array.from(rowsEl.children).map((el) =>
      el.querySelector('.nest-divider') || el.classList.contains('nest-divider') ? '|History|' : el.querySelector('.session-name')?.textContent);
    expect(seq).toEqual([
      'Coder: Cron sweep for the board', 'Element: Agent message', 'Element: Peer message',
      '|History|',
      'Spark: DFlash acceptance sweep', 'iOS: TestFlight notes', 'Aetheron: snow shader pass',
      'Coder: relay heartbeat bug', 'Relay: phone page CSP', 'WH3: dwarf unit table',
    ]);
  });
  it('search filters both parts, says how many match, and Esc clears it', async () => {
    const c = await mount();
    await openNest(c);
    const box = c.querySelector('input[type="search"]') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'sweep' } });
    expect(nestTitles(c)).toEqual(['Coder: Cron sweep for the board', 'Spark: DFlash acceptance sweep']);
    expect(c.querySelector('.nest-filter span')?.textContent).toBe('2 of 9 match "sweep"');
    expect(c.querySelector('.nest-view')?.classList.contains('filtered')).toBe(true);
    await fireEvent.keyDown(box, { key: 'Escape' });
    expect(nestTitles(c)).toHaveLength(9);
    expect(c.querySelector('.nest-filter')).toBeNull();
  });
  it('a search with no match says so', async () => {
    const c = await mount();
    await openNest(c);
    await fireEvent.input(c.querySelector('input[type="search"]') as HTMLInputElement, { target: { value: 'godot' } });
    expect(nestTitles(c)).toEqual([]);
    expect(c.querySelector('.nest-filter span')?.textContent).toBe('No chat in the nest matches "godot"');
  });
});

describe('rule 4 — the row', () => {
  it('title, desk chip and age on one row; the chip is dashed for an offline desk', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const c = await mount();
    vi.useRealTimers();
    await openNest(c);
    const cron = nestRow(c, 'n-cron');
    expect(cron.querySelector('.desk-name')?.textContent).toBe('5090');
    expect(cron.querySelector('.nest-age')?.textContent).toBe('now');
    expect(cron.querySelector('.desk-chip')?.classList.contains('off')).toBe(false);
    expect(cron.querySelector('.session-dot')?.getAttribute('data-state')).toBe('running');
    const peer = nestRow(c, 'n-peer');
    expect(peer.querySelector('.desk-chip')?.classList.contains('off')).toBe(true);
    expect(peer.querySelector('.desk-chip svg path')).not.toBeNull();
    expect(nestRow(c, 'n-snow').getAttribute('data-k')).toBe('closed');
  });
});

describe('rule 5 — read only, Continue here', () => {
  it('a plain click asks the host to open the chat read only; the row waits for the answer, and a refusal shows', async () => {
    const c = await mount();
    await openNest(c);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const open = nestRow(c, 'n-cron').querySelector('.session-open') as HTMLButtonElement;
    // The round-7 read-only sentence is the row's tooltip now.
    expect(open.dataset.tip).toContain('the turn on 5090 goes on');
    await fireEvent.click(open);
    expect(posts()).toEqual([{ type: 'nestOpenRead', id: 'n-cron' }]);
    expect(open.disabled).toBe(true);
    await fireEvent.click(open);
    expect(posts()).toHaveLength(1);
    await post({ type: 'nestOpenReadResult', id: 'n-cron', error: 'No desk that holds this chat is online.' });
    expect(open.disabled).toBe(false);
    expect(c.querySelector('.nest-err')?.textContent).toBe('No desk that holds this chat is online.');
    await post({ type: 'nestOpenReadResult', id: 'n-cron' });
    expect(c.querySelector('.nest-err')).toBeNull();
  });
  it('the Continue here tooltip names the fork case on a mid-turn desk', async () => {
    const c = await mount();
    await openNest(c);
    expect((nestRow(c, 'n-cron').querySelector('.nest-cont') as HTMLElement).dataset.tip).toBe('5090 is mid-turn: this makes a fork here');
    expect((nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLElement).dataset.tip).toBe('5090 is idle: this moves the chat here');
  });
  it('a move: the row leaves the Nest and shows in Here with "from 5090"', async () => {
    const c = await mount();
    await openNest(c);
    await fireEvent.click(nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLElement);
    expect(posts()).toContainEqual({ type: 'nestContinue', id: 'n-agent' });
    await post({ type: 'nestContinueResult', id: 'n-agent', result: 'taken', newId: 'n-agent' });
    expect(tabs(c)[0].getAttribute('aria-selected')).toBe('true');
    const row = Array.from(c.querySelectorAll('.session-list .session-row')).find((r) => r.textContent?.includes('Agent message'));
    expect(row?.querySelector('.arrival')?.textContent).toBe('from 5090');
    await openNest(c);
    expect(nestTitles(c)).not.toContain('Element: Agent message');
  });
  it('a fork: the copy shows in Here under its parent line with the fork tag; the parent stays in the Nest', async () => {
    const c = await mount();
    await openNest(c);
    await fireEvent.click(nestRow(c, 'n-cron').querySelector('.nest-cont') as HTMLElement);
    await post({ type: 'nestContinueResult', id: 'n-cron', result: 'forked', newId: 'fork-1' });
    await post({ type: 'sessionCreated', sessionId: 'fork-1', sessionNumber: 3, agentName: 'Coder', title: 'Cron sweep for the board' });
    const parent = c.querySelector('.nest-fork-parent') as HTMLElement;
    expect(parent.querySelector('.parent-name')?.textContent).toBe('Coder: Cron sweep for the board');
    const forkRow = parent.nextElementSibling as HTMLElement;
    expect(forkRow.classList.contains('session-row')).toBe(true);
    expect(forkRow.querySelector('.arrival.fork')?.textContent).toBe('fork');
    await openNest(c);
    expect(nestTitles(c)).toContain('Coder: Cron sweep for the board');
  });
  it('a refused Continue leaves the row in the Nest and the button usable again', async () => {
    const c = await mount();
    await openNest(c);
    const btn = () => nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLButtonElement;
    await fireEvent.click(btn());
    expect(btn().disabled).toBe(true);
    await post({ type: 'nestContinueResult', id: 'n-agent', error: 'Nests is off.' });
    expect(btn().disabled).toBe(false);
    expect(nestTitles(c)).toContain('Element: Agent message');
  });
  it('t-t7lfho: the host drops the taken row BEFORE it answers; the view still goes to Here and the chat\'s row is selected', async () => {
    const c = await mount();
    await openNest(c);
    await fireEvent.click(nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLElement);
    // The order the host really sends: continueHere syncs (row gone), opens the chat, then answers.
    await post(nestPush(ROWS.filter((r) => r.id !== 'n-agent')));
    await post({ type: 'nestContinueResult', id: 'n-agent', result: 'taken', newId: 'n-agent' });
    expect(tabs(c)[0].getAttribute('aria-selected')).toBe('true');
    const row = Array.from(c.querySelectorAll('.session-list .session-row')).find((r) => r.textContent?.includes('Agent message')) as HTMLElement;
    expect(row.classList.contains('selected')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.querySelector('.arrival')?.textContent).toBe('from 5090');
    expect(c.querySelectorAll('.session-row.selected')).toHaveLength(1);
  });
  it('t-t7lfho: a chat this desk gave away stays in Here with an "on <desk>" chip, and is in the Nest again', async () => {
    const c = await mount();
    await openNest(c);
    await fireEvent.click(nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLElement);
    await post(nestPush(ROWS.filter((r) => r.id !== 'n-agent')));
    await post({ type: 'nestContinueResult', id: 'n-agent', result: 'taken', newId: 'n-agent' });
    // 5090 takes it back: this desk's next push names it as away, and 5090's row is back.
    await post({ ...nestPush(), away: [{ id: 'n-agent', desk: 'dev-5090', at: new Date(2026, 8, 22, 14, 2).getTime() }] });
    const row = Array.from(c.querySelectorAll('.session-list .session-row')).find((r) => r.textContent?.includes('Agent message')) as HTMLElement;
    const chip = row.querySelector('.arrival.away') as HTMLElement;
    expect(chip.textContent).toBe('on 5090');
    expect(chip.dataset.tip).toBe('Continued on 5090 at 14:02. This desk can only read it.');
    await openNest(c);
    expect(nestTitles(c)).toContain('Element: Agent message');
  });
  it('a second click while the host has not answered does not post again', async () => {
    const c = await mount();
    await openNest(c);
    const btn = nestRow(c, 'n-agent').querySelector('.nest-cont') as HTMLButtonElement;
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    expect(posts().filter((m) => m.type === 'nestContinue')).toHaveLength(1);
  });
});

// jsdom has no layout: what the eye checks (the 28 px row, the dashed chip,
// the tokens) is pinned on the CSS source here and on the lane-build shots.
describe('the look, on the CSS source', () => {
  const src = (f: string) => readFileSync(join(__dirname, f), 'utf-8');
  it('a Nest row is the product row box: the same padding and type as ChatsList', () => {
    const rule = (s: string, sel: string) => s.match(new RegExp(`\\n  ${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    for (const prop of ['padding: 6px 8px;', 'gap: 7px;', 'align-items: baseline;']) {
      expect(rule(src('ChatsList.svelte'), '.session-open')).toContain(prop);
      expect(rule(src('NestRow.svelte'), '.session-open')).toContain(prop);
    }
    expect(rule(src('NestRow.svelte'), '.session-name')).toContain('font-size: 12px;');
  });
  it('an offline desk\'s chip is dashed', () => {
    expect(src('DeskChip.svelte')).toMatch(/\.desk-chip\.off \{[^}]*border-style: dashed/);
  });
  it('the nest glyph has one source: its path lives in shared/nestGlyph.ts and nowhere else', () => {
    const bowl = 'M3.6 12c1.3 5 4.5 8 8.4 8s7.1-3 8.4-8';
    const holders = ['ChatsViewToggle.svelte', 'NestReadOnlyGate.svelte', '../shared/NestGlyph.svelte', '../dashboard/panes/boardIconsNests.ts', '../shared/nestGlyph.ts']
      .filter((f) => src(f).includes(bowl));
    expect(holders).toEqual(['../shared/nestGlyph.ts']);
    expect(src('ChatsViewToggle.svelte')).toContain("import NestGlyph from '../shared/NestGlyph.svelte'");
    expect(src('NestReadOnlyGate.svelte')).toContain("import NestGlyph from '../shared/NestGlyph.svelte'");
    expect(src('../dashboard/panes/boardIconsNests.ts')).toContain("export { NESTS_ICON } from '../../shared/nestGlyph'");
  });
  it('the new files name no colour literal: theme tokens only', () => {
    for (const f of ['ChatsViewToggle.svelte', 'NestList.svelte', 'NestRow.svelte', 'DeskChip.svelte', 'FromPill.svelte', 'ForkParentLine.svelte', 'NestReadOnlyGate.svelte', '../shared/NestGlyph.svelte']) {
      const style = src(f).split('<style>')[1] ?? '';
      expect(style, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\s*[;}]/);
    }
  });
});
