// Composer drag-and-drop — dropping a non-image file used to be silently
// swallowed (InputBar.svelte's old `handleDrop` only ever looked at
// `image/*` files). This pins the fix: a `text/uri-list` drop (an in-VS-Code
// drag — Explorer, an editor tab) inserts the real decoded path at the
// caret; an OS file drop with no uri-list inserts the name and attaches its
// content as a text-attachment chip that folds into the outgoing prompt at
// send time; an image drop is completely unchanged either way.

import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import InputBar from './InputBar.svelte';

afterEach(cleanup);
beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });

const SID = 'sess-drop-1';

function mount(props: Record<string, unknown> = {}) {
  return render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onSend: () => {}, onCancel: () => {},
      ...props,
    },
  });
}

/** A minimal stand-in for the DOM `DataTransfer` the component actually
 *  reads from: `getData('text/uri-list')` and `files`. Mirrors the `dt()`
 *  helper in agentManagerPane.test.ts (the existing DnD precedent). */
function makeDataTransfer(opts: { uriList?: string; files?: File[] } = {}) {
  const store: Record<string, string> = {};
  if (opts.uriList !== undefined) store['text/uri-list'] = opts.uriList;
  return {
    getData: (k: string) => store[k] ?? '',
    setData: (k: string, v: string) => { store[k] = v; },
    files: opts.files ?? [],
  };
}

const box = (c: HTMLElement) => c.querySelector('textarea.input') as HTMLTextAreaElement;
const imageErrors = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls
    .map((c: unknown[]) => c[0] as { type: string })
    .filter((m) => m.type === 'imageError');

describe('InputBar — drag-and-drop, uri-list (an in-VS-Code drag)', () => {
  it('a Windows file: URI decodes to a real local path, inserted at the caret with the caret after it', async () => {
    const { container } = mount();
    const b = box(container);
    await fireEvent.input(b, { target: { value: 'look at' } });
    b.setSelectionRange(7, 7); // end of "look at"
    await fireEvent.drop(b, { dataTransfer: makeDataTransfer({ uriList: 'file:///C:/a/b.ts' }) });
    expect(b.value).toBe('look at C:\\a\\b.ts ');
    // Caret placement runs off a setTimeout(0) after the DOM update.
    await new Promise((r) => setTimeout(r, 0));
    expect(b.selectionStart).toBe(b.value.length);
    expect(b.selectionEnd).toBe(b.value.length);
  });

  it('a posix file: URI keeps forward slashes', async () => {
    const { container } = mount();
    const b = box(container);
    await fireEvent.drop(b, { dataTransfer: makeDataTransfer({ uriList: 'file:///home/user/a.ts' }) });
    expect(b.value).toBe(' /home/user/a.ts ');
  });

  it('a non-file URI (e.g. a webview tab) is inserted as the URI text itself', async () => {
    const { container } = mount();
    const b = box(container);
    await fireEvent.drop(b, { dataTransfer: makeDataTransfer({ uriList: 'https://example.com/readme' }) });
    expect(b.value).toBe(' https://example.com/readme ');
  });

  it('multiple lines, comments and blanks: only real URIs are inserted, space-separated', async () => {
    const { container } = mount();
    const b = box(container);
    const list = '# a comment\nfile:///C:/a.txt\n\nfile:///C:/b.txt\n';
    await fireEvent.drop(b, { dataTransfer: makeDataTransfer({ uriList: list }) });
    expect(b.value).toBe(' C:\\a.txt C:\\b.txt ');
  });

  it('a uri-list drop never touches the image path or posts imageError', async () => {
    const { container } = mount();
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ uriList: 'file:///C:/a.png' }) });
    expect(imageErrors()).toEqual([]);
    expect(container.querySelector('.image-thumb')).toBeNull();
  });
});

