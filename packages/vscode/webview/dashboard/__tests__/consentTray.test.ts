// t-yyz5qi (redesign R2, mockup B): a consent ask is one tray rising from the
// composer. Drives the REAL ChatPane through the host's `requestPermission`
// post. What must hold: Enter answers Allow once and Esc answers Reject, only
// on the chat in focus and never while you are typing; the tray stays in
// focus mode (where tool rows fold); YOLO sits apart; no ask is lost. The phone
// (Remote) mounts this same ChatPane (webview/chat/ChatView.svelte).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const A = 'sess-a';
const B = 'sess-b';
const CONSENT = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function post(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const answers = () => posts().filter((p) => p.type === 'permission');
const ask = (sessionId: string, toolCallId: string) =>
  post({ type: 'requestPermission', sessionId, toolCallId, title: 'edit src/a.ts', kind: 'edit', target: 'src/a.ts', options: CONSENT });
const key = async (k: string, target: EventTarget = document.body) => { await fireEvent.keyDown(target, { key: k }); await tick(); };

async function mountOne(): Promise<HTMLElement> {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: A, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  return container as HTMLElement;
}

describe('consent tray (t-yyz5qi)', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());

  it('renders as the tray on the composer, with YOLO set apart from the answers', async () => {
    const c = await mountOne();
    ask(A, 'tc-1');
    await tick();
    const tray = c.querySelector('.permission-bar.tray');
    expect(tray).not.toBeNull();
    expect(tray!.getAttribute('role')).toBe('alertdialog');
    // The tray sits directly on the composer: nothing between them.
    expect(tray!.nextElementSibling?.querySelector('.input-area') ?? tray!.nextElementSibling?.matches('.input-area')).toBeTruthy();
    const yolo = tray!.querySelector('.perm-btn.yolo')!;
    expect(yolo.previousElementSibling?.classList.contains('perm-spacer')).toBe(true);
  });

  it('Enter answers Allow once (never Always) and the tray goes', async () => {
    const c = await mountOne();
    ask(A, 'tc-1');
    await tick();
    await key('Enter');
    expect(answers()).toEqual([{ type: 'permission', toolCallId: 'tc-1', optionId: 'once', sessionId: A }]);
    expect(c.querySelector('.permission-bar')).toBeNull();
  });

  it('Esc answers Reject', async () => {
    await mountOne();
    ask(A, 'tc-1');
    await tick();
    await key('Escape');
    expect(answers()).toEqual([{ type: 'permission', toolCallId: 'tc-1', optionId: 'reject', sessionId: A }]);
  });

  it('keys typed in the composer belong to the composer: Enter and Esc there never answer the tray', async () => {
    const c = await mountOne();
    ask(A, 'tc-1');
    await tick();
    const composer = c.querySelector('.input-area textarea') as HTMLTextAreaElement;
    await key('Enter', composer);
    await key('Escape', composer);
    await fireEvent.input(composer, { target: { value: 'use the other file' } });
    await key('Enter', composer);
    expect(answers()).toHaveLength(0);
    expect(c.querySelector('.permission-bar')).not.toBeNull();
  });

  it('queued asks: one key answers ONE ask and the next one shows — none lost', async () => {
    const c = await mountOne();
    ask(A, 'tc-1');
    ask(A, 'tc-2');
    await tick();
    expect(c.querySelector('.perm-queue')?.textContent).toContain('1 of 2');
    await key('Enter');
    expect(answers().map((p) => p.toolCallId)).toEqual(['tc-1']);
    expect(c.querySelector('.permission-bar')).not.toBeNull();
    await key('Escape');
    expect(answers().map((p) => [p.toolCallId, p.optionId])).toEqual([['tc-1', 'once'], ['tc-2', 'reject']]);
    expect(c.querySelector('.permission-bar')).toBeNull();
  });

  it('stays on screen in focus mode, where tool rows fold', async () => {
    const c = await mountOne();
    await fireEvent.click(c.querySelector('[aria-label="Focus view"]')!);
    await tick();
    ask(A, 'tc-1');
    await tick();
    expect(c.querySelector('.permission-bar.tray')).not.toBeNull();
  });

  it('in the grid, a key answers only the chat in focus', async () => {
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: A, sessionNumber: 1, agentName: 'Tsuru' });
    post({ type: 'sessionCreated', sessionId: B, sessionNumber: 2, agentName: 'Tsuru' });
    post({ type: 'setChatLayout', grid: true });
    await tick();
    ask(A, 'tc-a');
    ask(B, 'tc-b');
    await tick();
    expect(container.querySelectorAll('.permission-bar')).toHaveLength(2);
    await key('Enter');
    expect(answers()).toHaveLength(1); // one key press, one answer
  });

  it('no key answers a consent tray while a question is open over the pane', async () => {
    const c = await mountOne();
    ask(A, 'tc-1');
    post({ type: 'requestPermission', sessionId: A, toolCallId: 'tc-q', title: 'Which?', kind: 'other',
      options: [{ optionId: '0', name: 'X', kind: 'allow_once' }, { optionId: '1', name: 'Other', kind: 'reject_once' }] });
    await tick();
    expect(c.querySelector('.qm-frame')).not.toBeNull();
    await key('Escape'); // closes the question only
    expect(answers()).toEqual([{ type: 'permission', toolCallId: 'tc-q', sessionId: A, optionId: null }]);
    expect(c.querySelector('.permission-bar')).not.toBeNull();
  });
});

import { trayKeyAnswer } from '../components/trayKeys';

describe('trayKeyAnswer (t-yyz5qi)', () => {
  const ev = (key: string, extra: Record<string, unknown> = {}) => ({ key, target: document.body, defaultPrevented: false, ...extra });
  it('Enter never grants wider than once: an always-only ask takes no Enter', () => {
    expect(trayKeyAnswer(ev('Enter'), [CONSENT[1]!, CONSENT[2]!])).toBeNull();
  });
  it('a question-shaped option set takes no keys at all', () => {
    const q = [{ optionId: '0', name: 'Yes', kind: 'allow_once' }, { optionId: '1', name: 'No', kind: 'reject_once' }];
    expect(trayKeyAnswer(ev('Enter'), q)).toBeNull();
    expect(trayKeyAnswer(ev('Escape'), q)).toBeNull();
  });
  it('modified or already-handled keys are left alone', () => {
    expect(trayKeyAnswer(ev('Enter', { shiftKey: true }), CONSENT)).toBeNull();
    expect(trayKeyAnswer(ev('Escape', { defaultPrevented: true }), CONSENT)).toBeNull();
  });
});
