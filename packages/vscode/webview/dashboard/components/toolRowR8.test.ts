// t-yyz5yk — Round 8 shared tool row: line icons, the travelling line while
// running (and only then), the verdict badge on the icon, browser globe +
// action glyph. jsdom loads no <style>, so these assert STRUCTURE: which icon,
// which class, which node exists in which state. The data and controls the row
// had before (path reveal, line range, verdict tooltip classes) are asserted
// alongside, so a restyle that drops one fails here.
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolCard from './ToolCard.svelte';

afterEach(cleanup);

const EMOJI = /\p{Extended_Pictographic}/u;

function card(props: Record<string, unknown>) {
  return render(ToolCard, { title: 't', kind: 'other', status: 'completed', ...props });
}

describe('Round 8 rule 3 — line icons, not emoji', () => {
  it.each([
    ['read', 'read', 'read'],
    ['edit', 'edit', 'edit'],
    ['write', 'edit', 'write'],
    ['bash', 'execute', 'shell'],
    ['grep', 'search', 'search'],
    ['task', 'other', 'task'],
    ['task_parallel', 'other', 'parallel'],
    ['todowrite', 'other', 'todo'],
    ['artifact_get', 'other', 'artifact'],
    ['browser', 'other', 'browser'],
  ])('%s (kind %s) draws the %s line icon', (toolName, kind, icon) => {
    const { container } = card({ toolName, kind });
    const svg = container.querySelector('.tool-icon svg');
    expect(svg?.getAttribute('data-icon')).toBe(icon);
    expect(container.querySelector('.tool-icon')?.textContent ?? '').not.toMatch(EMOJI);
  });

  it('a read that returned a picture draws the image icon', () => {
    const { container } = card({ toolName: 'read', kind: 'read', readImage: { path: 'a.png', mime: 'image/png', bytes: 10 } });
    expect(container.querySelector('.tool-icon svg')?.getAttribute('data-icon')).toBe('image');
  });
});

describe('Round 8 rules 1-2 — motion means now', () => {
  it('a running row carries the travelling line', () => {
    const { container } = card({ toolName: 'read', kind: 'read', status: 'in_progress' });
    expect(container.querySelector('.tool-card')?.getAttribute('data-status')).toBe('running');
    expect(container.querySelector('.tool-travel')).not.toBeNull();
  });

  it.each(['completed', 'failed'])('a %s row has no travelling line (a settled row runs nothing)', (status) => {
    const { container } = card({ toolName: 'read', kind: 'read', status });
    expect(container.querySelector('.tool-travel')).toBeNull();
  });

  it('the verdict still lands in the badge with its honest class', () => {
    const { container } = card({ toolName: 'bash', kind: 'execute', status: 'completed', shell: { exit: 2 } });
    expect(container.querySelector('.tool-badge-mark .status-mark')?.classList.contains('cross')).toBe(true);
    expect(container.querySelector('.tool-card')?.getAttribute('data-status')).toBe('failed');
  });
});

describe('Round 8 G — browser rows carry the globe and an action glyph', () => {
  it('a click row shows the globe plus the pointer glyph', () => {
    const { container } = card({ toolName: 'browser', browser: { ok: true, action: 'click', url: 'https://example.com/a/b' } });
    expect(container.querySelector('.tool-icon svg')?.getAttribute('data-icon')).toBe('browser');
    expect(container.querySelector('.tool-act svg')?.getAttribute('data-icon')).toBe('click');
  });

  it('an open row shows the globe alone and the host, full URL on hover', () => {
    const { container } = card({ toolName: 'browser', browser: { ok: true, action: 'open', url: 'https://example.com/docs/page?q=1' } });
    expect(container.querySelector('.tool-act')).toBeNull();
    const site = container.querySelector('.tool-site');
    expect(site?.querySelector('b')?.textContent).toBe('example.com');
    expect(site?.textContent).toContain('/docs/page');
    expect(site?.getAttribute('data-tip')).toBe('https://example.com/docs/page?q=1');
  });
});

describe('Round 8 F — read image row', () => {
  const IMG = { path: 'renders/title_card.png', mime: 'image/png', bytes: 240 * 1024, src: 'vscode-resource:/renders/title_card.png' };

  it('the row carries the size, then the pixel size once the picture loads', async () => {
    const { container } = card({ toolName: 'read', kind: 'read', path: IMG.path, readImage: IMG, result: 'Image read successfully' });
    expect(container.querySelector('.tool-meta')?.textContent).toBe('240 KB');
    const img = container.querySelector('.readfile-image') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 460 });
    Object.defineProperty(img, 'naturalHeight', { value: 300 });
    img.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.tool-meta')?.textContent).toBe('240 KB · 460 × 300');
    expect(container.querySelector('.readimg-frame')?.classList.contains('landed')).toBe(true);
  });

  it('the frame exists before the picture has loaded (nothing jumps)', () => {
    const { container } = card({ toolName: 'read', kind: 'read', readImage: IMG, result: 'Image read successfully' });
    const frame = container.querySelector('.readimg-frame');
    expect(frame).not.toBeNull();
    expect(frame?.classList.contains('landed')).toBe(false);
    // Reveal is kept, as a hover action inside the frame.
    expect(frame?.querySelector('.readfile-reveal')).not.toBeNull();
  });
});

