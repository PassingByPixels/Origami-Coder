// t-v5qv6u — the composer's Fork button, which replaced the `/btw` slash command.
//
// The owner's report: after `/btw`, the ORIGINAL chat showed '/btw' as a user
// message and its agent looked confused. The requirement this pins: a click
// posts ONE message, the host's fork request for THIS chat, and nothing that
// could land in the chat as a row or reach its engine (`send`, `interject`,
// `slashCommand`). The host half (nothing posted back to the source) is
// sessionFork.test.ts. Whether the glyph READS as a fork needs a human eye.
import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach } from 'vitest';
import ComposerUtilityRow from './ComposerUtilityRow.svelte';

const post = () => globalThis.__vscodeApiMock.postMessage;

describe('ComposerUtilityRow — the Fork button', () => {
  beforeEach(() => post().mockReset());

  const row = (props: Record<string, unknown> = {}) =>
    render(ComposerUtilityRow, { secondOpinionFor: 'chat-7', onToggleFocus: () => {}, ...props }).container;

  it('sits immediately left of the second-opinion scales', () => {
    const c = row();
    const fork = c.querySelector('.fork-chat');
    expect(fork).not.toBeNull();
    expect(fork!.nextElementSibling?.classList.contains('second-opinion')).toBe(true);
  });

  it('posts ONE fork request for THIS chat, and nothing that reaches the chat itself', async () => {
    const c = row();
    await fireEvent.click(c.querySelector('.fork-chat')!);

    expect(post().mock.calls.map((call) => call[0])).toEqual([{ type: 'forkChat', sessionId: 'chat-7' }]);
  });

  it('draws no Fork where there is no engine session to copy (bare or passthrough composer)', () => {
    // InputBar passes `null` for both, the same gate the scales use.
    const c = render(ComposerUtilityRow, { secondOpinionFor: null, onToggleFocus: () => {} }).container;
    expect(c.querySelector('.fork-chat')).toBeNull();
  });

  // `disabled` is the whole lockout, as for the scales: a browser delivers no
  // click to a disabled button (jsdom's fireEvent does, so it is not probed here).
  it('is dead while a turn is running, and the warm tip says why', () => {
    const button = row({ busy: true }).querySelector('.fork-chat') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.dataset.tip).toContain('once the current turn finishes');
  });

  it('uses the warm house tooltip, not a bare title attribute', () => {
    const button = row().querySelector('.fork-chat') as HTMLButtonElement;
    expect(button.dataset.tip).toMatch(/new tab/);
    expect(button.hasAttribute('title')).toBe(false);
  });
});
