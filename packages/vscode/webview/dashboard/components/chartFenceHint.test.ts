// chartFenceHint.test.ts — the silent-degrade fix, on BOTH markdown seams.
//
// The real failure: a live session emitted YAML into a ```chart fence. parseSpec
// only ever calls JSON.parse, so it returned null, every chart degraded to an
// anonymous code block, and NOTHING said so — the session produced zero charts
// and nobody noticed. The fence still renders the user's text (throwing or
// blanking it would lose their content); it now also says why there is no
// picture.
//
// Both seams are tested together on purpose. MessageRow.svelte (marked.setOptions)
// and collabMarkdown.ts (per-call options) carry deliberately duplicated
// renderer.code bodies — they co-mount in one bundle, so neither may own a
// shared mutable global — and the two drift silently. The last case pins them
// to the same markup rather than to a wording this test also asserts.

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MessageRow from './MessageRow.svelte';
import { renderCollabMessage } from '../../chat/collabMarkdown';

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```';
}

// Verbatim from the live failure: YAML where JSON was required.
const YAML_BODY = 'type: bar\ndata:\n  - label: Q1';
const GOOD_SPEC = JSON.stringify({ type: 'bar', xLabels: ['Q1'], series: [{ name: 'Sales', data: [3] }] });

function chatHtml(text: string): string {
  const { container } = render(MessageRow, { kind: 'agent', label: 'Coder', text });
  return (container.querySelector('.text') as HTMLElement).innerHTML;
}

const HINT = /<span class="chart-hint">[^<]+<\/span>/;

describe('an unparseable ```chart fence is corrected, not silent', () => {
  it.each([
    ['chat', (text: string) => chatHtml(text)],
    ['collab', (text: string) => renderCollabMessage(text, 'agent')],
  ])('%s: the YAML that killed the live session now says the fence takes JSON', (_seam, renderSeam) => {
    const html = renderSeam(fence('chart', YAML_BODY));
    const hint = HINT.exec(html)?.[0];
    expect(hint, `no chart hint in: ${html}`).toBeDefined();
    expect(hint).toContain('JSON');
    // The user's text survives: a hint replaces silence, never content.
    expect(html).toContain('label: Q1');
    expect(html).toContain('class="code-block"');
    expect(html).not.toContain('<svg');
  });

  it.each([
    ['chat', (text: string) => chatHtml(text)],
    ['collab', (text: string) => renderCollabMessage(text, 'agent')],
  ])('%s: a spec that DOES parse draws the chart and raises no hint', (_seam, renderSeam) => {
    const html = renderSeam(fence('chart', GOOD_SPEC));
    expect(html).toContain('<svg');
    expect(HINT.test(html)).toBe(false);
  });

  it.each([
    ['chat', (text: string) => chatHtml(text)],
    ['collab', (text: string) => renderCollabMessage(text, 'agent')],
  ])('%s: an ordinary fence is untouched by the chart branch', (_seam, renderSeam) => {
    const html = renderSeam(fence('json', '{not valid json'));
    expect(HINT.test(html)).toBe(false);
    expect(html).toContain('class="code-block"');
  });

  it('both seams emit the SAME hint markup, so neither can drift alone', () => {
    const broken = fence('chart', YAML_BODY);
    expect(HINT.exec(chatHtml(broken))?.[0]).toBe(HINT.exec(renderCollabMessage(broken, 'agent'))?.[0]);
  });
});
