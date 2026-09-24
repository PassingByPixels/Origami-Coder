// t-po041k. A SUB-AGENT'S QUESTION, as the parent chat renders it.
//
// The engine sends it on the peer-message wire deliberately (one frame, one
// rider, one row) — so the risk this file covers is that "deliberately reusing
// the peer row" quietly becomes "indistinguishable from a peer handoff". A
// handoff needs nothing from the user; a question means one of their own agents
// is stopped until somebody answers. The row has to say which it is.
//
// The envelope literal below is produced by
// packages/engine/src/session/subagent-question.ts, and
// packages/engine/test/session/subagent-question.test.ts asserts that file
// still emits this shape — that pair is what keeps the fixture honest.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import PeerMessageRow, { peerBody } from '../components/PeerMessageRow.svelte';
import { peerLogEntry } from '../../../src/dashboard/peerMessages';
import { restoredRow } from '../panes/restoredRow';

function makeHandlers(over: Partial<AcpEventHandlers> = {}): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(),
    onAgentImageChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onAvailableCommands: vi.fn(),
    onPlanStatus: vi.fn(),
    onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(),
    onTaskShape: vi.fn(),
    onTodoUpdate: vi.fn(),
    onArbiterDecision: vi.fn(),
    onTurnEnd: vi.fn(),
    onAssessmentUpdate: vi.fn(),
    onFeedMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

function buildImpl(client: AcpClient) {
  return (client as unknown as { buildClientImpl: () => any }).buildClientImpl();
}

const LABEL = 'Explore · T2 · audit the bundle';
const ENVELOPE = [
  `<peer_message from="${LABEL}" reply_to="ses_child" kind="sub-agent question">`,
  'Which store?',
  '   options: SQLite | Postgres',
  '</peer_message>',
  `This is a QUESTION from ${LABEL}, one of this chat's own sub-agents — not from the user.` +
    ' To release it, call question_reply with request_id "que_01" and one answer per question (1 answer, in order).',
].join('\n');

const RIDER = { label: LABEL, requestID: 'que_01', sessionID: 'ses_child' };

afterEach(() => cleanup());

describe('a sub-agent question on the peer wire', () => {
  it('reaches onPeerMessage carrying the subagent rider, not the human slot', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn(), onUserMessageChunk: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: ENVELOPE },
        _meta: { origami_peer: { from: LABEL, replyTo: 'ses_child', subagent: RIDER } },
      },
    });

    expect(handlers.onPeerMessage).toHaveBeenCalledWith({
      from: LABEL,
      replyTo: 'ses_child',
      subagent: RIDER,
      text: ENVELOPE,
    });
    expect(handlers.onUserMessageChunk).not.toHaveBeenCalled();
  });

  it('a half-formed subagent rider drops to a plain peer message rather than inventing a waiting agent', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: ENVELOPE },
        // No requestID: nothing could answer it, so nothing may claim one is waiting.
        _meta: { origami_peer: { from: LABEL, replyTo: 'ses_child', subagent: { label: LABEL } } },
      },
    });

    expect(handlers.onPeerMessage).toHaveBeenCalledWith({
      from: LABEL,
      replyTo: 'ses_child',
      text: ENVELOPE,
    });
  });

  it('the row is badged as a question and names the agent that is waiting', () => {
    const { container } = render(PeerMessageRow, {
      props: { from: LABEL, replyTo: 'ses_child', text: ENVELOPE, subagent: RIDER },
    });
    const badge = container.querySelector('.peer-badge');
    expect(badge?.textContent?.trim()).toBe('sub-agent question');
    expect(badge?.classList.contains('subagent')).toBe(true);
    expect(container.textContent).toContain(`${LABEL} · waiting`);
    // The request id is on the row for a client that wants to address it.
    expect(container.querySelector('[data-subagent-request="que_01"]')).toBeTruthy();
  });

  it('shows the questions and hides the instruction addressed to the model', () => {
    const { container } = render(PeerMessageRow, {
      props: { from: LABEL, replyTo: 'ses_child', text: ENVELOPE, subagent: RIDER },
    });
    const body = container.querySelector('.peer-text')?.textContent ?? '';
    expect(body).toContain('Which store?');
    expect(body).toContain('options: SQLite | Postgres');
    expect(body).not.toContain('question_reply');
    expect(peerBody(ENVELOPE)).toBe(body);
  });

  it('survives a history recall — the badge is not lost on replay', () => {
    const entry = peerLogEntry({ from: LABEL, replyTo: 'ses_child', subagent: RIDER, text: ENVELOPE }, 1_000);
    expect(entry.peer.subagent).toEqual(RIDER);
    const row = restoredRow(entry, 'Origami') as { peerSubagent?: unknown };
    expect(row.peerSubagent).toEqual(RIDER);
  });

  it('a plain peer handoff is still badged as a handoff', () => {
    const { container } = render(PeerMessageRow, {
      props: { from: 'reviewer', replyTo: 'reviewer#ses_x', text: 'schema is frozen' },
    });
    expect(container.querySelector('.peer-badge')?.textContent?.trim()).toBe('from reviewer');
    expect(container.querySelector('.peer-badge')?.classList.contains('subagent')).toBe(false);
  });
});
