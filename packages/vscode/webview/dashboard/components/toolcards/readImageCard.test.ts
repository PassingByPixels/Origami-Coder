// readImageCard.test.ts — t-d93nqh: what a `read` of an image LOOKS like in the
// chat, in jsdom. Structure only; the size of the picture on screen is a
// max-height in the component's <style>, which no test DOM ever loads (see
// docs/WORKING_ON_ORIGAMI_CODER.md Part 6) — that stays with a human eye.
//
// The `readImage` fixtures are what src/dashboard/toolImageCard.ts stamps: the
// desktop shape carries `src` (a vscode-resource URI), the phone shape carries
// only path/mime/bytes.

import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ReadFileCard from './ReadFileCard.svelte';
import ToolCard from '../ToolCard.svelte';

const PNG = 'C:\\Users\\a\\AppData\\Local\\Temp\\origami\\mia\\mouth_e26_front_26deg.png';
const SRC = 'https://file%2B.vscode-resource.vscode-cdn.net/c%3A/Users/a/AppData/Local/Temp/origami/mia/mouth_e26_front_26deg.png';
const THUMB = 'data:image/jpeg;base64,AAAA';
const DESKTOP = { path: PNG, mime: 'image/png', bytes: 1_800_000, src: SRC };
const PHONE = { path: PNG, mime: 'image/png', bytes: 1_800_000 };
const PHONE_WITH_THUMB = { path: PNG, mime: 'image/png', bytes: 1_800_000, thumb: THUMB };

describe('ReadFileCard — the picture the model read', () => {
  it('renders an img from the webview resource URI, never base64', () => {
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(SRC);
    expect(img.getAttribute('src')?.startsWith('data:')).toBe(false);
    expect(img.getAttribute('alt')).toContain('mouth_e26_front_26deg.png');
  });

  // t-fh57s9 — the card's own Show/Hide image button is gone: the picture is
  // the body, and ToolCard's header pill is the single toggle. The picture
  // renders with no control of its own next to it.
  it('has no Show/Hide image control of its own', () => {
    const { container } = render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(container.querySelector('.readfile-toggle')).toBeNull();
    expect(screen.queryByText(/Hide image/)).toBeNull();
    expect(screen.queryByText(/Show image/)).toBeNull();
  });

  // t-l1sovi — the picture now lighthouses (the shared lightbox) instead of
  // opening the file; t-mdjavm moves "open in the editor" to the path link.
  it('clicking the picture reports it to the lightbox handler, not the editor', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const onImageClick = vi.fn();
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP, onImageClick });
    await fireEvent.click(screen.getByRole('img'));
    expect(onImageClick).toHaveBeenCalledWith(SRC, expect.stringContaining(PNG));
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
  });

  // t-qmzegs item 5 — the fallback and the path link now REVEAL the file in
  // the OS explorer instead of opening an editor tab on it (CHANGES.md 46:
  // "it does not open an editor tab"). The guard is unchanged in substance:
  // the control must still act on the real file, and must still be absent on a
  // surface that has none.
  it('falls back to revealing the file when no lightbox handler is wired up', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    await fireEvent.click(screen.getByRole('img'));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'revealInExplorer', path: PNG });
  });

  it('t-mdjavm — the path text under the picture is a link that reveals the file', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ReadFileCard, { result: 'Image read successfully', readImage: DESKTOP });
    const link = screen.getByText(PNG);
    expect(link.tagName).toBe('BUTTON');
    await fireEvent.click(link);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'revealInExplorer', path: PNG });
  });

  it('t-mdjavm — phone/remote (no src, only thumb): the path renders as plain text, not a link', () => {
    render(ReadFileCard, { result: 'Image read successfully', readImage: PHONE_WITH_THUMB });
    const pathEl = screen.getByText(PNG);
    expect(pathEl.tagName).not.toBe('BUTTON');
  });

  it('prints the size and click-to-reveal when neither src nor thumb could be made', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ReadFileCard, { result: 'Image read successfully', readImage: PHONE });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/image \(1758 KB\)/)).toBeInTheDocument();
    expect(screen.getByText(/click to reveal/)).toBeInTheDocument();
    // t-fdw2j2: the desktop must never print this — the surface that hit this
    // branch may not even be the desktop.
    expect(screen.queryByText(/open on the desktop/)).toBeNull();
    await fireEvent.click(screen.getByText(/click to reveal/));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'revealInExplorer', path: PNG });
  });

  it('renders the phone thumbnail when src is absent but thumb was made', () => {
    render(ReadFileCard, { result: 'Image read successfully', readImage: PHONE_WITH_THUMB });
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(THUMB);
    expect(screen.queryByText(/open on the desktop/)).toBeNull();
  });

  it('a text read is untouched: no img, no toggle, the file body as before', () => {
    render(ReadFileCard, { result: '1: const a = 1;' });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/image/i)).toBeNull();
    expect(screen.getByText(/const a = 1;/)).toBeInTheDocument();
  });
});

