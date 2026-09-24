// t-qn0wj5, proposal 23 (port of Mock-Redesign CHANGES.md #37): a popped-out chat
// tab gets a 24px strip carrying the session title + a status dot, in place of the
// multi-tab bar ChatPane.svelte hides whenever `soloSessionId` is set.
import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SoloChatHeader from './SoloChatHeader.svelte';

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(cleanup);

describe('SoloChatHeader', () => {
  it('reads "#N agentName: title", the same format the tab label used', () => {
    const { container } = render(SoloChatHeader, {
      props: { number: 35, agentName: 'Tsuru', title: 'Godot character rig', waiting: false },
    });
    const title = container.querySelector('.solo-chat-title');
    expect(title?.textContent).toBe('#35 Tsuru: Godot character rig');
  });

  it('omits the title separator when the session has no title yet', () => {
    const { container } = render(SoloChatHeader, {
      props: { number: 1, agentName: 'Tsuru', waiting: false },
    });
    expect(container.querySelector('.solo-chat-title')?.textContent).toBe('#1 Tsuru');
  });

  it('appends the peer name when one is set', () => {
    const { container } = render(SoloChatHeader, {
      props: { number: 2, agentName: 'Tsuru', peerName: 'flock-bot', waiting: false },
    });
    expect(container.querySelector('.solo-chat-title')?.textContent).toBe('#2 Tsuru · flock-bot');
  });

  it('carries the waiting class + colour token only when a question/permission is open', () => {
    const idle = render(SoloChatHeader, { props: { number: 1, agentName: 'A', waiting: false } });
    expect(idle.container.querySelector('.solo-chat-dot')?.classList.contains('waiting')).toBe(false);
    idle.unmount();

    const waiting = render(SoloChatHeader, { props: { number: 1, agentName: 'A', waiting: true } });
    expect(waiting.container.querySelector('.solo-chat-dot')?.classList.contains('waiting')).toBe(true);
  });

  it('is 24px tall by design (jsdom has no layout, so this reads the source, not getComputedStyle)', () => {
    const raw = readFileSync(path.join(here, 'SoloChatHeader.svelte'), 'utf8');
    expect(raw).toMatch(/\.solo-chat-header\s*\{[^}]*height:\s*24px/);
  });
});