describe('Round 8 J — sub-agent task row', () => {
  it('while running, the line under the row is the latest step, and it moves on', async () => {
    const { container, rerender } = card({ toolName: 'task', status: 'in_progress', stream: 'Looking.\nRead ToolCard.svelte\n' });
    expect(container.querySelector('.tool-tail')?.textContent).toBe('Read ToolCard.svelte');
    await rerender({ toolName: 'task', status: 'in_progress', stream: 'Looking.\nRead ToolCard.svelte\nGrep kindIcons' });
    expect(container.querySelector('.tool-tail')?.textContent).toBe('Grep kindIcons');
  });

  it('done: steps, tokens and model on the row; the tail is gone', () => {
    const { container } = card({
      toolName: 'task', status: 'completed', result: 'report', stream: 'x\nlast step',
      taskTokens: { input: 10000, output: 1200, steps: 4 }, taskModel: 'deepseek-v4.1-flash',
    });
    const meta = container.querySelector('.tool-meta')?.textContent ?? '';
    expect(meta).toContain('11.2k tokens');
    expect(meta).toContain('4 steps');
    expect(meta).toContain('deepseek-v4.1-flash');
    expect(container.querySelector('.tool-tail')).toBeNull();
    // Kept: the sub-agent badge.
    expect(container.querySelector('.tool-badge')?.textContent).toBe('sub-agent');
  });
});

describe('Round 8 L — read artifact row', () => {
  const ID = 'art_cc75b40845395201fd073802';
  const result = (v: number, latest: number) => [
    `Artifact ${ID} "Cortex Repo Summary", version ${v} of ${latest}.`,
    'Manifest digest: sha256:3f9a',
    'Opens at: index.html',
    `Link: [Cortex Repo Summary](origami://artifact/${ID}?v=${v})`,
    'Files:',
    '- index.html (10035 bytes, text/html)',
    '- style.css (3174 bytes, text/css)',
    '- data/repos.json (4710 bytes, application/json)',
    '- img/graph.png (922 bytes, image/png)',
    '',
  ].join('\n');

  it('the row says version, files and size; the card says it is the latest', () => {
    const { container } = card({ toolName: 'artifact_get', status: 'completed', result: result(2, 2) });
    expect(container.querySelector('.tool-meta')?.textContent).toBe('v2 of 2 · 4 files · 18.4 KB');
    const c = container.querySelector('.ac-card');
    expect(c?.querySelector('.ac-latest')?.textContent).toBe('latest');
    expect(c?.querySelector('.ac-meta')?.textContent).toContain('index.html · 4 files · 18.4 KB');
    // Kept: Open, the title, the version.
    expect(c?.querySelector('button.ac-open')).not.toBeNull();
    expect(c?.querySelector('.ac-ver')?.textContent).toBe('v2');
  });

  it('an older version read says the newer one exists', () => {
    const { container } = card({ toolName: 'artifact_get', status: 'completed', result: result(2, 3) });
    expect(container.querySelector('.ac-newer')?.textContent).toBe('v3 is newer');
    expect(container.querySelector('.ac-latest')).toBeNull();
  });

  it('artifact_publish keeps its card without the read-only facts', () => {
    const { container } = card({ toolName: 'artifact_publish', status: 'completed', result: `Published.\nLink: [T](origami://artifact/${ID}?v=3)` });
    expect(container.querySelector('.ac-card')).not.toBeNull();
    expect(container.querySelector('.ac-newer, .ac-latest')).toBeNull();
  });
});

describe('Round 8 L — artifactFacts reads only the Files block', () => {
  it('a file body line shaped like a file entry is not counted', async () => {
    const { artifactFacts } = await import('./toolRowMeta');
    const f = artifactFacts([
      'Artifact art_x "T", version 1 of 1.', 'Files:', '- a.md (10 bytes, text/markdown)', '',
      '### a.md (text/markdown)', '- fake.txt (999 bytes, text/plain)', '',
    ].join('\n'));
    expect(f).toEqual({ version: 1, latest: 1, files: 1, bytes: 10 });
  });
});
