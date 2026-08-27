// The C14 composer preview, in the room (W3 wave 3, report 2.5 / F8).
//
// "Nothing previews what a message will do before you send it" is the report's
// cheapest large win, and the reason it is cheap is that rule evaluation is
// declarative and token-free. That makes the risk of building it a DIFFERENT
// one: a live wire call on a keystroke path is where a composer gets slow, or
// worse, where a send starts waiting on something it never needed.
//
// So the three claims asserted here are all about restraint:
//
//   1. ONE CALL PER QUESTION, not one per keystroke — and none at all while
//      the draft's address list has not moved.
//   2. SEND IS NEVER GATED. A message posts while a preview is still pending,
//      and posts when no preview was ever answered.
//   3. A PREVIEW FOR ANOTHER COLLAB IS DROPPED. `post` fans every reply out to
//      every attached webview, so two rooms open at once both receive both
//      previews.

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import CollabComposer from './CollabComposer.svelte';
import { PREVIEW_DEBOUNCE_MS } from './collabPreview';

const ID = 'collab-1';
const ROSTER = [
  { slug: 'collab-crane', name: 'Crane' },
  { slug: 'collab-heron', name: 'Heron' },
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

function mount(over: Record<string, unknown> = {}) {
  const sent: string[] = [];
  render(CollabComposer, {
    props: {
      collabId: ID,
      archived: false,
      roster: ROSTER,
      canExport: false,
      onSend: (text: string) => { sent.push(text); return true; },
      onExport: () => {},
      ...over,
    },
  });
  return { sent };
}

const box = (): HTMLTextAreaElement => screen.getByRole('textbox') as HTMLTextAreaElement;

async function type(text: string): Promise<void> {
  await fireEvent.input(box(), { target: { value: text } });
}

function previews(): Array<Record<string, unknown>> {
  return globalThis.__vscodeApiMock.postMessage.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((p) => p.type === 'collabPreview');
}

async function answer(data: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'collabPreviewData', collabId: ID, ...data } }));
  await tick();
}

describe('CollabComposer — asking who a draft would wake', () => {
  it('asks once for a burst of keystrokes, with the settled address list', async () => {
    vi.useFakeTimers();
    mount();
    await type('@collab-cr');
    await type('@collab-crane');
    expect(previews()).toEqual([]);

    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    await tick();
    expect(previews()).toEqual([{ type: 'collabPreview', collabId: ID, mentions: ['collab-crane'] }]);
  });

  // The debounce claim that matters for cost: prose is most of a draft, and
  // none of it changes the answer, because the wake rules never read prose.
  it('makes ZERO further calls while the draft names nobody new', async () => {
    vi.useFakeTimers();
    mount();
    for (const text of ['shall', 'shall we', 'shall we ship', 'shall we ship the map?']) {
      await type(text);
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
      await tick();
    }
    // Exactly one: the unaddressed draft is a real question about the LEAD.
    expect(previews()).toHaveLength(1);
    expect(previews()[0]).not.toHaveProperty('mentions');
  });

  // The wrapper hears every bubbled `input`, and the composer's textarea is the
  // only draft in it. Anything else that grows one later (a search box, a file
  // field) would otherwise drive the preview off text that is not a message.
  it('ignores an input event that did not come from the draft box', async () => {
    vi.useFakeTimers();
    mount();
    const wrapper = box().closest('.cc-box')!;
    const other = document.createElement('input');
    other.value = '@collab-crane';
    wrapper.appendChild(other);
    await fireEvent.input(other, { target: { value: '@collab-crane' } });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    await tick();
    expect(previews()).toEqual([]);
  });

  it('sends an address the roster does not have, so the engine can name it', async () => {
    vi.useFakeTimers();
    mount();
    await type('@fox where are you');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    await tick();
    expect(previews()[0]).toMatchObject({ mentions: ['fox'] });
  });
});

describe('CollabComposer — the line under the box', () => {
  it('names who would answer, by display name', async () => {
    mount();
    await answer({ wake: ['collab-crane', 'collab-heron'] });
    expect(screen.getByText('Will wake: Crane, Heron')).toBeInTheDocument();
  });

  it('warns that a draft would reach nobody', async () => {
    mount();
    await answer({ wake: [], notice: 'no-lead' });
    expect(screen.getByText(/no lead/i)).toBeInTheDocument();
  });

  it('names an address the room does not have', async () => {
    mount();
    await answer({ wake: [], unknown: ['fox'] });
    expect(screen.getByText(/@fox/)).toBeInTheDocument();
  });

  // `post` reaches every attached webview, so the OTHER room's preview arrives
  // here too. Painting it would tell this room who a message it never saw
  // would wake.
  it('drops a preview answered for another collab', async () => {
    mount();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'collabPreviewData', collabId: 'collab-2', wake: ['collab-heron'] },
    }));
    await tick();
    expect(screen.queryByText(/Will wake/)).toBeNull();
  });

  it('says nothing at all before the first answer', () => {
    mount();
    expect(screen.queryByText(/Will wake/)).toBeNull();
  });
});

describe('CollabComposer — send is never gated on a preview', () => {
  it('posts while a preview is still pending', async () => {
    vi.useFakeTimers();
    const { sent } = mount();
    await type('@collab-crane ship it');
    // The debounce has NOT fired: no preview has even been asked for yet.
    expect(previews()).toEqual([]);
    await fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual(['@collab-crane ship it']);
  });

  it('posts when no preview was ever answered', async () => {
    const { sent } = mount();
    await type('just send it');
    await fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent).toEqual(['just send it']);
  });

  // The composer clears on a send, so the stale line would describe a message
  // that has already gone.
  it('clears the line once the message has gone', async () => {
    mount();
    await answer({ wake: ['collab-crane'] });
    expect(screen.getByText(/Will wake/)).toBeInTheDocument();
    await type('@collab-crane ship it');
    await fireEvent.keyDown(box(), { key: 'Enter' });
    await tick();
    expect(screen.queryByText(/Will wake/)).toBeNull();
  });

  // A REFUSED line keeps its draft (InputBar's contract: `false` means the
  // parent refused), so the preview it was showing is still true.
  it('keeps the line when the parent refuses the line', async () => {
    mount({ onSend: () => false });
    await answer({ wake: ['collab-crane'] });
    await type('/nope');
    await fireEvent.keyDown(box(), { key: 'Enter' });
    await tick();
    expect(screen.getByText(/Will wake/)).toBeInTheDocument();
  });
});
