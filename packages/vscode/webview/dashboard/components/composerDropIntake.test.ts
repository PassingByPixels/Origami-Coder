// t-z69b8m: the composer's drop overlay and drop intake. The DataTransfer
// shapes below copy what Chromium hands a VS Code webview:
//   - an OS file drag (Windows Explorer, Finder): types ['Files'], real File
//     objects, getData('text/uri-list') === '' (Chromium hides the path).
//   - a VS Code explorer drag (Shift held): no files, the workbench's own
//     types — 'resourceurls' (JSON array of URIs), 'codefiles', 'text/uri-list'
//     on some builds, 'application/vnd.code.uri-list' on others. DOM type
//     strings are lower-case.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createDragState, planDrop, filesFromHost, DRAG_IDLE_MS } from './composerDropIntake';

function dt(data: Record<string, string>, files: File[] = []) {
  const types = [...Object.keys(data), ...(files.length ? ['Files'] : [])];
  return { types, files, getData: (k: string) => data[k.toLowerCase()] ?? '' } as unknown as DataTransfer;
}

describe('planDrop — which payload a drop carries', () => {
  it('an OS file drag attaches the File objects', () => {
    const f = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(planDrop(dt({}, [f]))).toEqual({ kind: 'files', files: [f] });
  });

  it('a VS Code explorer drag with only resourceurls becomes a host read of those URIs', () => {
    const p = planDrop(dt({ resourceurls: JSON.stringify(['file:///c%3A/w/a.ts']), codefiles: JSON.stringify(['c:\\w\\a.ts']) }));
    expect(p).toEqual({ kind: 'uris', uris: ['file:///c%3A/w/a.ts'] });
  });

  it('application/vnd.code.uri-list is read before text/uri-list', () => {
    const p = planDrop(dt({ 'application/vnd.code.uri-list': 'file:///C:/a.png\r\nfile:///C:/b.md', 'text/uri-list': 'file:///C:/other' }));
    expect(p).toEqual({ kind: 'uris', uris: ['file:///C:/a.png', 'file:///C:/b.md'] });
  });

  it('text/uri-list alone still works, comments dropped', () => {
    expect(planDrop(dt({ 'text/uri-list': '# c\nfile:///C:/a.ts\n' }))).toEqual({ kind: 'uris', uris: ['file:///C:/a.ts'] });
  });

  it('an empty drag (plain text selection) is nothing', () => {
    expect(planDrop(dt({ 'text/plain': 'hello' }))).toEqual({ kind: 'none' });
  });
});

describe('filesFromHost — the host reply becomes real File objects', () => {
  it('decodes base64 bytes, name and mime', async () => {
    const [f] = filesFromHost([{ name: 'a.txt', mime: 'text/plain', base64: btoa('hi there') }]);
    expect(f.name).toBe('a.txt');
    expect(f.type).toBe('text/plain');
    const text = await new Promise<string>((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsText(f); });
    expect(text).toBe('hi there');
  });
  it('ignores malformed rows', () => {
    expect(filesFromHost([{ name: 1 }, null, 'x'] as unknown[])).toEqual([]);
    expect(filesFromHost(undefined)).toEqual([]);
  });
});

describe('createDragState — the overlay always clears', () => {
  let shown: boolean[];
  let s: ReturnType<typeof createDragState>;
  beforeEach(() => { vi.useFakeTimers(); shown = []; s = createDragState((v) => shown.push(v), window); });
  afterEach(() => { s.destroy(); vi.useRealTimers(); });
  const last = () => shown[shown.length - 1];

  it('leaving through a child: enter box, enter child, leave box, leave child -> off, never flickers', () => {
    s.event('enter'); s.event('enter'); s.event('leave');
    expect(last()).toBe(true);
    s.event('leave');
    expect(last()).toBe(false);
    expect(shown).toEqual([true, false]);
  });

  it('a drag that ends outside the webview (no leave, no drop) clears once dragover stops', () => {
    s.event('enter'); s.event('over');
    vi.advanceTimersByTime(DRAG_IDLE_MS - 10);
    expect(last()).toBe(true);
    s.event('over'); // still hovering: the timer restarts
    vi.advanceTimersByTime(DRAG_IDLE_MS - 10);
    expect(last()).toBe(true);
    vi.advanceTimersByTime(20);
    expect(last()).toBe(false);
  });

  it('an enter with no dragover at all (VS Code overlay covers the iframe) still clears', () => {
    s.event('enter');
    vi.advanceTimersByTime(DRAG_IDLE_MS + 1);
    expect(last()).toBe(false);
  });

  for (const type of ['dragend', 'drop', 'blur', 'mousemove']) {
    it(`window ${type} resets the depth to zero`, () => {
      s.event('enter'); s.event('enter');
      window.dispatchEvent(new Event(type));
      expect(last()).toBe(false);
      s.event('enter'); // a fresh drag starts from zero, not from a stale depth
      s.event('leave');
      expect(last()).toBe(false);
    });
  }

  it('destroy removes the window listeners and the timer', () => {
    s.event('enter');
    s.destroy();
    const n = shown.length;
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(DRAG_IDLE_MS * 2);
    expect(shown.length).toBe(n);
  });
});
