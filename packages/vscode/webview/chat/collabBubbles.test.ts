// Collab IMAGES, end to end, plus the width the bubbles they land in are drawn
// at.
//
// The trap this suite exists for was found by reading the composer, not by
// using it: InputBar's passthrough branch returns BEFORE the image branch, so
// a collab paste would have attached, cleared, and gone nowhere — silently.
// Nothing in the chat's own image tests could catch that, because the chat
// never takes the passthrough branch. So the assertions here follow one
// picture the whole way: attached in the box -> on the `collabPost` payload ->
// drawn in the bubble the poll brings back.
//
// The other rules are about the DRAFT. Attachments are part of it now, so a
// refusal has to keep the text AND the pictures — losing four screenshots to a
// mistyped `/cap` is exactly the punishment the keep-the-draft contract exists
// to prevent.

import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tick } from 'svelte';
import CollabPane from './CollabPane.svelte';

const ID = 'collab-pics';
/** The one-byte payload every pasted fixture carries... */
const BYTES = 'x';
/** ...and what FileReader.readAsDataURL makes of it. The composer sends the
 *  `data:` URL VERBATIM, so this is what has to appear on the wire — writing a
 *  different constant here would pass a test that never checked the bytes. */
const PNG = `data:image/png;base64,${Buffer.from(BYTES).toString('base64')}`;
const here = path.dirname(fileURLToPath(import.meta.url));

// jsdom neither loads images nor fires `onerror` for one, so the composer's
// optional down-scale would hang forever on a real HTMLImageElement. A stub
// that reports a small picture takes the "already small enough" branch, which
// is the branch every fixture here is meant to be on.
class SmallImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 8;
  height = 8;
  set src(_v: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

beforeEach(() => {
  (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__ = { id: ID, title: 'Pictures' };
  (globalThis as unknown as { Image: unknown }).Image = SmallImage;
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __ORIGAMI_COLLAB__?: unknown }).__ORIGAMI_COLLAB__;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
const sent = () => posts().filter((p) => p.type === 'collabPost');

const msg = (seq: number, over: Record<string, unknown> = {}) => ({
  seq, authorId: 'user', authorKind: 'human', text: `message ${seq}`,
  createdAt: '2026-08-05T10:00:00.000Z', ...over,
});

const state = (over: Record<string, unknown> = {}) => ({
  type: 'collabStateData',
  collabId: ID,
  sinceSeq: 0,
  collab: { id: ID, title: 'Pictures', createdAt: '', loopBreakerCap: null },
  participants: [{ agentSlug: 'collab-crane', displayName: 'Crane', model: null }],
  messages: [],
  agents: [],
  suspended: false,
  ...over,
});

const thumbs = (c: HTMLElement) => Array.from(c.querySelectorAll('.image-thumb img')) as HTMLImageElement[];

/** Put one image on the composer's clipboard. */
async function firePaste(container: HTMLElement, name: string): Promise<void> {
  const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
  const file = new File([BYTES], name, { type: 'image/png' });
  await fireEvent.paste(box, { clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] } });
}

/**
 * Paste, and WAIT for the attachment to actually land.
 *
 * The intake is asynchronous twice over (FileReader, then the optional
 * down-scale), so waiting a FIXED number of turns is a race — it passed this
 * test alone and dropped the attachment when the whole file ran, which then
 * looked like a composer that silently ignored the picture. Wait on the
 * condition, not on a guess about how many ticks it takes.
 */
async function paste(container: HTMLElement, name = 'shot.png'): Promise<void> {
  const before = thumbs(container).length;
  await firePaste(container, name);
  await waitFor(() => expect(thumbs(container).length).toBe(before + 1));
  await tick();
}

describe('collab images — the composer takes them', () => {
  it('a pasted image attaches and shows in the strip, which a bare composer used to have no room for', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await paste(container);
    expect(thumbs(container)).toHaveLength(1);
    expect(thumbs(container)[0].getAttribute('alt')).toBe('shot.png');
  });

  // The regression that would be silent: the chat composer must not START
  // taking images differently, and a bare composer that was NOT given
  // allowImages must not start taking them at all.
  it('a bare composer WITHOUT allowImages still takes none', async () => {
    const InputBar = (await import('../dashboard/components/InputBar.svelte')).default;
    const { container } = render(InputBar, {
      props: { bare: true, passthroughSlash: true, inFlight: false, agentName: '', modelName: '', onSend: () => true, onCancel: () => {} },
    });
    // Not `paste()`: nothing will ever land here, so there is no condition to
    // wait on. Give the intake more than enough room and assert it stayed away.
    await firePaste(container, 'shot.png');
    await new Promise((r) => setTimeout(r, 50));
    await tick();
    expect(thumbs(container)).toHaveLength(0);
  });
});

