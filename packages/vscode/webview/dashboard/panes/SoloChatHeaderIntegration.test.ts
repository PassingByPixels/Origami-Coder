// t-qn0wj5, proposal 23 — integration check: SoloChatHeader.test.ts proves the
// leaf renders correctly in isolation; this proves ChatPane actually mounts it
// when soloSessionId is set and a matching session exists, on the SAME
// host->webview bridge ChatPane.test.ts already exercises.
import { render, cleanup } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import ChatPane from './ChatPane.svelte';

const SID = 's-rig';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

describe('ChatPane + SoloChatHeader integration', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });
  afterEach(cleanup);

  it('shows the 24px strip once a session matching soloSessionId exists', async () => {
    const { container } = render(ChatPane, { props: { soloSessionId: SID } });
    postFromHost({ type: 'sessionCreated', sessionId: SID, sessionNumber: 36, agentName: 'Tsuru', title: 'Rig the collar bones', agentArt: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.solo-chat-header')).not.toBeNull();
    expect(container.querySelector('.solo-chat-title')?.textContent).toContain('Rig the collar bones');
  });

  it('never shows the multi-tab bar in the same state', async () => {
    const { container } = render(ChatPane, { props: { soloSessionId: SID } });
    postFromHost({ type: 'sessionCreated', sessionId: SID, sessionNumber: 36, agentName: 'Tsuru', agentArt: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.session-tabs')).toBeNull();
  });
});
