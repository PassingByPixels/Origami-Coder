import { describe, expect, it } from 'vitest';
import { renderCollabMessage } from './collabMarkdown';

describe('renderCollabMessage — agent messages render markdown', () => {
  it('bold and headings become real elements, not literal ** and ##', () => {
    const out = renderCollabMessage('## Plan\n\n**do it now**', 'agent');
    expect(out).toContain('<h2>Plan</h2>');
    expect(out).toContain('<strong>do it now</strong>');
    expect(out).not.toContain('##');
    expect(out).not.toContain('**');
  });

  it('a fenced code block is syntax-highlighted with the shared code-block chrome', () => {
    const out = renderCollabMessage('```js\nconst x = 1;\n```', 'agent');
    expect(out).toContain('class="code-block"');
    expect(out).toContain('class="code-header"');
    expect(out).toContain('class="copy-btn"');
    expect(out).toContain('hljs-keyword'); // `const` highlighted
  });

  it('a markdown link renders as an ordinary external link, not a dead file-link', () => {
    const out = renderCollabMessage('[docs](https://example.com)', 'agent');
    expect(out).toContain('class="ext-link"');
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain('file-link');
  });

  it('plain-text special characters are entity-escaped, the same as marked always does', () => {
    const out = renderCollabMessage('3 < 5 && x > y', 'agent');
    expect(out).toBe('<p>3 &lt; 5 &amp;&amp; x &gt; y</p>');
  });

  it('trims the trailing newline marked appends, so no stray blank text node lands', () => {
    const out = renderCollabMessage('plain text', 'agent');
    expect(out).toBe('<p>plain text</p>');
  });
});

describe('renderCollabMessage — human messages stay literal', () => {
  it('markdown syntax is shown as-is, escaped, never parsed', () => {
    const out = renderCollabMessage('**not bold** and <b>not html</b>', 'human');
    expect(out).toBe('**not bold** and &lt;b&gt;not html&lt;/b&gt;');
  });

  it('newlines become <br>, matching the chat composer’s own plain-text rows', () => {
    const out = renderCollabMessage('line one\nline two', 'human');
    expect(out).toBe('line one<br>line two');
  });
});
