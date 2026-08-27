// Two engine messages must never share one transcript bubble.
//
// Owner-reproduced on 0.4.25 (session export 2026-08-20 16:58): a European
// capitals table and a second answer arrived character-interleaved INSIDE one
// bubble. The engine cause was a second turn loop streaming onto the same
// session (server/server.ts memo map) — but the pane is what merged the two
// streams, because `agentText` appended EVERY delta into `currentAgentMsgId`
// regardless of which engine message it belonged to. Nothing but a tool card, a
// user row or a thought ever closed that bubble.
//
// The engine tags every live text delta with its message id, so the pane can
// key the open bubble by it (agentStreamSeal.ts). The rendered test below is
// red without that rule: both messages land in ONE row.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import { sealsOpenBubble } from '../panes/agentStreamSeal';

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

afterEach(() => { cleanup(); globalThis.__vscodeApiMock.postMessage.mockClear(); });

// ChatPane never unbinds its window listener, so a mount from an earlier test
// still answers every posted message — a fresh session id per mount keeps each
// assertion about the pane under test (composerEnter.test.ts's rule).
let seq = 0;

function agentRows(c: HTMLElement): string[] {
  return [...c.querySelectorAll('.cell-messages .row.agent')].map((el) => el.textContent ?? '');
}

async function mountChat(): Promise<{ c: HTMLElement; sid: string }> {
  const sid = `seal-${++seq}`;
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: sid, sessionNumber: seq, agentName: 'Tsuru' });
  post({ type: 'modelStatus', sessionId: sid, ok: true, modelName: 'deepseek' });
  await tick();
  return { c: container as HTMLElement, sid };
}

describe('agent-text deltas are keyed by the engine message they belong to', () => {
  it('puts two engine messages in TWO bubbles, with no tool card between them', async () => {
    const { c, sid } = await mountChat();
    post({ type: 'agentText', sessionId: sid, text: 'first answer', messageId: 'msg_a' });
    post({ type: 'agentText', sessionId: sid, text: ' continues', messageId: 'msg_a' });
    post({ type: 'agentText', sessionId: sid, text: 'second answer', messageId: 'msg_b' });
    await tick();

    const rows = agentRows(c);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('first answer continues');
    expect(rows[0]).not.toContain('second answer');
    expect(rows[1]).toContain('second answer');
  });

  it('interleaved deltas from two concurrent streams never merge into one row', async () => {
    // Exactly the shape of the owner's export: two messages streaming at the
    // same time, their chunks arriving alternately.
    const { c, sid } = await mountChat();
    post({ type: 'agentText', sessionId: sid, text: '| Albania | Tir', messageId: 'msg_eu' });
    post({ type: 'agentText', sessionId: sid, text: 'Let me get', messageId: 'msg_us' });
    post({ type: 'agentText', sessionId: sid, text: 'ana |', messageId: 'msg_eu' });
    post({ type: 'agentText', sessionId: sid, text: ' both lists', messageId: 'msg_us' });
    await tick();

    // Each hand-off opens a fresh row. Fragmentation is the deliberate price:
    // two streams at once is a defect, and four honest rows beat one garbled
    // one. (Engine-side, concurrent streams are now impossible — this is the
    // pane's own guarantee, independent of that.)
    const rows = agentRows(c);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('| Albania | Tir');
    expect(rows[1]).toContain('Let me get');
    expect(rows[2]).toContain('ana |');
    expect(rows[3]).toContain('both lists');
    // The defect, as an assertion: no row holds text from BOTH streams.
    for (const row of rows) expect(row.includes('Albania') && row.includes('lists')).toBe(false);
  });

  it('keeps appending when the delta carries no id (a plain ACP server sends none)', () => {
    expect(sealsOpenBubble([{ id: 1, engineMsgId: 'msg_a' }], 1, undefined)).toBe(false);
  });

  it('keeps appending while the open bubble is not yet stamped', () => {
    // The first chunk of a bubble can arrive before its id does; ChatPane stamps
    // it retroactively. Sealing here would split one message on every late stamp.
    expect(sealsOpenBubble([{ id: 1 }], 1, 'msg_a')).toBe(false);
  });

  it('does not seal when the ids agree, and does when they differ', () => {
    expect(sealsOpenBubble([{ id: 1, engineMsgId: 'msg_a' }], 1, 'msg_a')).toBe(false);
    expect(sealsOpenBubble([{ id: 1, engineMsgId: 'msg_a' }], 1, 'msg_b')).toBe(true);
    expect(sealsOpenBubble([{ id: 1, engineMsgId: 'msg_a' }], null, 'msg_b')).toBe(false);
  });
});
