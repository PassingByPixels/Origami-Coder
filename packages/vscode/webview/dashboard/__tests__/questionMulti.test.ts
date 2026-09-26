// t-xum9v2 / t-yyz5qi. "Tick all that apply": the engine marks a question
// `multiple: true` (acp/question.ts) and the host forwards the flag
// (questionBatch.questionsPost). These drive the REAL ChatPane with the host's
// `requestPermission` post and assert what reaches the host: every ticked label
// id, and a single-choice question still answered exactly as before. The phone
// (Remote) mounts this same ChatPane (webview/chat/ChatView.svelte), so this is
// its card too.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const S = 'sess-m';

function post(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
const opts = (...names: string[]) =>
  names.map((name, i) => ({ optionId: String(i), name, kind: i === 0 ? 'allow_once' : 'reject_once' }));
const permissionPosts = () =>
  (globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'permission');

async function mount(questions: Array<{ title: string; options: ReturnType<typeof opts>; multiple?: true }>) {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: S, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  post({ type: 'requestPermission', sessionId: S, toolCallId: 'tc-m', title: questions[0]!.title, kind: 'other', options: questions[0]!.options, questions });
  await tick();
  return container as HTMLElement;
}
async function click(c: HTMLElement, selector: string, label: string) {
  const el = Array.from(c.querySelectorAll(selector)).find((b) => b.textContent?.includes(label)) as HTMLElement;
  expect(el, `${selector} "${label}"`).toBeTruthy();
  await fireEvent.click(el);
  await tick();
}

describe('question card — tick all that apply (t-xum9v2)', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());

  it('renders a multiple:true question as checkboxes with the hint', async () => {
    const c = await mount([{ title: 'Which stores?', options: opts('SQLite', 'Redis', 'Files', 'Other'), multiple: true }]);
    expect(c.querySelector('.qm-hint')?.textContent).toContain('Tick all that apply');
    const boxes = Array.from(c.querySelectorAll('.opt-btn:not(.opt-other)')).map((b) => b.getAttribute('role'));
    expect(boxes).toEqual(['checkbox', 'checkbox', 'checkbox']);
  });

  it('Submit sends EVERY ticked option, and a second click unticks', async () => {
    const c = await mount([{ title: 'Which stores?', options: opts('SQLite', 'Redis', 'Files', 'Other'), multiple: true }]);
    await click(c, '.opt-btn', 'SQLite');
    await click(c, '.opt-btn', 'Files');
    await click(c, '.opt-btn', 'Redis');
    await click(c, '.opt-btn', 'Redis'); // untick
    const ticked = Array.from(c.querySelectorAll('.opt-btn[aria-checked="true"] .opt-text')).map((b) => b.textContent?.trim());
    expect(ticked).toEqual(['SQLite', 'Files']);
    await click(c, '.qm-submit-btn', 'Submit');
    const sent = permissionPosts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toolCallId: 'tc-m', sessionId: S, optionId: '0' });
    expect(sent[0]!.answers).toEqual([{ optionId: '0', optionIds: ['0', '2'] }]);
  });

  it('typed Other text rides with the ticks', async () => {
    const c = await mount([{ title: 'Which stores?', options: opts('SQLite', 'Redis', 'Other'), multiple: true }]);
    await click(c, '.opt-btn', 'Redis');
    expect(c.querySelector('.free-text-row.open')).toBeNull(); // closed until "Other…" is picked
    await click(c, '.opt-other', 'Other…');
    expect(c.querySelector('.free-text-row.open')).not.toBeNull();
    await fireEvent.input(c.querySelector('.free-text-input')!, { target: { value: 'and S3' } });
    await tick();
    await click(c, '.qm-submit-btn', 'Submit');
    expect(permissionPosts()[0]!.answers).toEqual([{ optionId: '1', optionIds: ['1'], answerText: 'and S3' }]);
  });

  it('a single-choice question is unchanged: radio pick, one optionId, no answers array', async () => {
    const c = await mount([{ title: 'Rebuild?', options: opts('Yes', 'No', 'Other') }]);
    expect(c.querySelector('.qm-hint')).toBeNull();
    await click(c, '.opt-btn', 'No');
    await click(c, '.opt-btn', 'Yes'); // replaces, never adds
    await click(c, '.qm-submit-btn', 'Submit');
    const sent = permissionPosts();
    expect(sent).toEqual([{ type: 'permission', toolCallId: 'tc-m', sessionId: S, optionId: '0' }]);
  });

  it('a mixed batch answers each question in its own shape, in order', async () => {
    const c = await mount([
      { title: 'Rebuild?', options: opts('Yes', 'No', 'Other') },
      { title: 'Which stores?', options: opts('SQLite', 'Redis', 'Other'), multiple: true },
    ]);
    await click(c, '.opt-btn', 'No');
    await click(c, '.qm-nav-btn', 'Next');
    await click(c, '.opt-btn', 'SQLite');
    await click(c, '.opt-btn', 'Redis');
    await click(c, '.qm-submit-btn', 'Submit');
    expect(permissionPosts()[0]!.answers).toEqual([{ optionId: '1' }, { optionId: '0', optionIds: ['0', '1'] }]);
  });
});

describe('centred ask — keys (t-yyz5qi)', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());
  const key = async (k: string, target: EventTarget = document.body) => { await fireEvent.keyDown(target, { key: k }); await tick(); };

  it('a digit picks that choice and Enter submits it', async () => {
    const c = await mount([{ title: 'Rebuild?', options: opts('Yes', 'No', 'Other') }]);
    await key('2');
    await key('Enter');
    expect(permissionPosts()).toEqual([{ type: 'permission', toolCallId: 'tc-m', sessionId: S, optionId: '1' }]);
    expect(c.querySelector('.qm-frame')).toBeNull();
  });

  it('Enter on an unanswered single-choice question sends nothing', async () => {
    const c = await mount([{ title: 'Rebuild?', options: opts('Yes', 'No', 'Other') }]);
    await key('Enter');
    expect(permissionPosts()).toHaveLength(0);
    expect(c.querySelector('.qm-frame')).not.toBeNull();
  });

  it('Esc cancels the ask and the engine hears it (no hung turn)', async () => {
    const c = await mount([{ title: 'Rebuild?', options: opts('Yes', 'No', 'Other') }]);
    await key('Escape');
    expect(permissionPosts()).toEqual([{ type: 'permission', toolCallId: 'tc-m', sessionId: S, optionId: null }]);
    expect(c.querySelector('.qm-frame')).toBeNull();
  });

  it('keys typed in the composer are not taken by the ask', async () => {
    const c = await mount([{ title: 'Rebuild?', options: opts('Yes', 'No', 'Other') }]);
    const composer = c.querySelector('textarea:not(.free-text-input)') as HTMLElement;
    expect(composer).toBeTruthy();
    await key('1', composer);
    await key('Escape', composer);
    expect(permissionPosts()).toHaveLength(0);
    expect(c.querySelector('.opt-btn.selected')).toBeNull();
  });
});
