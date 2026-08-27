// Clickable-path chain tests (Wave 1b regression). These exercise the FULL
// runtime chain a real click travels: linkifyPaths -> {@html} render ->
// the row's click handler -> vscode.postMessage({type:'openAbsoluteFile'}).
// A green test here means a user clicking a path in a message opens the file;
// a red one localises the break (link not rendered vs click not delivered).

import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import MessageRow from './MessageRow.svelte';

const post = () => globalThis.__vscodeApiMock.postMessage;

describe('MessageRow — clickable file paths', () => {
  beforeEach(() => post().mockReset());

  it('a bare prose path:line renders a link whose click posts openAbsoluteFile', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: 'See packages/engine/src/agent/agent.ts:109 for details',
    });
    const link = container.querySelector('a.file-link') as HTMLElement | null;
    expect(link, 'a .file-link should be rendered for a prose path').not.toBeNull();
    expect(link!.dataset.path).toBe('packages/engine/src/agent/agent.ts');

    await fireEvent.click(link!);
    expect(post()).toHaveBeenCalledWith({
      type: 'openAbsoluteFile',
      path: 'packages/engine/src/agent/agent.ts',
      line: 109,
    });
  });

  it('an inline-code path:line (single backticks) is clickable and opens the file', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: 'The bug is in `src/foo.ts:78` — fix it.',
    });
    const link = container.querySelector('a.file-link') as HTMLElement | null;
    expect(link, 'a .file-link should be rendered for an inline-code path').not.toBeNull();

    await fireEvent.click(link!);
    expect(post()).toHaveBeenCalledWith({
      type: 'openAbsoluteFile',
      path: 'src/foo.ts',
      line: 78,
    });
  });

  it('a path inside a fenced ``` code block is NOT linkified (stays literal)', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: 'Example:\n\n```ts\nimport x from "src/foo.ts";\n```\n',
    });
    // The highlighted block wraps the path in <pre><code> — no link inside it.
    const pre = container.querySelector('pre');
    expect(pre, 'a fenced block should render a <pre>').not.toBeNull();
    expect(pre!.querySelector('a.file-link')).toBeNull();
  });
});

// An attached image in the transcript opens enlarged. The click travels the
// SAME row-level handler as the file links above, which is the whole reason
// these live here: the row's branches are all `closest()` lookups over one
// event, so the risk is not "does the handler fire" but "does the wrong branch
// claim the click". Both directions are asserted.
describe('MessageRow — attached images open enlarged', () => {
  const IMG = 'data:image/png;base64,AAAA';
  beforeEach(() => post().mockReset());

  it('a click on an attached image reports its src and alt to the parent', async () => {
    const onImageClick = vi.fn();
    const { container } = render(MessageRow, {
      kind: 'user', label: 'You', text: 'look at this', images: [IMG], onImageClick,
    });
    const img = container.querySelector('img.chat-image') as HTMLImageElement;
    expect(img, 'an attached image should render').not.toBeNull();

    await fireEvent.click(img);
    expect(onImageClick).toHaveBeenCalledWith(IMG, 'attached image');
  });

  it('marks the image zoomable so the cursor can promise the zoom', () => {
    const { container } = render(MessageRow, {
      kind: 'user', label: 'You', text: '', images: [IMG], onImageClick: vi.fn(),
    });
    expect(container.querySelector('img.chat-image')!.classList.contains('zoomable')).toBe(true);
  });

  // TaskCard / TaskParallelCard mount this row with no lightbox above them.
  it('is inert, and shows no zoom affordance, when no handler was given', async () => {
    const { container } = render(MessageRow, {
      kind: 'user', label: 'You', text: '', images: [IMG],
    });
    const img = container.querySelector('img.chat-image')!;
    expect(img.classList.contains('zoomable')).toBe(false);
    await expect(fireEvent.click(img)).resolves.not.toThrow();
  });

  // The collision case: the row's file-link branch must not swallow the image
  // click, and the image branch must not swallow a link click.
  it('does not confuse an image click with the file-link branch, or the reverse', async () => {
    const onImageClick = vi.fn();
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'see src/foo.ts:78', images: [IMG], onImageClick,
    });
    await fireEvent.click(container.querySelector('img.chat-image')!);
    expect(onImageClick).toHaveBeenCalledTimes(1);
    expect(post()).not.toHaveBeenCalled();

    onImageClick.mockClear();
    await fireEvent.click(container.querySelector('a.file-link')!);
    expect(onImageClick).not.toHaveBeenCalled();
    expect(post()).toHaveBeenCalledWith({
      type: 'openAbsoluteFile', path: 'src/foo.ts', line: 78,
    });
  });
});