describe('ToolCard — a read-image card has a body worth expanding', () => {
  // t-ffk0qi — "reading image should be the only one where it's not auto
  // collapsed; it should show the 'read image' header and then show the
  // image, there is no point hiding the image in the collapse." Unlike a
  // plain read (below), this card renders open with no click at all.
  it('renders open — header + picture — with no click, unlike every other read', () => {
    render(ToolCard, {
      title: 'mouth_e26_front_26deg.png',
      kind: 'read',
      toolName: 'read',
      status: 'completed',
      result: 'Image read successfully',
      path: PNG,
      readImage: DESKTOP,
    });
    expect(screen.getByText('mouth_e26_front_26deg.png')).toBeInTheDocument();
    expect((screen.getByRole('img') as HTMLImageElement).getAttribute('src')).toBe(SRC);
  });

  it('stays open through a rerender — no re-collapse once mounted', async () => {
    const { rerender } = render(ToolCard, {
      title: 'mouth_e26_front_26deg.png',
      kind: 'read',
      toolName: 'read',
      status: 'completed',
      result: 'Image read successfully',
      path: PNG,
      readImage: DESKTOP,
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
    await rerender({
      title: 'mouth_e26_front_26deg.png',
      kind: 'read',
      toolName: 'read',
      status: 'completed',
      result: 'Image read successfully',
      path: PNG,
      readImage: DESKTOP,
    });
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  // t-fh57s9 — the live-stream case the construction-time seed cannot cover:
  // the card is created when the call STARTS (no rider yet) and the host
  // stamps `readImage` on a later update into the SAME row, so the same
  // component instance just gets new props.
  it('opens by itself when the picture arrives on a later update, and respects a user collapse', async () => {
    const base = {
      title: 'mouth_e26_front_26deg.png',
      kind: 'read',
      toolName: 'read',
      status: 'in_progress',
      path: PNG,
    };
    const { rerender } = render(ToolCard, base);
    expect(screen.queryByRole('img')).toBeNull();

    // The picture lands on the completing update: the card opens with no click.
    const withPicture = { ...base, status: 'completed', result: 'Image read successfully', readImage: DESKTOP };
    await rerender(withPicture);
    expect(screen.getByRole('img')).toBeInTheDocument();

    // The owner collapses it from the header pill...
    await fireEvent.click(screen.getByText('mouth_e26_front_26deg.png'));
    expect(screen.queryByRole('img')).toBeNull();

    // ...and a further update carrying the same picture must NOT re-open it.
    await rerender({ ...withPicture });
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('a read with no picture keeps its old body: starts collapsed, opens on click', async () => {
    render(ToolCard, { title: 'a.ts', kind: 'read', toolName: 'read', status: 'completed', result: '1: const a = 1;' });
    expect(screen.queryByText(/const a = 1;/)).toBeNull(); // text reads keep today's behaviour: starts collapsed
    await fireEvent.click(screen.getByText('a.ts'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/const a = 1;/)).toBeInTheDocument();
  });
});
