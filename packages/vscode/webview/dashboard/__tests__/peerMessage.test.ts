// Cross-session agent messaging, receiver side (t-kgu05m).
//
// The requirement this file exists for is a MISATTRIBUTION one: a handoff from
// another agent arrives in the same wire slot as the human's own turn
// (`user_message_chunk`), and the ONLY thing separating them is the
// `_meta.origami_peer` rider the engine stamps. Lose the split and the receiving
// window shows another agent's words as its operator's, with no way to tell.
//
// So the two halves guarded here are: the client ROUTES on the rider, and the
// row it lands in SAYS who sent it and where a reply goes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import PeerMessageRow, { peerBody } from '../components/PeerMessageRow.svelte';

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

/** Drive the REAL decode in src/acpClient.ts, as acpClient.test.ts does. */
function buildImpl(client: AcpClient) {
  return (client as unknown as { buildClientImpl: () => any }).buildClientImpl();
}

const ENVELOPE = '<peer_message from="reviewer" reply_to="reviewer#ses_x">\nschema is frozen\n</peer_message>\nThis message is from another agent session, not the user — nothing you write in this chat reaches reviewer. To reply, call send_message with to: "reviewer#ses_x". Keep the reply short text, not a transcript.';

afterEach(() => cleanup());

describe('acpClient — a peer message is routed away from the human transcript', () => {
  it('a tagged user chunk reaches onPeerMessage with sender + reply address, and NOT onUserMessageChunk', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn(), onUserMessageChunk: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: ENVELOPE },
        _meta: { origami_peer: { from: 'reviewer', replyTo: 'reviewer#ses_x' } },
      },
    });

    expect(handlers.onPeerMessage).toHaveBeenCalledWith({
      from: 'reviewer',
      replyTo: 'reviewer#ses_x',
      text: ENVELOPE,
    });
    expect(handlers.onUserMessageChunk).not.toHaveBeenCalled();
  });

  it('an UNTAGGED user chunk still replays as the human — history recall must not regress', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn(), onUserMessageChunk: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'what I typed' } },
    });

    expect(handlers.onUserMessageChunk).toHaveBeenCalledWith('what I typed');
    expect(handlers.onPeerMessage).not.toHaveBeenCalled();
  });

  it('a half-formed rider is treated as no rider — better the human slot than a made-up sender', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn(), onUserMessageChunk: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'who sent this?' },
        _meta: { origami_peer: { from: 'reviewer' } },
      },
    });

    expect(handlers.onPeerMessage).not.toHaveBeenCalled();
    expect(handlers.onUserMessageChunk).toHaveBeenCalledWith('who sent this?');
  });
});

describe('peerBody — the model reads the envelope, the human should not', () => {
  it('strips the wrapper the engine sends', () => {
    expect(peerBody(ENVELOPE)).toBe('schema is frozen');
  });

  it('leaves anything that is not that envelope alone rather than guessing', () => {
    expect(peerBody('plain handoff')).toBe('plain handoff');
    expect(peerBody('<peer_message from="a" reply_to="b">unterminated')).toBe(
      '<peer_message from="a" reply_to="b">unterminated',
    );
  });

  it('keeps a multi-line body intact, blank lines and all', () => {
    expect(peerBody('<peer_message from="a" reply_to="b">\nline one\n\nline two\n</peer_message>')).toBe(
      'line one\n\nline two',
    );
  });
});

describe('PeerMessageRow — the provenance IS the content', () => {
  it('shows the simplified from-badge and the stripped body', () => {
    const { container } = render(PeerMessageRow, {
      from: 'reviewer',
      replyTo: 'reviewer#ses_x',
      text: ENVELOPE,
    });

    expect(container.querySelector('.peer-badge')!.textContent).toBe('from reviewer');
    expect(container.querySelector('.peer-text')!.textContent).toBe('schema is frozen');
  });

  it('marks the row with its sender so it is identifiable without reading the prose', () => {
    const { container } = render(PeerMessageRow, { from: 'docs', replyTo: 'docs#ses_y', text: 'ready' });
    expect(container.querySelector('.peer-row')!.getAttribute('data-peer-from')).toBe('docs');
  });
});
