// t-v5qrdz — find's next/previous must reach EVERY match it counts, in both modes.
//
// The owner's report: "git" in LOADED mode said 10/90, but the arrows never reached most of the
// matches. Three defects, each proved here against the real transcript renderer
// (ChatTranscript.svelte), not a hand-made copy of its markup:
//  1. LOADED counted text inside a CLOSED <details> (a thought block, a compaction summary, a
//     sub-agent's live output). The counter moved onto it, but the text was hidden, so the
//     screen did not move and nothing was painted.
//  2. LOADED stepped by a NUMBER into a list it re-read on every step. Rows prepended above
//     (a scroll-up page load) shifted every match down, so "next" jumped back by the page's
//     match count and the counter lied until the next step.
//  3. ALL landed on the first local match in the hit's row, or gave up with "inside a collapsed
//     block": a tool hit in a collapsed card, a thought hit (landed in the agent row of the same
//     message), a second hit in the same row, and a row Focus view folded away were never reached.
//
// jsdom has no layout: "scrolled to" is read as the element handed to scrollIntoView, stubbed
// below. Whether the real window moves to it needs a human eye.

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import ChatFind from './ChatFind.svelte';
import ChatTranscript from './ChatTranscript.svelte';
import { findMatches, stepFrom } from './chatFind';
import { pickJumpMatch, type GlobalHit } from './chatFindGlobal';
import { emptyHistory, type ChatHistory } from '../panes/chatHistory';
import type { Message } from '../panes/chatMessage';

let scrolled: Element[] = [];
const realScroll = Element.prototype.scrollIntoView;
beforeEach(() => {
  document.body.innerHTML = '';
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  globalThis.__vscodeApiMock.postMessage.mockReset();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = realScroll;
});

/** A cell shaped like ChatPane's: `.chat-cell` around the `.cell-messages` scroller find walks. */
function mountCell(id = 's1'): { cell: HTMLElement; scroller: HTMLElement } {
  const cell = document.createElement('div');
  cell.className = 'chat-cell';
  cell.dataset.sessionId = id;
  const scroller = document.createElement('div');
  scroller.className = 'cell-messages';
  scroller.dataset.sessionId = id;
  cell.appendChild(scroller);
  document.body.appendChild(cell);
  return { cell, scroller };
}

const transcriptProps = (messages: Message[], focusMode = false) => ({
  messages, sessionId: 's1', inFlight: false, currentThoughtMsgId: null, currentAgentMsgId: null,
  openThoughtIds: [] as number[], onThoughtOpenIds: () => undefined, focusMode,
});

const counter = () => document.querySelector('.cf-count')?.textContent?.trim() ?? '';
const next = async () => { await fireEvent.click(document.querySelector('[aria-label="Next match"]')!); await tick(); };
const prev = async () => { await fireEvent.click(document.querySelector('[aria-label="Previous match"]')!); await tick(); };

async function openAndType(q: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
  const input = document.querySelector<HTMLInputElement>('.cf-input')!;
  input.value = q;
  await fireEvent.input(input);
  await tick();
}

/** Is `el` hidden by a closed <details>? Its summary is the one part that stays drawn. */
const hiddenByDetails = (el: Element | null | undefined): boolean => {
  for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) {
    if (!d.open && !el?.closest('summary')) return true;
  }
  return false;
};

let rowId = 0;
const msg = (kind: Message['kind'], text: string, extra: Partial<Message> = {}): Message => ({ id: ++rowId, kind, label: kind === 'agent' ? 'Tsuru' : kind, text, ...extra });

