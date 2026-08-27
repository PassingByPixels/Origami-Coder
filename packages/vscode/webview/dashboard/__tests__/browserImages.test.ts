// browserImages.test.ts — the screenshot's path from the wire to the card.
//
// The engine sends a screenshot as an ACP image content block on the completed
// tool_call_update (engine/src/acp/tool.ts's imageContents). Before this
// wave the client's decode read text and diff blocks only, so the image was
// dropped silently and the browser card had nothing to show. These cover the
// two hops that fix it: the decode (acpToolContent.ts) and the stamp onto the
// transcript's card (chatToolMsg.ts).

import { describe, expect, it } from 'vitest';
import { decodeToolContent } from '../../../src/acpToolContent';
import { applyToolResult, type ToolCardMsg } from '../panes/chatToolMsg';

const B64 = 'iVBORw0KGgo=';

function textBlock(text: string) {
  return { type: 'content', content: { type: 'text', text } };
}
function imageBlock(data: string, mimeType = 'image/png') {
  return { type: 'content', content: { type: 'image', data, mimeType } };
}

describe('decodeToolContent — the whole content array, not content[0]', () => {
  it('turns an image block into a data: URI beside the text', () => {
    const out = decodeToolContent([textBlock('Screenshot of https://a.test'), imageBlock(B64)]);
    expect(out.contentText).toBe('Screenshot of https://a.test');
    expect(out.images).toEqual([`data:image/png;base64,${B64}`]);
  });

  it('keeps several screenshots in wire order and carries each mime type', () => {
    const out = decodeToolContent([imageBlock(B64), imageBlock('AAAA', 'image/jpeg')]);
    expect(out.images).toEqual([`data:image/png;base64,${B64}`, 'data:image/jpeg;base64,AAAA']);
  });

  it('leaves images absent for a tool that sent none, and still reads the diff', () => {
    const out = decodeToolContent([
      textBlock('edited'),
      { type: 'diff', path: '/a.ts', oldText: 'a', newText: 'b' },
    ]);
    expect(out.images).toBeUndefined();
    expect(out.diff).toEqual({ path: '/a.ts', oldText: 'a', newText: 'b' });
  });

  it('drops an image block with no data rather than emitting a broken src', () => {
    const out = decodeToolContent([{ type: 'content', content: { type: 'image', mimeType: 'image/png' } }]);
    expect(out.images).toBeUndefined();
  });
});

describe('applyToolResult — stamping the screenshot onto its card', () => {
  const card = (): ToolCardMsg[] => [
    { id: 1, kind: 'tool', label: 'browser screenshot', text: '', toolCallId: 'tc1', toolName: 'browser' },
  ];

  it('stamps the data URIs the update carried', () => {
    const out = applyToolResult(card(), {
      toolCallId: 'tc1',
      status: 'completed',
      content: 'Screenshot of https://a.test',
      images: [`data:image/png;base64,${B64}`],
    }, 2);
    expect(out[0].toolImages).toEqual([`data:image/png;base64,${B64}`]);
  });

  it('does not erase a delivered screenshot when a later update carries none', () => {
    const first = applyToolResult(card(), {
      toolCallId: 'tc1', status: 'in_progress', content: '', images: [`data:image/png;base64,${B64}`],
    }, 2);
    const second = applyToolResult(first, { toolCallId: 'tc1', status: 'completed', content: 'done' }, 3);
    expect(second[0].toolImages).toEqual([`data:image/png;base64,${B64}`]);
  });

  it('ignores a non-data: string, which would render as a broken image', () => {
    const out = applyToolResult(card(), {
      toolCallId: 'tc1', status: 'completed', content: 'x', images: ['https://evil.test/a.png', ''],
    }, 2);
    expect(out[0].toolImages).toBeUndefined();
  });
});

// The engine COMPLETES a failed browser call, so `status` cannot carry the
// verdict and the title is prose. `rawOutput.metadata.ok` is the wire fact; if
// it is dropped here the card has nothing left but prose to guess from.
describe('applyToolResult — the browser verdict off the metadata', () => {
  const card = (toolName = 'browser'): ToolCardMsg[] => [
    { id: 1, kind: 'tool', label: 'browser open', text: '', toolCallId: 'tc1', toolName },
  ];

  it('stamps ok:false with the action and target the engine named', () => {
    const out = applyToolResult(card(), {
      toolCallId: 'tc1',
      status: 'completed',
      content: 'The VS Code browser could not open and gave no reason.',
      rawOutputMeta: { ok: false, action: 'open', url: 'https://a.test' },
    }, 2);
    expect(out[0].toolBrowser).toEqual({ ok: false, action: 'open', url: 'https://a.test' });
  });

  it('stamps ok:true so a working call is not merely "not known to have failed"', () => {
    const out = applyToolResult(card(), {
      toolCallId: 'tc1', status: 'completed', content: 'Opened.', rawOutputMeta: { ok: true, action: 'open' },
    }, 2);
    expect(out[0].toolBrowser).toEqual({ ok: true, action: 'open', url: undefined });
  });

  it('does not erase the verdict when a later update carries no metadata', () => {
    const first = applyToolResult(card(), {
      toolCallId: 'tc1', status: 'completed', content: 'boom', rawOutputMeta: { ok: false, action: 'read' },
    }, 2);
    const second = applyToolResult(first, { toolCallId: 'tc1', status: 'completed', content: 'boom' }, 3);
    expect(second[0].toolBrowser).toEqual({ ok: false, action: 'read', url: undefined });
  });

  it('leaves another tool alone even when its metadata happens to carry ok', () => {
    const out = applyToolResult(card('fetch'), {
      toolCallId: 'tc1', status: 'completed', content: 'body', rawOutputMeta: { ok: false },
    }, 2);
    expect(out[0].toolBrowser).toBeUndefined();
  });

  it('stamps nothing when the metadata has no boolean verdict at all', () => {
    const out = applyToolResult(card(), {
      toolCallId: 'tc1', status: 'completed', content: 'x', rawOutputMeta: { ok: 'yes', action: 'open' },
    }, 2);
    expect(out[0].toolBrowser).toBeUndefined();
  });
});
