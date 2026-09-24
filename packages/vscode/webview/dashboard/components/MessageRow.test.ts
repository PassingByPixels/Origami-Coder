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

  // t-v486mk — a path with a space. Inside backticks, quotes or a markdown link
  // the whole path is known, so it must link as ONE path. Before the fix the
  // linkifier stopped at the space and linked only a fragment.
  const clickOnly = async (text: string, kind: 'agent' | 'user' = 'agent') => {
    const { container } = render(MessageRow, { kind, label: 'Coder', text });
    const links = [...container.querySelectorAll('a.file-link')] as HTMLElement[];
    expect(links.map((l) => l.dataset.path), 'exactly one file link').toHaveLength(1);
    await fireEvent.click(links[0]);
    return post().mock.calls.at(-1)?.[0];
  };

  it('a backticked Windows path with spaces links as one path (the owner\'s case)', async () => {
    const p = 'C:\\Users\\dev\\Desktop\\Workspace\\projects\\Origami Spark\\SparkConsole\\engines\\glm53.py';
    expect(await clickOnly('Edit `' + p + '` next.')).toEqual({ type: 'openAbsoluteFile', path: p, line: undefined });
  });

  it('a backticked POSIX path with spaces, parentheses and a :line suffix', async () => {
    expect(await clickOnly('See `/home/me/My Docs/file (1).md:12` now.'))
      .toEqual({ type: 'openAbsoluteFile', path: '/home/me/My Docs/file (1).md', line: 12 });
  });

  it('a backticked path with non-ASCII letters and an apostrophe', async () => {
    expect(await clickOnly("Open `C:\\Users\\José\\O'Brien notes\\café.ts:3`."))
      .toEqual({ type: 'openAbsoluteFile', path: "C:\\Users\\José\\O'Brien notes\\café.ts", line: 3 });
  });

  it('a backticked relative path with parentheses and no space links whole', async () => {
    expect(await clickOnly('Route in `app/(group)/page.tsx`.'))
      .toEqual({ type: 'openAbsoluteFile', path: 'app/(group)/page.tsx', line: undefined });
  });

  it('a double-quoted path with spaces in prose links as one path', async () => {
    expect(await clickOnly('Wrote "D:\\My Projects\\a b\\notes.md:4" for you.'))
      .toEqual({ type: 'openAbsoluteFile', path: 'D:\\My Projects\\a b\\notes.md', line: 4 });
  });

  it('a single-quoted POSIX path with spaces in prose links as one path', async () => {
    expect(await clickOnly("Wrote '/tmp/x y/z.txt' for you."))
      .toEqual({ type: 'openAbsoluteFile', path: '/tmp/x y/z.txt', line: undefined });
  });

  it('a quoted path with spaces in a USER message links as one path', async () => {
    expect(await clickOnly('open "C:\\a b\\c.py" please', 'user'))
      .toEqual({ type: 'openAbsoluteFile', path: 'C:\\a b\\c.py', line: undefined });
  });

  it('a markdown link whose target has spaces (<...> form) opens the whole path', async () => {
    expect(await clickOnly('See [glm53](<C:\\a b\\glm53.py>).'))
      .toEqual({ type: 'openAbsoluteFile', path: 'C:\\a b\\glm53.py', line: undefined });
  });

  it('a markdown link whose target is %20-encoded opens the decoded path', async () => {
    expect(await clickOnly('See [z](/tmp/x%20y/z.txt:9).'))
      .toEqual({ type: 'openAbsoluteFile', path: '/tmp/x y/z.txt', line: 9 });
  });

  it('a markdown link with a raw space (marked leaves it as text) still links, with its label', async () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'See [glm53.py](C:\\x\\Origami Spark\\file (1).py:7) now.',
    });
    const links = [...container.querySelectorAll('a.file-link')] as HTMLElement[];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('glm53.py');
    await fireEvent.click(links[0]);
    expect(post()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'C:\\x\\Origami Spark\\file (1).py', line: 7 });
  });

  it('a bare prose path with non-ASCII letters links whole', async () => {
    expect(await clickOnly('Edit src/café/naïve.ts:5 now'))
      .toEqual({ type: 'openAbsoluteFile', path: 'src/café/naïve.ts', line: 5 });
  });

  // Ambiguous runs stay as they were: a space only joins inside delimiters, and
  // only for a rooted path, so a command in backticks keeps its own path link.
  it('does not join words across a space in unquoted prose', () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'the Origami Spark/engines/glm53.py file',
    });
    const paths = [...container.querySelectorAll('a.file-link')].map((l) => (l as HTMLElement).dataset.path);
    expect(paths).toEqual(['Spark/engines/glm53.py']);
  });

  it('a command in backticks links only the path argument, not the whole command', () => {
    for (const [text, want] of [
      ['Run `git add src/a.ts` now', ['src/a.ts']],
      ['Run `C:\\tools\\x.exe --in C:\\a\\b.txt` now', ['C:\\tools\\x.exe', 'C:\\a\\b.txt']],
      ['Run `/bin/cat /tmp/a.txt` now', ['/tmp/a.txt']],
    ] as const) {
      const { container, unmount } = render(MessageRow, { kind: 'agent', label: 'Coder', text });
      const paths = [...container.querySelectorAll('a.file-link')].map((l) => (l as HTMLElement).dataset.path);
      expect(paths, text).toEqual(want);
      unmount();
    }
  });

  it('a URL in backticks is not a file link', () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'See `https://example.com/docs/c.js` there',
    });
    expect(container.querySelector('a.file-link')).toBeNull();
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

