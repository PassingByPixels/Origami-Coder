// t-ty02bb. On 0.4.170 the Claude (subscription) card sat ABOVE the connection
// strip whenever the setting was on, and nothing could hide it: every other
// connection is a tile whose card opens on click. It is now a tile in the same
// strip, and its card opens and closes from it the same way. Driven through the
// real ControlStrip with the exact messages the host posts
// (`providerStatus`, `claudeSubscriptionStatus`, `modelListsRefreshed`).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import ControlStrip from '../ControlStrip.svelte';

const mock = () => globalThis.__vscodeApiMock.postMessage;

async function post(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

const LMSTUDIO = { id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local', baseURL: 'http://127.0.0.1:1234/v1', primary: true };
const TOO_OLD = {
  type: 'claudeSubscriptionStatus',
  enabled: true,
  ready: false,
  label: 'Version too old',
  fixLine: 'Claude Code 2.1.198 is older than 2.1.263. Update it, then reopen this panel.',
};

/** The strip with one provider, and the subscription in the state given. */
async function strip(status: Record<string, unknown>) {
  const view = render(ControlStrip);
  await post({ type: 'providerStatus', providers: [LMSTUDIO] });
  await post(status);
  return view;
}
const subTile = () => screen.queryByRole('button', { name: /^Claude \(Sub\)/ }); // t-xu5o64: the short name
const card = (container: HTMLElement) => container.querySelector('.claude-sub-card');

afterEach(async () => {
  cleanup();
  // The status is module-wide (the tile and the card share it): reset it.
  await post({ type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '' });
});

describe('Claude (subscription) is a connection tile, and its card opens and closes from it', () => {
  it('the tile is in the strip with the reason; the card is hidden until the tile is clicked', async () => {
    const { container } = await strip(TOO_OLD);
    const tile = subTile();
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute('aria-label')).toContain('2.1.198');
    expect(card(container)).toBeNull();
  });

  it('click opens the card (label, fix line, Disconnect); a second click closes it', async () => {
    const { container } = await strip(TOO_OLD);
    await fireEvent.click(subTile()!);
    expect(card(container)).not.toBeNull();
    expect(container.textContent).toContain('Version too old');
    expect(container.textContent).toContain('Update it');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();

    await fireEvent.click(subTile()!);
    expect(card(container)).toBeNull();
  });

  it('opening another connection closes it, as between any two tiles', async () => {
    const { container } = await strip(TOO_OLD);
    await fireEvent.click(subTile()!);
    expect(card(container)).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /^LM Studio/ }));
    expect(card(container)).toBeNull();
    expect(container.querySelector('.settings-fold')).not.toBeNull();
  });

  it('the setting off: no tile and no card', async () => {
    const { container } = await strip({ type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '' });
    expect(subTile()).toBeNull();
    expect(card(container)).toBeNull();
  });

  it('the Connections Refresh answer asks for the status again (the engine re-ran Gate B)', async () => {
    await strip(TOO_OLD);
    mock().mockClear();
    await post({ type: 'modelListsRefreshed', ok: true });
    expect(mock()).toHaveBeenCalledWith({ type: 'requestClaudeSubscriptionStatus' });
  });

  it('t-ysud6n: ready shows a GREEN tile, not just a title (the acceptance ask, not just "some tile")', async () => {
    const { container } = await strip({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '', cli: '' });
    const tile = subTile();
    expect(tile).not.toBeNull();
    expect(tile!.classList.contains('light-green')).toBe(true);
    // A click still opens the READY card (label + Disconnect, no fix line).
    await fireEvent.click(tile!);
    expect(card(container)).not.toBeNull();
    expect(container.textContent).toContain('Ready');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('t-ysud6n: the tile still lights when its status answer lands BEFORE providerStatus (the CLI-only Gate B check is faster than the network provider probe)', async () => {
    render(ControlStrip);
    await post({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '', cli: '' });
    await post({ type: 'providerStatus', providers: [LMSTUDIO] });
    const tile = subTile();
    expect(tile).not.toBeNull();
    expect(tile!.classList.contains('light-green')).toBe(true);
  });
});
