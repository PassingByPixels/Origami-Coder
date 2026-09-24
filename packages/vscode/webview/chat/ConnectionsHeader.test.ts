// ConnectionsHeader — the Connections label and its Refresh button (t-ttmo5w).
// What the owner sees: one click asks the host to refresh; the button spins until
// the host answers, then says done or failed; a click while it spins sends nothing.

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import ConnectionsHeader from './ConnectionsHeader.svelte';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]);
const button = () => screen.getByRole('button') as HTMLButtonElement;

async function hostSays(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

describe('ConnectionsHeader', () => {
  it('keeps the Connections label the brand row always had', () => {
    const { container } = render(ConnectionsHeader);
    expect(container.querySelector('.connections-label')?.textContent).toBe('Connections');
  });

  it('a click posts refreshModelLists once and spins; a second click while it spins sends nothing', async () => {
    render(ConnectionsHeader);
    await fireEvent.click(button());
    await fireEvent.click(button());
    expect(posts()).toEqual([{ type: 'refreshModelLists' }]);
    expect(button().dataset.state).toBe('running');
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
  });

  it('the host answer ok:true shows done, then the button returns to idle', async () => {
    vi.useFakeTimers();
    render(ConnectionsHeader);
    await fireEvent.click(button());
    await hostSays({ type: 'modelListsRefreshed', ok: true });
    expect(button().dataset.state).toBe('done');
    vi.advanceTimersByTime(3_000);
    await tick();
    expect(button().dataset.state).toBe('idle');
    expect(button().disabled).toBe(false);
  });

  it('ok:false shows failed and stays until the next click', async () => {
    vi.useFakeTimers();
    render(ConnectionsHeader);
    await fireEvent.click(button());
    await hostSays({ type: 'modelListsRefreshed', ok: false });
    expect(button().dataset.state).toBe('failed');
    expect(button().dataset.tip).toMatch(/did not reach every connection/); // t-v483ot: the warm tip, not a native title
    expect(button().hasAttribute('title')).toBe(false);
    vi.advanceTimersByTime(60_000);
    await tick();
    expect(button().dataset.state).toBe('failed');
    await fireEvent.click(button());
    expect(button().dataset.state).toBe('running');
  });

  it('a host that never answers does not leave the spinner running forever', async () => {
    vi.useFakeTimers();
    render(ConnectionsHeader);
    await fireEvent.click(button());
    vi.advanceTimersByTime(151_000);
    await tick();
    expect(button().dataset.state).toBe('failed');
  });

  it('an answer that arrives with no refresh running changes nothing', async () => {
    render(ConnectionsHeader);
    await hostSays({ type: 'modelListsRefreshed', ok: true });
    expect(button().dataset.state).toBe('idle');
  });
});
