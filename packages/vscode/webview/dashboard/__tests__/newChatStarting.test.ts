// t-hb1b7e — a new chat's pane is on screen while its engine is still starting.
//
// The pane is opened on the click now, not after the awaited `start()`
// (sessionAnnounce.ts), so for the whole engine start-up — 2.4-2.5 s of engine
// measured on this PC, more on the Mac — the user is looking at a chat with no
// engine behind it. That window has to SAY so, and everything the host posts
// during it has to land in the pane that is already open.
//
// Each case below is a thing that used to be impossible to see, because there
// was no pane until the engine had answered.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener, so a fresh session id per mount
// keeps each assertion about the pane under test (newChatEcho.test.ts's rule).
let seq = 0;

/** The pane a New chat click opens: announced with the engine still starting. */
async function mountStarting(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `starting-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru', starting: true });
  await tick();
  return { c: container as HTMLElement, sid };
}

const composer = (c: HTMLElement) => c.querySelector('.input') as HTMLTextAreaElement;
const rowText = (c: HTMLElement) => [...c.querySelectorAll('.row')].map((r) => r.textContent ?? '').join(' | ');

describe('a new chat whose engine is still starting', () => {
  it('says so in the composer', async () => {
    const { c } = await mountStarting();
    expect(composer(c).placeholder).toContain('Starting engine');
  });

  it('stops saying so once the engine answers', async () => {
    const { c, sid } = await mountStarting();
    post({ type: 'sessionStarting', sessionId: sid, starting: false });
    await tick();
    expect(composer(c).placeholder).not.toContain('Starting engine');
  });

  it('takes the posts that arrive DURING the start — the connect line lands in the open pane', async () => {
    const { c, sid } = await mountStarting();
    // What `start()` posts when it resolves, into a pane that has been up all along.
    post({ type: 'system', sessionId: sid, text: 'Connected. Session ses_abc. Type a message and press Enter.' });
    post({ type: 'sessionStarting', sessionId: sid, starting: false });
    await tick();
    expect(rowText(c)).toContain('Connected. Session ses_abc');
  });

  it('shows a REJECTED start where the composer is, and stops saying it is starting', async () => {
    const { c, sid } = await mountStarting();
    // DashboardPanel's catch: the spawn failure is reported inside the chat panel,
    // which is only true because the panel exists before the attempt.
    post({ type: 'error', sessionId: sid, message: 'Could not start origami-acp: spawn ENOENT' });
    post({ type: 'sessionStarting', sessionId: sid, starting: false });
    await tick();
    expect(rowText(c)).toContain('Could not start origami-acp: spawn ENOENT');
    expect(composer(c).placeholder).not.toContain('Starting engine');
  });

  it('tells a tab that attached mid-start, whose live sessionStarting it could never have heard', async () => {
    // The chat's own editor tab is created DURING start() now, so the clearing post
    // can cross before that webview's wire exists. `replaySessionTo` carries the flag
    // on the re-announcement instead — the same catch-up road every other identity
    // field takes (sessionReplay.ts).
    const sid = `attach-${++seq}`;
    const { container } = render(ChatPane, { props: {} });
    const c = container as HTMLElement;
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru', starting: true });
    await tick();
    expect(composer(c).placeholder).toContain('Starting engine');

    // The host's replay burst for a chat whose engine has since answered.
    post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru', starting: false });
    await tick();
    expect(composer(c).placeholder).not.toContain('Starting engine');
  });
});
