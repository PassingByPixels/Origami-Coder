// t-yyz5yk — Round 8 "Inside each element", the remaining open views: Read,
// Grep, Write, Message, Shell, Browser. Structure only (jsdom loads no <style>).
// Fixtures follow the engine's real output shapes (packages/engine/src/tool/
// grep.ts, agents.ts send_message, read.ts display text, write.ts).
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ToolCard from './ToolCard.svelte';
import ReadFileCard from './toolcards/ReadFileCard.svelte';
import GrepCard from './toolcards/GrepCard.svelte';
import BashCard from './toolcards/BashCard.svelte';

const posts = () => globalThis.__vscodeApiMock.postMessage;
beforeEach(() => posts().mockClear());
afterEach(cleanup);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('Read — file lines with their real numbers', () => {
  const props = { result: 'alpha\nbeta\ngamma', path: 'C:\\app\\src\\title.ts', toolLines: { start: 10, end: 12 } };

  it('the bar names the range read; each line carries its file line number', () => {
    const { container } = render(ReadFileCard, props);
    expect(text(container.querySelector('.dbar'))).toContain('lines 10–12 read');
    expect([...container.querySelectorAll('.rl-n')].map((n) => n.textContent)).toEqual(['10', '11', '12']);
  });

  it('Open file opens the file at the first line read', async () => {
    const { getByRole } = render(ReadFileCard, props);
    await fireEvent.click(getByRole('button', { name: 'Open file' }));
    expect(posts()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: props.path, line: 10 });
  });
});

describe('Grep — hits grouped by file', () => {
  const OUT = ['Found 3 matches', 'src/session/title.ts:', '  Line 12: const staleTitle = 1;', '  Line 40: if (staleTitle) x;', '', 'src/tabs/tab.ts:', '  Line 21: tab.title = staleTitle;'].join('\n');

  it('parses the engine format: one group per file with its hit count and line numbers', () => {
    const { container } = render(GrepCard, { result: OUT, title: 'staleTitle' });
    const files = [...container.querySelectorAll('.gfile')];
    expect(files.map((f) => text(f))).toEqual(['src/session/title.ts 2', 'src/tabs/tab.ts 1']);
    expect([...container.querySelectorAll('.gl-n')].map((n) => n.textContent)).toEqual(['12', '40', '21']);
    expect(text(container.querySelector('.dbar'))).toBe('staleTitle · 3 matches in 2 files');
  });

  it('marks the pattern inside each hit and a line opens the file at that line', async () => {
    const { container } = render(GrepCard, { result: OUT, title: 'staleTitle' });
    expect(container.querySelectorAll('mark')).toHaveLength(3);
    await fireEvent.click(container.querySelectorAll('.gl')[2] as HTMLElement);
    expect(posts()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'src/tabs/tab.ts', line: 21 });
  });

  it('the old `path:line: text` form still parses', () => {
    const { container } = render(GrepCard, { result: 'a.ts:3: foo', title: 'grep' });
    expect(text(container.querySelector('.gfile'))).toBe('a.ts 1');
    expect(container.querySelector('mark')).toBeNull();
  });
});

describe('Write — the file written, with Open file', () => {
  it('a write with no diff opens to the path bar, not the raw success sentence', async () => {
    const { container, getByRole } = render(ToolCard, {
      title: 'src/session/title.test.ts', kind: 'edit', toolName: 'write', status: 'completed',
      result: 'Wrote file successfully.', path: 'C:\\app\\src\\session\\title.test.ts',
    });
    await fireEvent.click(container.querySelector('.tool-header') as HTMLElement);
    expect(text(container.querySelector('.tool-result .dbar'))).toContain('written');
    expect(container.querySelector('.edit-fallback')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Open file' }));
    expect(posts()).toHaveBeenCalledWith({ type: 'openAbsoluteFile', path: 'C:\\app\\src\\session\\title.test.ts' });
    expect(container.querySelector('.tool-result [title]')).toBeNull();
  });
});

describe('Message — recipient and delivery state', () => {
  const open = async (title: string, result: string) => {
    const r = render(ToolCard, { title, kind: 'other', toolName: 'send_message', status: 'completed', result });
    await fireEvent.click(r.container.querySelector('.tool-header') as HTMLElement);
    return r.container;
  };

  it('delivered: recipient chip, state, and the engine sentence kept', async () => {
    const c = await open('send_message: Cortex-1252', 'Delivered to Cortex-1252 (session s1). It will pick this up on its next turn boundary.');
    expect(text(c.querySelector('.msg-to'))).toBe('Cortex-1252');
    expect(text(c.querySelector('.msg-state'))).toBe('delivered');
    expect(text(c.querySelector('.msg-note'))).toContain('next turn boundary');
  });

  it('refused: red state, no recipient chip', async () => {
    const c = await open('send_message: refused', 'Refused: no agent named "x".');
    expect(c.querySelector('.msg-to')).toBeNull();
    expect(c.querySelector('.msg-state.bad')?.textContent).toBe('refused');
  });
});

describe('Shell — a bar with the shell and folder', () => {
  it('the bar names the shell and cwd; timeout moves there; IN/OUT kept', () => {
    const { container, getByText } = render(BashCard, {
      result: 'ok', title: 'npm test', status: 'completed',
      shell: { command: 'npm test', cwd: 'C:\\Repos\\app', display: 'PowerShell', timeout: 300000, exit: 0 },
    });
    const bar = text(container.querySelector('.dbar'));
    expect(bar).toContain('PowerShell');
    expect(bar).toContain('C:\\Repos\\app');
    expect(bar).toContain('timeout 300s');
    expect(getByText('IN')).toBeTruthy();
    expect(container.querySelector('.bash-rail-out')).not.toBeNull();
  });
});
