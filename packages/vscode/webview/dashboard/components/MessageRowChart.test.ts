// Chart fence rendering through MessageRow's real markdown pipeline (marked
// -> renderer.code -> chartBlock.renderChartBlock -> {@html}). A sibling of
// MessageRow.test.ts (clickable paths), kept separate rather than added to
// it — a different feature seam, and MessageRow.test.ts is owned by another
// lane's chain of assertions.

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MessageRow from './MessageRow.svelte';

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```';
}

describe('MessageRow — chart fence', () => {
  it('a valid ```chart fence renders an inline <svg>, not a code block', () => {
    const spec = JSON.stringify({ type: 'bar', series: [{ name: 'A', data: [1, 2, 3] }] });
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: fence('chart', spec),
    });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.code-block')).toBeNull();
  });

  it('a normal ```ts fence still renders through hljs, unaffected by the chart branch', () => {
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: fence('ts', 'const x: number = 1;'),
    });
    const pre = container.querySelector('pre > code.hljs');
    expect(pre, 'a normal fence should still render highlighted <pre><code class="hljs">').not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('a broken ```chart fence (invalid JSON) falls back to a normal code block, not a crash', () => {
    const { container } = render(MessageRow, {
      kind: 'agent',
      label: 'Coder',
      text: fence('chart', '{not valid json'),
    });
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.code-block')).not.toBeNull();
    expect(container.querySelector('.code-lang')?.textContent).toBe('chart');
  });
});