describe('LOADED — every counted match is reached', () => {
  it('opens a closed thought block when a step lands in it', async () => {
    const { cell, scroller } = mountCell();
    render(ChatTranscript, { target: scroller, props: transcriptProps([
      msg('user', 'git status please'), msg('thought', 'check git first'), msg('agent', 'git is clean', { engineMsgId: 'm1' }),
    ]) });
    render(ChatFind, { target: cell, props: { sessionId: 's1' } });
    await openAndType('git');
    expect(counter()).toBe('1/3');
    await next();
    expect(counter()).toBe('2/3');
    const thought = scroller.querySelector<HTMLDetailsElement>('details.thought-block')!;
    expect(thought.open).toBe(true);
    expect(scrolled.at(-1)?.closest('details.thought-block')).toBe(thought);
  });

  it('visits every match once per cycle, in order, and never lands on hidden text', async () => {
    const { cell, scroller } = mountCell();
    render(ChatTranscript, { target: scroller, props: transcriptProps([
      msg('user', 'git one'), msg('thought', 'git two'), msg('compacted', 'git three'), msg('agent', 'git four', { engineMsgId: 'm1' }),
    ]) });
    render(ChatFind, { target: cell, props: { sessionId: 's1' } });
    await openAndType('git');
    const total = findMatches(scroller, 'git').length;
    expect(total).toBe(4);
    const seen: string[] = [];
    for (let i = 0; i < total; i++) {
      const el = scrolled.at(-1);
      expect(hiddenByDetails(el)).toBe(false);
      seen.push(el?.textContent ?? '');
      await next();
    }
    expect(seen).toEqual(['git one', 'git two', 'git three', 'git four']);
    expect(counter()).toBe('1/4'); // wrapped off the end
    await prev();
    expect(counter()).toBe('4/4'); // and off the front
  });

  it('keeps its place when older rows are prepended above, and re-counts at once', async () => {
    const { cell, scroller } = mountCell();
    scroller.innerHTML = '<div>two a</div><div>two b</div><div>two c</div>';
    const history: ChatHistory = { ...emptyHistory(), lazy: true };
    const bar = render(ChatFind, { target: cell, props: { sessionId: 's1', history } });
    await openAndType('two');
    await next();
    expect(counter()).toBe('2/3');
    expect(scrolled.at(-1)?.textContent).toBe('two b');
    // A scroll-up page load: two older rows land ABOVE, the way chatHistory.ts prepends `older`.
    scroller.insertAdjacentHTML('afterbegin', '<div>two x</div><div>two y</div>');
    await bar.rerender({ sessionId: 's1', history: { ...history, older: [msg('user', 'two x'), msg('user', 'two y')] } });
    await tick();
    expect(counter()).toBe('4/5'); // still on "two b", now fourth of five
    await next();
    expect(counter()).toBe('5/5');
    expect(scrolled.at(-1)?.textContent).toBe('two c');
    await next();
    expect(scrolled.at(-1)?.textContent).toBe('two x'); // wraps to the new first match
  });
});

describe('stepFrom — the place, when the match the reader was on is gone', () => {
  const root = () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>two a</p><p>two b</p><p>two c</p>';
    document.body.appendChild(el);
    return el;
  };

  it('its words changed in place: next is the first match after where it was, previous the last before', () => {
    const el = root();
    const was = findMatches(el, 'two')[1];
    (was.startNode as Text).data = 'one b';
    const now = findMatches(el, 'two');
    expect(now).toHaveLength(2);
    expect(stepFrom(now, was, 1)).toBe(1); // "two c"
    expect(stepFrom(now, was, -1)).toBe(0); // "two a"
    expect(stepFrom(now, was, 0)).toBe(1);
  });

  it('its row left the document: falls back to the old index, wrapped', () => {
    const el = root();
    const was = findMatches(el, 'two')[2];
    el.lastElementChild!.remove();
    const now = findMatches(el, 'two');
    expect(stepFrom(now, was, 1, 2)).toBe(1);
    expect(stepFrom(now, was, 0, 2)).toBe(1);
  });

  it('nothing landed on yet: next is the first match, previous the last', () => {
    const now = findMatches(root(), 'two');
    expect(stepFrom(now, null, 1)).toBe(0);
    expect(stepFrom(now, null, -1)).toBe(2);
    expect(stepFrom([], null, 1)).toBe(0);
  });
});

