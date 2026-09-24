// SubagentTranscriptFocus.test.ts — t-j50p3r: a sub-agent's IMAGE read draws the
// picture, and the view has the main chat's focus mode.
//
// Its own file rather than more cases in SubagentTranscriptView.test.ts, which a
// second lane is editing at the same time.
//
// The fixture is the wire as the HOST leaves it: `subagentTranscript.ts` projects
// a child's tool step into a replay-log row, and `toolImageStamp.ts` then stamps
// `readImage` onto the RESULT of that row (the same rider the live `toolResult`
// and the `restoreMessages` replay carry). Both halves are exercised here — the
// stamp in readImageWire.test.ts, the draw below — because either one alone
// leaves the picture missing.
//
// jsdom has no layout and this suite loads no <style>, so nothing here asserts
// size or visibility, only which nodes exist.

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentTranscriptView from './SubagentTranscriptView.svelte';

const CHILD = 'ses_child_img';
const post = () => globalThis.__vscodeApiMock.postMessage;
const reply = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', { data }));

/** A child's `read` of a PNG, after the host stamp: no base64 anywhere, a
 *  webview resource URI on the rider, and the engine's `display` block still on
 *  `rawOutputMeta` (which is what makes the row a read-image row at all). */
const IMAGE_READ = {
  kind: 'tool', text: 'shot.png', timestamp: 0,
  tool: {
    call: { toolCallId: 'i1', title: 'shot.png', kind: 'read', status: 'completed', toolName: 'read', path: 'shot.png' },
    result: {
      toolCallId: 'i1', status: 'completed', content: 'Image read successfully', title: 'shot.png',
      path: 'shot.png', toolName: 'read',
      rawOutputMeta: { display: { type: 'image', path: 'C:\\w\\shot.png', mime: 'image/png', bytes: 2048 } },
      readImage: { path: 'C:\\w\\shot.png', mime: 'image/png', bytes: 2048, src: 'https://vscode-resource/shot.png' },
    },
  },
};

const textRead = (id: string, name: string) => ({
  kind: 'tool', text: name, timestamp: 0,
  tool: {
    call: { toolCallId: id, title: name, kind: 'read', status: 'completed', toolName: 'read', path: name },
    result: { toolCallId: id, status: 'completed', content: 'line one', title: name, path: name, toolName: 'read' },
  },
});

function mount(over: Record<string, unknown> = {}) {
  const { container } = render(SubagentTranscriptView, {
    sessionId: CHILD, title: 'task: look at the shot', onClose: () => {}, ...over,
  });
  return container;
}

function draw(c: HTMLElement, entries: unknown[]): Promise<void> {
  reply({ type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, entries });
  return tick();
}

describe('a sub-agent image read draws the picture (t-j50p3r)', () => {
  beforeEach(() => post().mockReset());

  it('renders the read-image card with the picture, never a plain text row', async () => {
    const c = mount();
    await draw(c, [IMAGE_READ]);

    const img = c.querySelector('img.readfile-image') as HTMLImageElement | null;
    expect(img, 'the child’s image read must draw the main chat’s read-image card').not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://vscode-resource/shot.png');
    // The card names the file the same way the main chat's does: the tool-card
    // header carries the path, the picture carries it in alt text for a reader.
    expect(c.querySelector('.tool-card')?.textContent).toContain('shot.png');
    expect(img!.getAttribute('alt')).toContain('shot.png');
    // And the model's base64 copy never reaches the card.
    expect(img!.getAttribute('src')!.startsWith('data:')).toBe(false);
  });

  it('a text read in the same transcript is untouched — a collapsed card, no picture', async () => {
    const c = mount();
    await draw(c, [textRead('t1', 'notes.md')]);
    expect(c.querySelector('img.readfile-image')).toBeNull();
    // A text read opens on a CLICK, so its body is not mounted — which is the
    // difference the image card makes: it is open on arrival (t-ffk0qi).
    expect(c.querySelector('.readfile-card')).toBeNull();
    expect(c.querySelector('.tool-card')?.textContent).toContain('notes.md');
  });
});

describe('the sub-agent view’s focus mode (t-j50p3r)', () => {
  beforeEach(() => post().mockReset());

  it('draws NO eye when the parent gives it no toggle — a dead button is worse', async () => {
    const c = mount();
    await draw(c, [IMAGE_READ]);
    expect(c.querySelector('button.focus-eye')).toBeNull();
  });

  it('focus OFF is the view unchanged: the image card is there and open (t-h4o65t parity)', async () => {
    const c = mount({ focusMode: false, onToggleFocus: () => {} });
    await draw(c, [textRead('t1', 'a.md'), textRead('t2', 'b.md'), IMAGE_READ]);
    expect(c.querySelector('.focus-gap')).toBeNull();
    // All three tool rows stand; only the IMAGE one is open on arrival, which is
    // the main chat's rule outside focus (t-h4o65t / t-ffk0qi).
    expect(c.querySelectorAll('.tool-card')).toHaveLength(3);
    expect(c.querySelectorAll('.readfile-card')).toHaveLength(1);
    expect(c.querySelector('img.readfile-image')).not.toBeNull();
  });

  it('focus ON folds the tool runs into ONE counted gap, the main chat’s own foldForFocus', async () => {
    const c = mount({ focusMode: true, onToggleFocus: () => {} });
    await draw(c, [
      { kind: 'user', text: 'look at the shot', timestamp: 0 },
      textRead('t1', 'a.md'), textRead('t2', 'b.md'), IMAGE_READ,
      { kind: 'agent', text: 'it is the login screen', timestamp: 0 },
    ]);
    const gaps = c.querySelectorAll('.focus-gap');
    expect(gaps).toHaveLength(1);
    // Three reads, the image read among them — the count the MAIN chat reports
    // for the same rows (focusGaps.test.ts, t-h4o65t). This view must not fork
    // a second rule; if the owner reverses that fold again, both views move.
    expect(gaps[0].textContent).toContain('3 file reads');
    expect(c.querySelector('.row.user')?.textContent).toContain('look at the shot');
    expect(c.querySelector('.row.agent')?.textContent).toContain('login screen');
  });

  it('the eye reports the click upward — the flag is the parent cell’s, not this view’s', async () => {
    const onToggleFocus = vi.fn();
    const c = mount({ focusMode: false, onToggleFocus });
    await draw(c, [IMAGE_READ]);
    const eye = c.querySelector('button.focus-eye') as HTMLButtonElement;
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    eye.click();
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
    // It owns no state: still unpressed until the parent passes the new flag.
    expect((c.querySelector('button.focus-eye') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });
});