describe('InputBar — drag-and-drop, image files (must be unchanged)', () => {
  class SmallImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 8;
    height = 8;
    set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  }
  beforeEach(() => { (globalThis as unknown as { Image: unknown }).Image = SmallImage; });

  const thumbs = (c: HTMLElement) => Array.from(c.querySelectorAll('.image-thumb img'));

  it('a .png dropped with no uri-list still attaches as an image, never as text', async () => {
    const { container } = mount();
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(thumbs(container)).toHaveLength(1));
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
    expect(box(container).value).toBe(''); // no filename text inserted for images
  });

  it('a .bmp with an empty MIME (some OS drags omit it) still routes to the image intake, not text', async () => {
    const { container } = mount();
    const file = new File(['x'], 'shot.bmp', { type: '' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await new Promise((r) => setTimeout(r, 20));
    // readComposerImage refuses bmp (not in its ALLOWED_MIME) — the point
    // pinned here is only that it took the IMAGE branch (an imageError), not
    // that it silently became a text attachment.
    expect(imageErrors().length).toBe(1);
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
  });
});

describe('InputBar — drag-and-drop, non-image files (the new path)', () => {
  it('inserts the file name at the caret and adds a chip, with no exception and no imageError', async () => {
    const { container } = mount();
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    expect(() => fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) })).not.toThrow();
    expect(box(container).value).toBe(' notes.txt ');
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    expect(container.querySelector('.text-attachment-chip')!.textContent).toContain('notes.txt');
    expect(imageErrors()).toEqual([]);
  });

  it('works even when imagesOn is false (a bare composer with no allowImages)', async () => {
    const { container } = render(InputBar, {
      props: { bare: true, passthroughSlash: true, inFlight: false, agentName: '', modelName: '', onSend: () => true, onCancel: () => {} },
    });
    const file = new File(['content'], 'a.md', { type: 'text/markdown' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    expect(box(container).value).toBe(' a.md ');
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
  });

  it('an oversize file (>256 KB) is truncated and the chip flags it', async () => {
    const { container } = mount();
    const big = 'x'.repeat(256 * 1024 + 500);
    const file = new File([big], 'huge.log', { type: 'text/plain' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    expect(container.querySelector('.text-attachment-chip')!.textContent).toMatch(/truncated/i);
  });

  it('a file with a NUL byte in its first 8 KB is treated as binary: name only, no chip, no error', async () => {
    const { container } = mount();
    const file = new File(['abc\u0000def'], 'binary.dat', { type: '' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    expect(box(container).value).toBe(' binary.dat ');
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
    expect(imageErrors()).toEqual([]);
  });

  it('a chip can be removed before sending', async () => {
    const { container } = mount();
    const file = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    await fireEvent.click(container.querySelector('.chip-remove') as HTMLButtonElement);
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
  });
});

describe('InputBar — sending folds text attachments into the outgoing prompt', () => {
  it('the normal send path folds the block AFTER the typed text', async () => {
    const seen: string[] = [];
    const { container } = mount({ onSend: (t: string) => { seen.push(t); } });
    const file = new File(['line one\nline two'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    // The dropped name landed in the box too — clear it back to a clean message.
    await fireEvent.input(box(container), { target: { value: 'please review' } });
    await fireEvent.keyDown(box(container), { key: 'Enter' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      'please review\n\n<attached-file name="notes.txt" truncated="false">\nline one\nline two\n</attached-file>',
    );
    // The chip and the draft both clear on send.
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
    expect(box(container).value).toBe('');
  });

  it('the hold-for-idle path carries the fold too: it sends nothing until the turn ends, then folds', async () => {
    const seen: string[] = [];
    const { container, rerender } = mount({ inFlight: true, onSend: (t: string) => { seen.push(t); } });
    const file = new File(['secret sauce'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.drop(box(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    await fireEvent.input(box(container), { target: { value: 'do this next' } });
    await fireEvent.keyDown(box(container), { key: 'Enter' });
    // Mid-turn: held, not sent.
    expect(seen).toEqual([]);
    expect(box(container).value).toBe('do this next'); // draft stays on screen
    // Turn ends — the held effect fires doSend(), which runs the SAME fold.
    await rerender({
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onSend: (t: string) => { seen.push(t); }, onCancel: () => {},
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(
      'do this next\n\n<attached-file name="notes.txt" truncated="false">\nsecret sauce\n</attached-file>',
    );
  });

  it('folding is a no-op when nothing was dropped — every existing send path is unchanged', async () => {
    const seen: unknown[][] = [];
    const { container } = mount({ onSend: (...a: unknown[]) => { seen.push(a); } });
    await fireEvent.input(box(container), { target: { value: 'just words' } });
    await fireEvent.keyDown(box(container), { key: 'Enter' });
    expect(seen).toEqual([['just words']]);
  });
});

// t-z69b8m: the overlay stuck on with nothing dragged, and explorer drops
// never attached. Real DOM shapes: an explorer drag carries URIs only (the
// webview has no fs), so the composer must ask the host for the bytes.
describe('InputBar — t-z69b8m drop overlay resets and host-read attach', () => {
  const area = (c: HTMLElement) => c.querySelector('.input-area') as HTMLElement;
  const hint = (c: HTMLElement) => c.querySelector('.drop-hint');

  it('a drag that enters and then ends outside the webview (window blur) clears the overlay', async () => {
    const { container } = mount();
    await fireEvent.dragEnter(area(container));
    expect(hint(container)).not.toBeNull();
    await fireEvent(window, new Event('blur'));
    await waitFor(() => expect(hint(container)).toBeNull());
  });

  it('a drop elsewhere in the webview (window drop) clears the overlay', async () => {
    const { container } = mount();
    await fireEvent.dragEnter(area(container));
    await fireEvent.dragEnter(box(container));
    await fireEvent(window, new Event('drop'));
    await waitFor(() => expect(hint(container)).toBeNull());
  });

  it('a file dropped on the composer box but not on the textarea still attaches', async () => {
    const { container } = mount();
    const file = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    await fireEvent.drop(area(container), { dataTransfer: makeDataTransfer({ files: [file] }) });
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
  });

  it('an explorer drop asks the host to read the file, and the reply attaches it as a chip', async () => {
    const { container } = mount();
    const dtx = { getData: (k: string) => (k.toLowerCase() === 'resourceurls' ? JSON.stringify(['file:///C:/w/a.ts']) : ''), files: [] };
    await fireEvent.drop(box(container), { dataTransfer: dtx });
    const req = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>).find((m) => m.type === 'readDroppedFiles');
    expect(req).toBeTruthy();
    expect(req!.uris).toEqual(['file:///C:/w/a.ts']);
    expect(box(container).value).toBe(' C:\\w\\a.ts ');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'droppedFiles', dropId: req!.dropId, files: [{ name: 'a.ts', mime: 'text/plain', base64: btoa('export {}') }] } }));
    await waitFor(() => expect(container.querySelector('.text-attachment-chip')).not.toBeNull());
    expect(box(container).value).toBe(' C:\\w\\a.ts '); // the path is not inserted twice
  });

  it('an explorer drop of an unsupported (binary) file leaves only its full path as text: no chip, no error', async () => {
    const { container } = mount();
    const dtx = { getData: (k: string) => (k.toLowerCase() === 'resourceurls' ? JSON.stringify(['file:///C:/w/tool.exe']) : ''), files: [] };
    await fireEvent.drop(box(container), { dataTransfer: dtx });
    const req = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>).find((m) => m.type === 'readDroppedFiles' && (m.uris as string[])[0].endsWith('tool.exe'));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'droppedFiles', dropId: req!.dropId, files: [{ name: 'tool.exe', mime: 'text/plain', base64: btoa('MZ\u0000\u0000') }] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(box(container).value).toBe(' C:\\w\\tool.exe ');
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
    expect(imageErrors()).toEqual([]);
  });

  it('a host reply for ANOTHER composer\'s drop is ignored', async () => {
    const { container } = mount();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'droppedFiles', dropId: 'not-mine', files: [{ name: 'a.ts', mime: 'text/plain', base64: btoa('x') }] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.text-attachment-chip')).toBeNull();
  });
});