describe('ALL — every engine hit is landed on', () => {
  const hit = (over: Partial<GlobalHit>): GlobalHit => ({
    messageId: 'm1', partId: 'p', role: 'assistant', kind: 'text', toolCallId: null, time: 1, fromEnd: 0,
    snippet: '', matchStart: 0, matchLength: 6, matchesInPart: 1, ...over,
  });

  async function searchAll(hits: GlobalHit[]) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await fireEvent.click(document.querySelector('.cf-mode')!);
    const input = document.querySelector<HTMLInputElement>('.cf-input')!;
    input.value = 'needle';
    await fireEvent.input(input);
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'historySearchResult', sessionId: 's1', query: 'needle', hits, done: true, cursor: null } }));
    for (let i = 0; i < 4; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); }
  }

  const lazy = (loadedIds: string[]): ChatHistory => ({ ...emptyHistory(), lazy: true, loadedIds });

  it('opens a collapsed tool card and lands on the words in its body', async () => {
    const { cell, scroller } = mountCell();
    render(ChatTranscript, { target: scroller, props: transcriptProps([
      msg('user', 'run it'),
      msg('tool', '', { label: 'custom tool', toolKind: 'other', toolName: 'custom', toolStatus: 'completed', toolCallId: 'call-1', toolResult: 'found the needle in output', engineMsgId: 'm1' }),
    ]) });
    render(ChatFind, { target: cell, props: { sessionId: 's1', history: lazy(['m1']) } });
    await openAndType('');
    expect(scroller.querySelector('.tool-result')).toBeNull(); // starts collapsed
    await searchAll([hit({ kind: 'tool', toolCallId: 'call-1', snippet: 'found the needle in output', matchStart: 10 })]);
    const body = scroller.querySelector('[data-tool-call="call-1"] .tool-result');
    expect(body).not.toBeNull();
    expect(body!.contains(scrolled.at(-1)!)).toBe(true);
  });

  it('lands a thought hit in the thought block, opened — not in the agent row of the same message', async () => {
    const { cell, scroller } = mountCell();
    render(ChatTranscript, { target: scroller, props: transcriptProps([
      msg('thought', 'the needle is in my head'), msg('agent', 'a needle in the answer', { engineMsgId: 'm1' }),
    ]) });
    render(ChatFind, { target: cell, props: { sessionId: 's1', history: lazy(['m1']) } });
    await openAndType('');
    await searchAll([hit({ kind: 'reasoning', snippet: 'the needle is in my head', matchStart: 4 })]);
    const thought = scroller.querySelector<HTMLDetailsElement>('details.thought-block')!;
    expect(thought.contains(scrolled.at(-1)!)).toBe(true);
    expect(thought.open).toBe(true);
  });

  it('leaves Focus view when the hit is in a row it folded away, then lands on it', async () => {
    const { cell, scroller } = mountCell();
    const messages = [
      msg('user', 'run it'),
      msg('tool', '', { label: 'custom tool', toolKind: 'other', toolName: 'custom', toolStatus: 'completed', toolCallId: 'call-2', toolResult: 'the needle was here', engineMsgId: 'm1' }),
      msg('agent', 'done', { engineMsgId: 'm1' }),
    ];
    const t = render(ChatTranscript, { target: scroller, props: transcriptProps(messages, true) });
    expect(scroller.querySelector('[data-tool-call="call-2"]')).toBeNull(); // folded by Focus view
    const revealFolded = vi.fn(() => { void t.rerender(transcriptProps(messages, false)); return true; });
    render(ChatFind, { target: cell, props: { sessionId: 's1', history: lazy(['m1']), revealFolded } });
    await openAndType('');
    await searchAll([hit({ kind: 'tool', toolCallId: 'call-2', snippet: 'the needle was here', matchStart: 4 })]);
    expect(revealFolded).toHaveBeenCalled();
    const body = scroller.querySelector('[data-tool-call="call-2"] .tool-result');
    expect(body).not.toBeNull();
    expect(body!.contains(scrolled.at(-1)!)).toBe(true);
  });

  it('lands two hits in the same row on their own matches, by the words around each', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="agent-row" data-engine-msg="m3"><p>alpha needle one</p><p>beta needle two</p></div>';
    const all = findMatches(root, 'needle');
    expect(pickJumpMatch(root, all, hit({ messageId: 'm3', snippet: 'alpha needle one', matchStart: 6 }))).toBe(0);
    expect(pickJumpMatch(root, all, hit({ messageId: 'm3', snippet: 'beta needle two', matchStart: 5 }))).toBe(1);
  });
});
