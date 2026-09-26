// t-yyz5yk — Round 8 transcript markers (A compacted, C streaming caret, D
// dropped stream, E agent chat connected). Structure only: jsdom loads no
// <style>. Each block also asserts the data the old row carried is still there.
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ChatTranscript from './ChatTranscript.svelte';
import type { Message } from '../panes/chatMessage';

afterEach(cleanup);

let next = 1;
function transcript(messages: Message[], props: Record<string, unknown> = {}) {
  return render(ChatTranscript, {
    messages, sessionId: 's1', inFlight: false,
    currentThoughtMsgId: null, currentAgentMsgId: null,
    openThoughtIds: undefined, onThoughtOpenIds: () => {}, ...props,
  });
}
const compacted = (extra: Partial<Message> = {}) =>
  ({ id: next++, kind: 'compacted', label: '', text: 'the summary', ...extra }) as Message;

describe('Round 8 A — the compacted marker is a divider', () => {
  it('a finished compaction reads "Context compacted" between two rules, summary kept', () => {
    const { container } = transcript([compacted()]);
    const block = container.querySelector('details.compaction-block');
    expect(block?.querySelectorAll('.compaction-rule')).toHaveLength(2);
    expect(block?.querySelector('.compaction-title')?.textContent).toBe('Context compacted');
    expect(block?.querySelector('.compaction-text')?.textContent).toBe('the summary');
    expect(block?.querySelector('.compaction-travel')).toBeNull();
  });

  it('a running compaction says so and carries the travelling line', () => {
    const { container } = transcript([compacted({ compacting: true, text: '' })]);
    const block = container.querySelector('details.compaction-block');
    expect(block?.querySelector('.compaction-title')?.textContent).toBe('Compacting context…');
    expect(block?.querySelector('.compaction-travel')).not.toBeNull();
  });
});

describe('Round 8 C — the caret exists only while the stream runs', () => {
  const agent = () => ({ id: 900, kind: 'agent', label: 'Tsuru', text: 'Fixed the title.' }) as Message;
  it('the open agent row is live while the turn streams', () => {
    const { container } = transcript([agent()], { inFlight: true, currentAgentMsgId: 900 });
    expect(container.querySelector('.row.agent.is-live')).not.toBeNull();
  });
  it('the same row after the turn is not live (no caret, ink colour)', () => {
    const { container } = transcript([agent()], { inFlight: false, currentAgentMsgId: null });
    expect(container.querySelector('.row.agent.is-live')).toBeNull();
    expect(container.querySelector('.row.agent')?.textContent).toContain('Fixed the title.');
  });
});

describe('Round 8 D — a dropped stream wears the failed-tool grammar', () => {
  const drop = (kind: 'retrying' | 'stopped', recovered = false) => ({
    id: next++, kind: 'streamDrop', label: 'System', text: '',
    streamDrop: { notice: { kind, attempt: 1, max: 3, detail: 'fetch failed', terminal: kind === 'stopped' }, ...(recovered ? { recovered } : {}) },
  }) as Message;

  it('retrying: retry glyph and the travelling line, count and reason kept', () => {
    const { container } = transcript([drop('retrying')]);
    const a = container.querySelector('.alert');
    expect(a?.querySelector('.alert-icon svg')?.getAttribute('data-icon')).toBe('retry');
    expect(a?.querySelector('.og-travel')).not.toBeNull();
    expect(a?.textContent).toContain('attempt 1 of 3');
    expect(a?.textContent).toContain('fetch failed');
  });

  it('recovered: tick, and no motion', () => {
    const { container } = transcript([drop('retrying', true)]);
    const a = container.querySelector('.alert');
    expect(a?.querySelector('.alert-icon svg')?.getAttribute('data-icon')).toBe('check');
    expect(a?.querySelector('.og-travel')).toBeNull();
  });

  it('stopped: no motion, Retry kept', () => {
    const { container } = transcript([drop('stopped')], { onRetryTurn: () => {} });
    const a = container.querySelector('.alert');
    expect(a?.querySelector('.og-travel')).toBeNull();
    expect(a?.querySelector('.alert-retry')).not.toBeNull();
  });
});

describe('Round 8 E — agent chat connected is a handshake row', () => {
  const ID = 'ses_f2a05386dffeA9nEVnmqUnmc34';
  const sys = (text: string) => ({ id: next++, kind: 'system', label: 'System', text }) as Message;

  it('the host line draws as a connected row with the short id, full id kept', () => {
    const { container } = transcript([sys(`Connected. Session ${ID}. Type a message and press Enter.`)]);
    const row = container.querySelector('.conn-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.conn-state')?.textContent).toBe('connected');
    const sid = row?.querySelector('.conn-sid');
    expect(sid?.textContent).toBe('ses_f2a0…Unmc34');
    expect(sid?.getAttribute('data-tip')).toContain(ID);
  });

  it('any other system line stays a plain row', () => {
    const { container } = transcript([sys(`Recalled session ${ID}. Continue the conversation below.`)]);
    expect(container.querySelector('.conn-row')).toBeNull();
    expect(container.textContent).toContain('Recalled session');
  });
});

describe('Round 8 I — the todo snapshot is a row with a segment bar', () => {
  const todos = [
    { id: 1, content: 'Find the readers', activeForm: '', status: 'completed' },
    { id: 2, content: 'Clear the cache in rename()', activeForm: '', status: 'pending' },
    { id: 3, content: 'Add a test', activeForm: '', status: 'pending' },
  ] as const;
  const snap = () => ({ id: next++, kind: 'todoSummary', label: '', text: '', summaryTodos: todos.map((t) => ({ ...t })) }) as Message;

  it('one segment per item, done ones green, the next one current, and what is next', () => {
    const { container } = transcript([snap()]);
    const row = container.querySelector('.todo-summary-msg .todo-row');
    expect(row?.querySelectorAll('.todo-seg')).toHaveLength(3);
    expect(row?.querySelectorAll('.todo-seg.d')).toHaveLength(1);
    expect([...(row?.querySelectorAll('.todo-seg') ?? [])].findIndex((s) => s.classList.contains('cur'))).toBe(1);
    expect(row?.querySelector('.todo-row-meta')?.textContent).toBe('1/3 done · now: Clear the cache in rename()');
  });

  it('opens to the list with state dots; every item kept', async () => {
    const { container } = transcript([snap()]);
    const head = container.querySelector('.todo-row-head') as HTMLButtonElement;
    head.click();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const items = container.querySelectorAll('.todo-row-list li');
    expect([...items].map((li) => li.textContent?.trim())).toEqual(todos.map((t) => t.content));
    expect(container.querySelectorAll('.todo-row-list .sd.done')).toHaveLength(1);
  });
});
