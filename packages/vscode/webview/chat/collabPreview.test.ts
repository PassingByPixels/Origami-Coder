// The C14 composer preview's DRIVER and its wording (report 2.5 / F8).
//
// The preview is the one wire call this product makes while a human is still
// typing, so the two properties that keep it honest are asserted here rather
// than through a render:
//
//   1. IT COSTS NOTHING TO TYPE. `collab_preview` is token-free by construction
//      (the wake rules read a message's address list, never its prose — see
//      ACPCollab.preview), but a call PER KEYSTROKE would still be a round trip
//      per keystroke. So: debounced, and skipped entirely when the address list
//      has not changed. Typing a paragraph with no `@` in it must produce
//      exactly ONE call, not one per word.
//   2. IT NEVER GATES SEND. The driver owns a timer and nothing else — it has
//      no acknowledgement, no in-flight flag, and no way to refuse. That is the
//      structural reason a pending preview cannot hold a message back, and the
//      last test here is what would fail if a flag were ever added.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PREVIEW_DEBOUNCE_MS, makeCollabPreview, previewText } from './collabPreview';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function driver() {
  const sent: string[][] = [];
  const preview = makeCollabPreview({ request: (mentions) => sent.push(mentions) });
  return { preview, sent };
}

describe('makeCollabPreview — the debounce', () => {
  it('asks once for a burst of keystrokes, after the draft settles', () => {
    const { preview, sent } = driver();
    preview.draft('@cr');
    preview.draft('@cra');
    preview.draft('@crane');
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([['crane']]);
  });

  it('asks for the FINAL address list, not the one that started the burst', () => {
    const { preview, sent } = driver();
    preview.draft('@crane');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    preview.draft('@crane and @heron');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([['crane'], ['crane', 'heron']]);
  });

  it('makes ZERO further calls while the draft gains no new address', () => {
    const { preview, sent } = driver();
    preview.draft('shall we');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([[]]);

    // The whole rest of a paragraph, none of it addressed to anyone.
    for (const text of ['shall we ship', 'shall we ship the', 'shall we ship the map?']) {
      preview.draft(text);
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    }
    expect(sent).toEqual([[]]);
  });

  it('asks again when an address is removed, not only when one is added', () => {
    const { preview, sent } = driver();
    preview.draft('@crane @heron');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    preview.draft('@crane');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([['crane', 'heron'], ['crane']]);
  });

  // Order is the wake ORDER the engine answers in, so `@heron @crane` is a
  // different question from `@crane @heron` and must be asked.
  it('treats a re-ordered address list as a new question', () => {
    const { preview, sent } = driver();
    preview.draft('@crane @heron');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    preview.draft('@heron @crane');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([['crane', 'heron'], ['heron', 'crane']]);
  });

  // Sending clears the composer, so the NEXT draft that happens to name the
  // same agent is a real question again — the answer it would reuse was about
  // a message that has already gone.
  it('re-asks after a send reset', () => {
    const { preview, sent } = driver();
    preview.draft('@crane');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    preview.reset();
    preview.draft('@crane');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(sent).toEqual([['crane'], ['crane']]);
  });

  it('makes no call at all after stop(), so a torn-down pane cannot post', () => {
    const { preview, sent } = driver();
    preview.draft('@crane');
    preview.stop();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 4);
    expect(sent).toEqual([]);
  });

  // The structural non-gating proof: the driver exposes NO state a sender could
  // consult. If a `pending`/`inFlight` flag is ever added, this fails.
  it('exposes nothing a send path could be gated on', () => {
    const { preview } = driver();
    preview.draft('@crane');
    expect(Object.keys(preview).sort()).toEqual(['draft', 'reset', 'stop']);
  });
});

describe('previewText — what the line under the composer says', () => {
  const nameOf = (slug: string) => ({ 'collab-crane': 'Crane', 'collab-heron': 'Heron' })[slug] ?? slug;

  it('names who would take a turn, by display name', () => {
    expect(previewText({ wake: ['collab-crane', 'collab-heron'] }, nameOf))
      .toBe('Will wake: Crane, Heron');
  });

  it('says nobody is home rather than printing an empty list', () => {
    expect(previewText({ wake: [], notice: 'no-lead' }, nameOf))
      .toMatch(/no lead/i);
  });

  // `collab_post` REFUSES a draft naming a slug the room does not have, so a
  // preview that answered a bare "nobody" would describe a message that never
  // gets sent (ACPCollab.preview's own comment).
  it('names an address the room does not have', () => {
    const text = previewText({ wake: [], unknown: ['fox'] }, nameOf);
    expect(text).toContain('fox');
    expect(text).toMatch(/not in this collab/i);
  });

  it('says both halves when some addresses land and others do not', () => {
    const text = previewText({ wake: ['collab-crane'], unknown: ['fox'] }, nameOf);
    expect(text).toContain('Crane');
    expect(text).toContain('fox');
  });

  it('is empty before the first answer, so nothing flickers under an empty box', () => {
    expect(previewText(null, nameOf)).toBe('');
  });
});
