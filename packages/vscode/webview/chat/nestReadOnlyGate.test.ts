// t-sc093o — the composer gate: a chat another desk owns shows ONE read-only
// line with Continue here in place of the composer, and the composer comes
// back when the chat is taken over. Driven as the host drives it: window
// messages in, postMessage out.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet, tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import NestReadOnlyGate from './NestReadOnlyGate.svelte';
import { nestPush } from '../dashboard/__tests__/nestFixture';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
const composer = createRawSnippet(() => ({ render: () => '<textarea class="composer" aria-label="Message"></textarea>' }));

describe('NestReadOnlyGate', () => {
  it('a chat of this desk keeps its composer, and the gate asks for the index once', async () => {
    const { container } = render(NestReadOnlyGate, { props: { sessionId: 'a-local', children: composer } });
    await post(nestPush());
    expect(container.querySelector('.composer')).not.toBeNull();
    expect(container.querySelector('.nest-ro')).toBeNull();
    expect(posts()).toEqual([{ type: 'requestNestIndex' }]);
  });

  it('a chat another desk owns: no composer, one line "Read only · on <desk>", Continue here posts nestContinue', async () => {
    const { container } = render(NestReadOnlyGate, { props: { sessionId: 'n-agent', children: composer } });
    await post(nestPush());
    expect(container.querySelector('.composer')).toBeNull();
    const bar = container.querySelector('.nest-ro') as HTMLElement;
    expect(bar.querySelector('.nest-ro-text')?.textContent).toBe('Read only · on 5090');
    expect(bar.querySelectorAll('button')).toHaveLength(1);
    const btn = bar.querySelector('button') as HTMLButtonElement;
    await fireEvent.click(btn);
    await fireEvent.click(btn);
    expect(posts().filter((m) => m['type'] === 'nestContinue')).toEqual([{ type: 'nestContinue', id: 'n-agent' }]);
    // A refusal is shown, and the button is usable again.
    await post({ type: 'nestContinueResult', id: 'n-agent', error: 'No desk that holds this chat is online.' });
    expect(bar.querySelector('.nest-ro-err')?.textContent).toBe('No desk that holds this chat is online.');
    expect(btn.disabled).toBe(false);
    // Taken over: the next index has no row for it, and the composer is back.
    const next = nestPush() as { rows: Array<{ id: string }> };
    await post({ ...next, rows: next.rows.filter((r) => r.id !== 'n-agent') });
    expect(container.querySelector('.composer')).not.toBeNull();
    expect(container.querySelector('.nest-ro')).toBeNull();
  });

  // t-t7lfho: the desk that LOST the chat. The host's first post after the
  // release names it in `away`; the new owner's row may not be here yet.
  const at = new Date(2026, 8, 22, 14, 2).getTime();
  const lost = (rows = (nestPush() as { rows: Array<{ id: string }> }).rows.filter((r) => r.id !== 'a-mine')) =>
    ({ ...nestPush(), rows, away: [{ id: 'a-mine', desk: 'dev-5090', at }] });

  it('t-t7lfho: a chat this desk gave away: at the first push, no composer; "Continued on 5090 at 14:02" with View and Take back here', async () => {
    const { container } = render(NestReadOnlyGate, { props: { sessionId: 'a-mine', children: composer } });
    await post(nestPush());
    expect(container.querySelector('.composer')).not.toBeNull();
    // The release lands: one push, and the composer is gone before any prompt can be typed.
    await post(lost());
    expect(container.querySelector('.composer')).toBeNull();
    const bar = container.querySelector('.nest-ro.away') as HTMLElement;
    expect(bar.querySelector('.nest-ro-text')?.textContent).toBe('Continued on 5090 at 14:02');
    const [view, take] = Array.from(bar.querySelectorAll('button')) as HTMLButtonElement[];
    expect([view.textContent, take.textContent]).toEqual(['View', 'Take back here']);
    // Take back here IS Continue here, from this side: the same message, this chat's id.
    await fireEvent.click(take);
    expect(posts().filter((m) => m['type'] === 'nestContinue')).toEqual([{ type: 'nestContinue', id: 'a-mine' }]);
    await post({ type: 'nestContinueResult', id: 'a-mine', error: 'That chat is not in the nest index.' });
    expect(bar.querySelector('.nest-ro-err')?.textContent).toBe('That chat is not in the nest index.');
    // View pulls the newest copy and keeps the pane read only.
    await fireEvent.click(view);
    expect(posts().filter((m) => m['type'] === 'nestOpenRead')).toEqual([{ type: 'nestOpenRead', id: 'a-mine' }]);
    await post({ type: 'nestOpenReadResult', id: 'a-mine' });
    expect(view.disabled).toBe(false);
    expect(container.querySelector('.composer')).toBeNull();
  });

  it('t-t7lfho: taken back here, the next push has no away record and the composer is back', async () => {
    const { container } = render(NestReadOnlyGate, { props: { sessionId: 'a-mine', children: composer } });
    await post(lost());
    expect(container.querySelector('.composer')).toBeNull();
    await post(nestPush());
    expect(container.querySelector('.composer')).not.toBeNull();
  });

  it('t-t7lfho: a desk the roster does not name is "another desk", never its device id', async () => {
    const { container } = render(NestReadOnlyGate, { props: { sessionId: 'a-mine', children: composer } });
    await post({ ...lost(), away: [{ id: 'a-mine', desk: 'Zq9-unknown', at }] });
    expect(container.querySelector('.nest-ro-text')?.textContent).toBe('Continued on another desk at 14:02');
  });

  it('is one line and uses theme tokens only (CSS source: jsdom has no layout)', () => {
    const style = readFileSync(join(__dirname, 'NestReadOnlyGate.svelte'), 'utf-8').split('<style>')[1] ?? '';
    expect(style).toMatch(/\.nest-ro \{[^}]*height: 30px;/);
    expect(style).toMatch(/\.nest-ro-text \{[^}]*white-space: nowrap;/);
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
});
