// The chat pane's own History dropdown, after t-463pb6 put a SECOND kind of row
// on the `historyList` wire.
//
// The sidebar's popup gained Claude Code's transcripts on purpose. This pane
// shares the wire and did not: its picker posts `recallSession`, which asks the
// ENGINE to reload a transcript by id, and a Claude session id is an id the
// engine has never seen. Listing one here would offer a row whose only possible
// outcome is an error — or worse, a silent empty chat.
//
// So this is the regression guard for a leak, and it asserts what is DRAWN
// rather than what was filtered: a filter that ran on the wrong field, or after
// the wrong assignment, still leaves the row on screen.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

const ENGINE_ROW = {
  sessionId: 'ses_a', title: 'Assess the labyrinth repo', folder: 'origami-coder',
  cwd: 'C:/repos/origami-coder', updatedAt: '2026-09-08T14:05:00.000Z', kind: 'origami', current: false,
};
const CLAUDE_ROW = {
  sessionId: 'cc_1', title: 'Terrain shader', folder: 'aetheron',
  cwd: 'C:/ws/aetheron', updatedAt: '2026-09-09T14:05:00.000Z', kind: 'claude',
};

async function openHistoryWith(sessions: unknown[]): Promise<HTMLElement> {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'showHistory' });
  await tick();
  post({ type: 'historyList', sessions });
  await tick();
  return container as HTMLElement;
}

function titles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.history-row .history-title')).map((n) => n.textContent ?? '');
}

describe('ChatPane history dropdown — engine runs only', () => {
  it('draws the engine row and leaves the Claude transcript out', async () => {
    const container = await openHistoryWith([ENGINE_ROW, CLAUDE_ROW]);

    expect(titles(container)).toEqual(['Assess the labyrinth repo']);
  });

  it('still lists a row from a host that sends no kind at all', async () => {
    const container = await openHistoryWith([{ ...ENGINE_ROW, kind: undefined }]);

    expect(titles(container)).toEqual(['Assess the labyrinth repo']);
  });

  it('says it is empty rather than listing a Claude-only payload', async () => {
    const container = await openHistoryWith([CLAUDE_ROW]);

    expect(container.querySelectorAll('.history-row')).toHaveLength(0);
    expect(container.querySelector('.history-empty')).not.toBeNull();
  });
});
