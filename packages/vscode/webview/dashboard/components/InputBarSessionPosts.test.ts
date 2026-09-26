// t-xsufto (owner UAT of 0.4.178): every per-chat post from the composer carries the chat's own id, so the host runs
// it in the chat it was typed in. The composer posted `slashCommand`, `imageError` and the budget raise with NO
// sessionId, and the host used its selected chat (activeSessionId), which a popped-out tab never becomes: `/wrap`
// typed in one tab ran in another chat, `/bypass` switched another chat's mode. The host side is
// __tests__/slashCommandRouting.test.ts; this file pins the webview half.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { tick } from 'svelte';
import InputBar from './InputBar.svelte';

afterEach(cleanup);
beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });

const SID = 'sess-popped-a';
const posts = (type: string) => globalThis.__vscodeApiMock.postMessage.mock.calls
  .map((c: unknown[]) => c[0] as Record<string, unknown>)
  .filter((m) => m.type === type);

function mount() {
  return render(InputBar, {
    props: { inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true, sessionId: SID, onSend: () => {}, onCancel: () => {} },
  });
}

const box = (c: HTMLElement) => c.querySelector('textarea.input') as HTMLTextAreaElement;

async function type(c: HTMLElement, text: string) {
  await fireEvent.input(box(c), { target: { value: text } });
  await fireEvent.keyDown(box(c), { key: 'Enter' });
  await tick();
}

describe('the composer names its own chat on every per-chat post', () => {
  it.each(['/wrap', '/spend', '/bypass', '/auto'])('a typed %s posts slashCommand with this chat`s sessionId', async (line) => {
    const { container } = mount();
    await type(container, `${line} `); // the trailing space closes the palette, so Enter sends (as the owner types it)
    expect(posts('slashCommand')).toEqual([{ type: 'slashCommand', command: line.slice(1), args: '', sessionId: SID }]);
  });

  it('a refused image reports into this chat (imageError carries the sessionId)', async () => {
    const { container } = mount();
    const file = new File(['x'], 'shot.bmp', { type: '' }); // refused by readComposerImage (not an allowed type)
    await fireEvent.drop(box(container), { dataTransfer: { getData: () => '', setData: () => undefined, files: [file] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(posts('imageError').map((m) => m.sessionId)).toEqual([SID]);
  });

  it('the budget banner`s +$5 names this chat, so the confirmation line lands here', async () => {
    const { container } = mount();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'budgetUpdate', monthly: 10 } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'spendUpdate', month: '2026-09', total: 10 } }));
    await tick();
    await fireEvent.click(container.querySelector('.budget-raise') as HTMLButtonElement);
    expect(posts('setBudget')).toEqual([{ type: 'setBudget', monthly: 15, sessionId: SID }]);
  });
});
