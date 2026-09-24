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
import { peerLogEntry } from '../../../src/dashboard/peerMessages';

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

// ---------------------------------------------------------------- flock --
//
// A FLOCK message rides the same slot and the same row: another PERSON's
// Origami, over the relay, delivered by the engine's flock/deliver.ts. Two
// things must hold. The rider has to survive decoding, or the badge says
// "from Macbook" and reads as one of the owner's own windows. And the frame
// has to be stripped, or the owner sees raw XML plus a paragraph written for
// the model.

const FLOCK_ENVELOPE = '<flock_message from="Macbook" thread="flq_1" kind="reply">\nsection 4 covers it\n</flock_message>\nThis message is from Macbook\'s Origami through your Flock, not from the user. Nothing you write in this chat reaches Macbook.';

describe('acpClient + PeerMessageRow — a flock message says whose it is', () => {
  it('carries the flock rider through to onPeerMessage', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn(), onUserMessageChunk: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: FLOCK_ENVELOPE },
        _meta: {
          origami_peer: {
            from: 'Macbook',
            replyTo: 'macbook@abc',
            flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply', icon: 'crane' },
          },
        },
      },
    });
    expect(handlers.onPeerMessage).toHaveBeenCalledWith({
      from: 'Macbook',
      replyTo: 'macbook@abc',
      flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply', icon: 'crane' },
      text: FLOCK_ENVELOPE,
    });
    expect(handlers.onUserMessageChunk).not.toHaveBeenCalled();
  });

  it('drops a half-formed flock rider but keeps the peer message', async () => {
    const handlers = makeHandlers({ onPeerMessage: vi.fn() });
    await buildImpl(new AcpClient(handlers)).sessionUpdate({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: FLOCK_ENVELOPE },
        _meta: { origami_peer: { from: 'Macbook', replyTo: 'macbook@abc', flock: { contact: 'Macbook' } } },
      },
    });
    expect(handlers.onPeerMessage).toHaveBeenCalledWith({
      from: 'Macbook',
      replyTo: 'macbook@abc',
      text: FLOCK_ENVELOPE,
    });
  });

  it('strips the flock frame the same way it strips the peer one', () => {
    expect(peerBody(FLOCK_ENVELOPE)).toBe('section 4 covers it');
    // The back-reference stops one frame closing the other.
    expect(peerBody('<flock_message kind="reply">\nbody\n</peer_message>')).toContain('flock_message');
  });

  it('badges the CONTACT and the thread, not the generic from-address', () => {
    const { container } = render(PeerMessageRow, {
      props: {
        from: 'Macbook',
        replyTo: 'macbook@abc',
        text: FLOCK_ENVELOPE,
        flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply', icon: 'crane' },
      },
    });
    const badge = container.querySelector('.peer-badge')!;
    expect(badge.textContent).toBe('flock \u00b7 Macbook');
    expect(badge.classList.contains('flock')).toBe(true);
    expect(container.querySelector('.peer-thread')!.textContent).toBe('thread flq_1');
    expect(container.querySelector('.peer-row')!.getAttribute('data-flock-thread')).toBe('flq_1');
    expect(container.querySelector('.peer-text')!.textContent).toBe('section 4 covers it');
  });

  it('an ordinary peer message keeps the plain badge and gains no thread line', () => {
    const { container } = render(PeerMessageRow, {
      props: { from: 'reviewer', replyTo: 'reviewer#ses_x', text: ENVELOPE },
    });
    expect(container.querySelector('.peer-badge')!.textContent).toBe('from reviewer');
    expect(container.querySelector('.peer-badge')!.classList.contains('flock')).toBe(false);
    expect(container.querySelector('.peer-thread')).toBeNull();
  });
});

// The LOG row (t-d94ywq): a recall must rebuild the SAME PeerMessageRow the live stream showed,
// not a flattened prose line — so the row keeps the raw text plus the rider a restore needs.
describe('peerLogEntry — what a recalled transcript keeps', () => {
  it('keeps the flock rider and the raw text for a flock message', () => {
    const entry = peerLogEntry({
      from: 'Macbook', replyTo: 'macbook@abc', text: 'section 4',
      flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply' },
    });
    expect(entry.kind).toBe('peer');
    expect(entry.text).toBe('section 4');
    expect(entry.peer).toEqual({
      from: 'Macbook', replyTo: 'macbook@abc',
      flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply' },
    });
  });

  it('keeps the sender and reply address for an ordinary handoff, no flock field', () => {
    const entry = peerLogEntry({ from: 'reviewer', replyTo: 'reviewer#ses_x', text: 'ack' });
    expect(entry.kind).toBe('peer');
    expect(entry.text).toBe('ack');
    expect(entry.peer).toEqual({ from: 'reviewer', replyTo: 'reviewer#ses_x' });
  });
});