// t-qi09w0 item 4 — the flowing streaming colour, through the FULL render
// chain: streamHead -> marked -> linkifyPaths -> {@html}. No colour is asserted
// (no <style> reaches this DOM); what is asserted is which words the accent
// span contains, and that injecting it did not damage the markdown.
describe('MessageRow — the accent rides the head of the stream', () => {
  const LONG = 'the model has written quite a lot of prose by now';
  const head = (c: HTMLElement) => c.querySelector('.og-stream-head');

  it('wraps only the newest few words while the row is streaming', () => {
    const { container } = render(MessageRow, { kind: 'agent', label: 'Coder', text: LONG, streaming: true });
    expect(head(container), 'a live row has a head span').not.toBeNull();
    expect(head(container)!.textContent).toBe('of prose by now');
    // ...and the words behind it are OUTSIDE it — the whole reply is not blue.
    expect(container.querySelector('.text')!.textContent!.trim()).toBe(LONG);
  });

  it('a settled row has no head at all — nothing is left blue when the turn ends', () => {
    const { container } = render(MessageRow, { kind: 'agent', label: 'Coder', text: LONG, streaming: false });
    expect(head(container)).toBeNull();
    expect(container.querySelector('.text')!.textContent!.trim()).toBe(LONG);
  });

  it('a code span at the boundary renders as CODE, not as a literal tag in the prose', () => {
    // The defect this guards: cut between the backticks and marked sees one
    // opening backtick in the body and the closing one inside the span, so the
    // reader gets a stray ` and a visible <span ...> in their message.
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'please run `npm run typecheck now` and report', streaming: true,
    });
    const body = container.querySelector('.text') as HTMLElement;
    expect(body.querySelector('code')?.textContent).toBe('npm run typecheck now');
    expect(body.textContent).not.toContain('<span');
    expect(body.textContent).not.toContain('`');
  });

  it('a reply that is still inside a code fence is left alone — no tag inside the code', () => {
    const { container } = render(MessageRow, {
      kind: 'agent', label: 'Coder', text: 'here it is\n\n```ts\nconst a = 1;', streaming: true,
    });
    expect(head(container)).toBeNull();
    expect(container.querySelector('.text')!.textContent).not.toContain('<span');
  });
});
