// t-qmzegs item 5 — a read-image card draws at the image's own size, capped by
// the PANE, and a card's path reveals the file in the OS explorer.
//
// The `readImage` fixtures are the shapes src/dashboard/toolImageCard.ts
// actually stamps — derived from that module, not invented — because a fixture
// invented here would prove only that this file agrees with itself.
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ReadFileCard from './ReadFileCard.svelte';
import ToolCard from '../ToolCard.svelte';
import { CARD_CHROME_PX, MIN_IMAGE_PX, imageCapPx, scrollParentOf } from './readImageFit';

const here = path.dirname(fileURLToPath(import.meta.url));
const PNG = 'C:\\Users\\a\\AppData\\Local\\Temp\\origami\\mia\\mouth.png';
const SRC = 'https://file%2B.vscode-resource.vscode-cdn.net/c%3A/mouth.png';
const DESKTOP = { path: PNG, mime: 'image/png', bytes: 1_800_000, src: SRC };
// The phone gets `thumb` and never `src` (readImageThumb.ts attaches the capped
// JPEG after the desktop stamp runs), so it DRAWS a picture but has no local
// file behind it — which is precisely the case the reveal control must not offer.
const PHONE = { path: PNG, mime: 'image/png', bytes: 1_800_000, thumb: 'data:image/jpeg;base64,AAAA' };

const posts = () => globalThis.__vscodeApiMock.postMessage;
beforeEach(() => posts().mockClear());
afterEach(cleanup);

