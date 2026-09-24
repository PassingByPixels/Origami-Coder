// whatsNewInline.test.ts — diagram and screenshot tokens in a curated What's new note
// (src/dashboard/whatsNewInline.ts, t-v5r1fd), then through the same `marked` call the
// panel uses, because the real risk is markdown breaking the inlined SVG apart.

import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { expandWhatsNewTokens, whatsNewTokens } from '../../../src/dashboard/whatsNewInline';

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment with a -- dash -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">

  <rect class="box" x="1" y="1" width="98" height="38"/>

  <text x="10" y="24">Newest *page*</text>
</svg>`;

const lookups = (over: Partial<Parameters<typeof expandWhatsNewTokens>[1]> = {}) => ({
  diagram: (n: string) => (n === 'restore' ? SVG : undefined),
  shot: (n: string) => (n === 'have' ? 'webview://shots/have.png' : undefined),
  preview: false,
  ...over,
});

describe('expandWhatsNewTokens', () => {
  it('inlines a diagram as ONE html block that markdown leaves whole', () => {
    const md = 'Intro.\n\n{{diagram:restore|How a chat reopens}}\n\nAfter.';
    const html = marked.parse(expandWhatsNewTokens(md, lookups()), { gfm: true }) as string;
    expect(html).toMatch(/<figure class="wn-fig"><svg[\s\S]*<\/svg><figcaption>How a chat reopens<\/figcaption><\/figure>/);
    expect(html).toContain('<rect class="box"'); // classes survive: the theme colours them
    expect(html).toContain('Newest *page*'); // markdown did not rewrite text inside the SVG
    expect(html).not.toContain('<?xml');
    expect(html).not.toContain('<!--');
    expect(html).toContain('<p>After.</p>');
  });

  it('a screenshot the owner added shows as an image with its caption as alt text', () => {
    const out = expandWhatsNewTokens('{{shot:have|The Nest tab}}', lookups());
    expect(out).toBe('<figure class="wn-shot"><img src="webview://shots/have.png" alt="The Nest tab" /><figcaption>The Nest tab</figcaption></figure>');
  });

  it('a missing screenshot is a marked placeholder in the preview and absent for users', () => {
    const md = '{{shot:nest-tab|The Nest tab & <b>chips</b>}}';
    const preview = expandWhatsNewTokens(md, lookups({ preview: true }));
    expect(preview).toContain('wn-shot-missing');
    expect(preview).toContain('whats-new/shots/nest-tab.png');
    expect(preview).toContain('The Nest tab &amp; &lt;b&gt;chips&lt;/b&gt;'); // caption escaped
    expect(expandWhatsNewTokens(md, lookups())).toBe('');
  });

  it('a missing diagram leaves no raw token behind', () => {
    expect(expandWhatsNewTokens('{{diagram:nope|x}}', lookups())).toBe('');
  });

  it('a token that is not alone on its line is left as text', () => {
    const md = 'See {{diagram:restore|x}} here.';
    expect(expandWhatsNewTokens(md, lookups())).toBe(md);
  });
});

describe('whatsNewTokens', () => {
  it('lists every token with its kind, name and caption', () => {
    expect(whatsNewTokens('{{diagram:a-b|One}}\ntext\n{{shot:c|Two }}\r\n')).toEqual([
      { kind: 'diagram', name: 'a-b', caption: 'One' },
      { kind: 'shot', name: 'c', caption: 'Two' },
    ]);
  });
});
