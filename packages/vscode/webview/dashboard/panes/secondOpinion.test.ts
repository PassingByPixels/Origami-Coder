// applySecondOpinion — what one `secondOpinionResult` does to a transcript.
//
// Everything here is about CORRELATION, which is the class of bug a
// single-review test cannot see. A chat can have two reviews out at once (the
// same turn, two models — comparing them is the obvious next thing a user
// does), and "fill the last pending card" behaves identically to "fill the card
// with this id" in every fixture that has only one card. So the two-in-flight
// case is the first test in the file, not an afterthought.

import { describe, expect, it, vi } from 'vitest';
import { applySecondOpinion } from './secondOpinion';
import type { Message } from './chatMessage';

let nextId = 0;

/** A card as the pane would have built it from a `pending` answer. */
function card(id: string, modelLabel: string, over: Partial<Message> = {}): Message {
  nextId += 1;
  return {
    id: nextId,
    kind: 'secondOpinion',
    label: `Second opinion — ${modelLabel}`,
    text: '',
    secondOpinion: { id, modelId: `p/${modelLabel}`, modelLabel, state: 'pending' },
    ...over,
  };
}

const agentRow = (text: string): Message => ({ id: ++nextId, kind: 'agent', label: 'Agent', text });

const answer = (id: string, text: string) => ({ id, state: 'ok', text, modelId: 'p/m', modelLabel: 'M' });

describe('an answer reaches the card that asked for it', () => {
  it('fills the card with the MATCHING id, not the most recent one', () => {
    // Two reviews in flight. The FIRST one answers first — which is exactly the
    // case "fill the last pending card" gets wrong, and nothing else would.
    const messages = [agentRow('the work'), card('so-1', 'Sonnet'), card('so-2', 'GPT-5')];

    const next = applySecondOpinion(messages, answer('so-1', 'Sonnet says: looks right.'), vi.fn())!;

    expect(next[1].text).toBe('Sonnet says: looks right.');
    expect(next[1].secondOpinion!.state).toBe('ok');
    expect(next[2].text).toBe('');
    expect(next[2].secondOpinion!.state).toBe('pending');
  });

  it('leaves every other row untouched, by identity', () => {
    const messages = [agentRow('the work'), card('so-1', 'Sonnet')];
    const next = applySecondOpinion(messages, answer('so-1', 'ok'), vi.fn())!;
    expect(next[0]).toBe(messages[0]);
  });

  it('does not mutate the array it was given — the pane assigns the result', () => {
    const messages = [card('so-1', 'Sonnet')];
    applySecondOpinion(messages, answer('so-1', 'reviewed'), vi.fn());
    expect(messages[0].text).toBe('');
    expect(messages[0].secondOpinion!.state).toBe('pending');
  });

  it('keeps the label the user has been looking at, even if the host answers with another', () => {
    const messages = [card('so-1', 'Sonnet')];
    const next = applySecondOpinion(
      messages,
      { id: 'so-1', state: 'ok', text: 'body', modelId: 'p/other', modelLabel: 'Something Else' },
      vi.fn(),
    )!;
    expect(next[0].secondOpinion!.modelLabel).toBe('Sonnet');
  });
});

describe('a failure is an answer too', () => {
  it('marks the card errored and carries the wording verbatim', () => {
    const messages = [card('so-1', 'Sonnet')];
    const next = applySecondOpinion(
      messages,
      { id: 'so-1', state: 'error', error: 'lmstudio refused: model not loaded' },
      vi.fn(),
    )!;
    expect(next[0].secondOpinion!.state).toBe('error');
    expect(next[0].secondOpinion!.error).toBe('lmstudio refused: model not loaded');
  });

  it('leaves the body empty on failure rather than writing the error into the review', () => {
    const messages = [card('so-1', 'Sonnet')];
    const next = applySecondOpinion(messages, { id: 'so-1', state: 'error', error: 'boom' }, vi.fn())!;
    expect(next[0].text).toBe('');
  });
});

describe('a pending answer opens a card', () => {
  it('reports the open upward and changes nothing itself', () => {
    const open = vi.fn();
    const messages = [agentRow('the work')];

    const next = applySecondOpinion(
      messages,
      { id: 'so-1', state: 'pending', modelId: 'lmstudio/devstral', modelLabel: 'Devstral' },
      open,
    );

    // `undefined` = nothing to assign. Returning the old array here would drop
    // the row `open` is about to append to the session.
    expect(next).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe('Second opinion — Devstral');
    expect(open.mock.calls[0][1]).toEqual({
      secondOpinion: { id: 'so-1', modelId: 'lmstudio/devstral', modelLabel: 'Devstral', state: 'pending' },
    });
  });

  it('treats an unknown state as pending — an older host must still open a card', () => {
    const open = vi.fn();
    applySecondOpinion([], { id: 'so-1', modelId: 'p/m', modelLabel: 'M' }, open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('labels the card by its id when the host sent no display name', () => {
    const open = vi.fn();
    applySecondOpinion([], { id: 'so-1', state: 'pending', modelId: 'lmstudio/devstral' }, open);
    expect(open.mock.calls[0][0]).toBe('Second opinion — lmstudio/devstral');
  });
});

describe('answers with nowhere to go', () => {
  it('DROPS an answer whose id matches no card, rather than appending one', () => {
    // The post-reload state: the transcript is restored, the pending card is
    // not. Appending here would put a review with no question above it into the
    // scrollback.
    const open = vi.fn();
    const messages = [agentRow('the work')];
    expect(applySecondOpinion(messages, answer('so-ghost', 'orphan'), open)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores a message carrying no id at all', () => {
    const open = vi.fn();
    expect(applySecondOpinion([card('so-1', 'S')], { state: 'ok', text: 'x' }, open)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it('never fills a row of another kind that happens to sit in the list', () => {
    const messages = [agentRow('the work'), card('so-1', 'Sonnet')];
    const next = applySecondOpinion(messages, answer('so-1', 'reviewed'), vi.fn())!;
    expect(next[0].kind).toBe('agent');
    expect(next[0].text).toBe('the work');
  });
});