describe('collab images — they reach the wire', () => {
  // THE TRAP. The passthrough branch returns before the chat's image branch, so
  // without this hand-off the picture is attached, cleared and dropped.
  it('the post carries the attachment as a data URL, with the text', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await paste(container);

    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'look at this' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(sent().at(-1)).toEqual({ type: 'collabPost', collabId: ID, text: 'look at this', images: [PNG] });
    // ...and the composer cleared BOTH halves of the draft.
    expect(box.value).toBe('');
    expect(thumbs(container)).toHaveLength(0);
  });

  it('an image with no words is still a message — it sends on its own', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await paste(container);
    await fireEvent.keyDown(container.querySelector('textarea.input') as HTMLTextAreaElement, { key: 'Enter' });
    expect(sent().at(-1)).toEqual({ type: 'collabPost', collabId: ID, text: '', images: [PNG] });
  });

  // An ordinary post must keep TODAY'S exact wire shape — an empty array would
  // read as "sent with no pictures on purpose", a claim the message never made.
  it('a message with nothing attached carries no images field at all', async () => {
    const { container } = render(CollabPane);
    await post(state());
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'just words' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(sent().at(-1)).toEqual({ type: 'collabPost', collabId: ID, text: 'just words' });
  });
});

describe('collab images — a refusal keeps the WHOLE draft', () => {
  it('a slash command with an image attached is refused, and both survive', async () => {
    const { container } = render(CollabPane);
    await post(state());
    await paste(container);

    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: '/cap 20' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    // Nothing was posted — not the command, and not the picture.
    expect(posts().filter((p) => p.type === 'collabSetCap')).toEqual([]);
    expect(sent()).toEqual([]);
    // The user is told why, and gets to keep what they had.
    expect(container.querySelector('.error-banner')!.textContent).toContain('ordinary message');
    expect(box.value).toBe('/cap 20');
    expect(thumbs(container)).toHaveLength(1);
  });

  // The engine refuses a 5th image too, but its answer arrives a round trip
  // later — by which time the composer has cleared. Mirrored client-side, the
  // draft survives the mistake.
  it('a 5th image is refused BEFORE the send, so the message is not lost to a round trip', async () => {
    const { container } = render(CollabPane);
    await post(state());
    for (let i = 0; i < 5; i++) await paste(container, `shot-${i}.png`);
    expect(thumbs(container)).toHaveLength(5);

    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'five of them' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(sent()).toEqual([]);
    expect(container.querySelector('.error-banner')!.textContent).toContain('at most 4 images');
    expect(box.value).toBe('five of them');
    expect(thumbs(container)).toHaveLength(5);

    // Drop one and it goes.
    await fireEvent.click(container.querySelectorAll('.image-remove')[0] as HTMLButtonElement);
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(sent().at(-1)!.images).toHaveLength(4);
  });
});

describe('collab images — they draw in the bubble', () => {
  it('a message carrying images renders one thumbnail each, under its text', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1, { text: 'here it is', images: [PNG, PNG] })] }));

    const bubble = container.querySelector('.cs-msg') as HTMLElement;
    const shown = Array.from(bubble.querySelectorAll('.cs-image')) as HTMLImageElement[];
    expect(shown).toHaveLength(2);
    expect(shown[0].getAttribute('src')).toBe(PNG);
    // The text is still there, and the pictures come after it.
    expect(bubble.querySelector('.msg-text')!.textContent).toContain('here it is');
    expect(bubble.querySelector('.msg-text')!.compareDocumentPosition(shown[0]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  // Every message before this one, and every agent message, carries no `images`
  // key at all. None of them may grow an empty row.
  it('a message with no images draws no strip — an absent key is not an empty gallery', async () => {
    const { container } = render(CollabPane);
    await post(state({ messages: [msg(1), msg(2, { images: [] })] }));
    expect(container.querySelectorAll('.cs-msg')).toHaveLength(2);
    expect(container.querySelectorAll('.cs-images')).toHaveLength(0);
  });
});

// The bubbles' WIDTH is a CSS fact, and jsdom applies no cascade worth trusting
// — so it is pinned at the source, the same way the theme rule in
// architecture.test.ts is. Two numbers in two files have to agree: the SPEAKER'S
// RUN and the live pill that stands in the slot one of them becomes. The run
// moved to CollabGroupRow.svelte at W5-L2 when the stream became a router over
// row kinds; the rule it carries did not change, only the file it lives in.
describe('collab bubbles — the width', () => {
  const groupWidth = (rel: string): number => {
    const src = readFileSync(path.join(here, rel), 'utf8');
    const rule = /\.cs-group\s*\{[^}]*?max-width:\s*(\d+(?:\.\d+)?)%/.exec(src);
    expect(rule, `${rel} has no .cs-group max-width`).not.toBeNull();
    return Number(rule![1]);
  };

  it('reaches toward the pane edges — a collab bubble carries code, not chat one-liners', () => {
    expect(groupWidth('CollabGroupRow.svelte')).toBeGreaterThanOrEqual(92);
  });

  it('...but is still capped below full width, so left and right stay tellable apart', () => {
    expect(groupWidth('CollabGroupRow.svelte')).toBeLessThan(100);
  });

  it('the live pill matches the stream exactly — a pill must not be narrower than the bubble it becomes', () => {
    expect(groupWidth('CollabLivePill.svelte')).toBe(groupWidth('CollabGroupRow.svelte'));
  });
});