describe('change 45 — the picture is capped by the pane, not by a 200px window', () => {
  it('the read-image card opts the result out of the clamp and the scroll box', () => {
    // The clamp is real and still right for every OTHER body: this asserts the
    // opt-out exists for the one card whose body IS the answer.
    const src = readFileSync(path.join(here, '..', 'ToolCard.svelte'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/class:image=\{!!readImage\}/);
    expect(src).toMatch(/\.tool-result\.chart,\n  \.tool-result\.image \{\n    max-height: none;\n    overflow: visible;/);
  });

  it('the image is bounded by --readimg-cap, with a fallback only for a card outside a pane', () => {
    const src = readFileSync(path.join(here, 'ReadFileCard.svelte'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/max-height: var\(--readimg-cap, 60vh\)/);
    expect(src).not.toMatch(/max-height: 240px/);
  });

  it('the cap is the pane height less the card\'s own chrome', () => {
    expect(imageCapPx(800)).toBe(800 - CARD_CHROME_PX);
  });

  it('a collapsed or mid-resize pane never shrinks the picture to nothing', () => {
    // A transcript in a collapsed multi-up cell reports a few pixels; an image
    // capped to that is not a smaller picture, it is no picture.
    expect(imageCapPx(10)).toBe(MIN_IMAGE_PX);
    expect(imageCapPx(0)).toBe(MIN_IMAGE_PX);
    expect(imageCapPx(Number.NaN)).toBe(MIN_IMAGE_PX);
  });

  it('finds the nearest SCROLLING ancestor, not merely the parent', () => {
    // The card is mounted several levels inside the scroller, and the sub-agent
    // transcript mounts the same card somewhere else again — so the walk must
    // find the pane by behaviour, never by a class name.
    const outer = document.createElement('div');
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const inner = document.createElement('div');
    const img = document.createElement('img');
    outer.append(scroller); scroller.append(inner); inner.append(img);
    document.body.append(outer);
    expect(scrollParentOf(img)).toBe(scroller);
    expect(scrollParentOf(scroller)).toBeNull();
    outer.remove();
  });
});

describe('change 46 — a path reveals the file in the OS explorer', () => {
  it('the header path posts revealInExplorer, not an editor open', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts',
    });
    fireEvent.click(container.querySelector('.tool-path') as HTMLElement);
    expect(posts()).toHaveBeenCalledWith({ type: 'revealInExplorer', path: 'src/tool/read.ts' });
    expect(posts()).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'openAbsoluteFile' }));
  });

  it('the click does not also fold the card — stopPropagation, or the path closes what it points into', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts',
    });
    fireEvent.click(container.querySelector('.tool-path') as HTMLElement);
    expect(container.querySelector('.expand-arrow.open')).toBeNull();
  });

  // t-vikozs: .tool-path is `direction: rtl` (ellipsis at the front). Without an LTR
  // isolate the bidi algorithm draws "/home/u/x.ts" as "home/u/x.ts/".
  it('a POSIX path sits in an LTR isolate, so its leading slash stays first', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: '/home/u/x.ts',
    });
    expect(container.querySelector('.tool-path bdi[dir="ltr"]')?.textContent).toBe('/home/u/x.ts');
  });

  it('the path is reachable from the keyboard', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts',
    });
    const el = container.querySelector('.tool-path') as HTMLElement;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(posts()).toHaveBeenCalledWith({ type: 'revealInExplorer', path: 'src/tool/read.ts' });
  });

  it('the image card carries a SPELLED-OUT reveal control as well as the path', () => {
    // On this card the header's path is small and a long way from the picture.
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    const button = screen.getByText(/Reveal in explorer/);
    fireEvent.click(button);
    expect(posts()).toHaveBeenCalledWith({ type: 'revealInExplorer', path: PNG });
  });

  it('the path under the picture reveals too', () => {
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    fireEvent.click(screen.getByText(PNG));
    expect(posts()).toHaveBeenCalledWith({ type: 'revealInExplorer', path: PNG });
  });

  it('the RANGE opens the file in the editor at its start line — two controls, two jobs', () => {
    // The owner's ruling on this port: the path reveals the FOLDER, and the
    // range keeps the editor jump it has always had. Losing the jump was a real
    // capability lost, so the range stopped being an inert label and became the
    // control that carries it.
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts', toolLines: { start: 26, end: 61 },
    });
    fireEvent.click(container.querySelector('.tool-lines') as HTMLElement);
    expect(posts()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'src/tool/read.ts', line: 26 });
  });

  it('ONE click fires ONE control — the range never also reveals, the path never also opens', () => {
    // The two sit side by side in the same header. If either let its click
    // bubble, one click would do both jobs at once — an editor tab AND an
    // explorer window — and the reader could not tell which control they hit.
    const props = {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts', toolLines: { start: 26, end: 61 },
    };
    const { container } = render(ToolCard, props);

    fireEvent.click(container.querySelector('.tool-lines') as HTMLElement);
    expect(posts().mock.calls.map((c) => c[0].type)).toEqual(['openAbsoluteFile']);

    posts().mockClear();
    fireEvent.click(container.querySelector('.tool-path') as HTMLElement);
    expect(posts().mock.calls.map((c) => c[0].type)).toEqual(['revealInExplorer']);
  });

  it('neither control folds the card — a click on what a card points at must not close it', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts', toolLines: { start: 26, end: 61 },
    });
    fireEvent.click(container.querySelector('.tool-lines') as HTMLElement);
    expect(container.querySelector('.expand-arrow.open')).toBeNull();
  });

  it('the range is reachable from the keyboard, like the path beside it', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts', toolLines: { start: 26, end: 61 },
    });
    const el = container.querySelector('.tool-lines') as HTMLElement;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(posts()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'src/tool/read.ts', line: 26 });
  });

  it('a card with NO range shows no range control at all', () => {
    const { container } = render(ToolCard, {
      title: 'read', kind: 'read', toolName: 'read', status: 'completed',
      result: 'body', path: 'src/tool/read.ts',
    });
    expect(container.querySelector('.tool-lines')).toBeNull();
  });

  it('a PHONE card offers neither control — there is no explorer on the other end', () => {
    // The shape with no `src` is what toolImageCard.ts stamps for a surface
    // that cannot load a local file. The wire refuses the verb as well
    // (remoteRefusalsTable.ts); this is the half the user can see.
    const { container } = render(ReadFileCard, { result: 'Image read successfully', readImage: PHONE });
    expect(container.querySelector('.readfile-reveal')).toBeNull();
    expect(container.querySelector('.readfile-path-link')).toBeNull();
    expect(container.querySelector('.readfile-path-text')?.textContent).toBe(PNG);
  });
});
