// pathLinks.ts on strings — the edge cases of the delimited-path rules
// (t-v486mk). The full click chain is covered in MessageRow.test.ts.
import { describe, expect, it } from 'vitest';
import { linkifyPaths } from './pathLinks';

const paths = (html: string) => [...linkifyPaths(html).matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]);

describe('linkifyPaths — delimited paths', () => {
  it('an apostrophe earlier in the line does not steal the quote that opens a path', () => {
    // "it's in '" is tried as a quoted run first and fails; its closing quote
    // must still be free to open the real one.
    expect(paths('it&#39;s in &#39;C:\\a b\\c.py&#39; now')).toEqual(['C:\\a b\\c.py']);
  });

  it('a quoted phrase that is not a path is left byte-for-byte unchanged', () => {
    const html = '<p>he said &quot;hello world&quot; and &#39;ok then&#39;</p>';
    expect(linkifyPaths(html)).toBe(html);
  });

  it('an entity in a path is decoded for data-path and kept escaped in the text', () => {
    const out = linkifyPaths('<code>C:\\R&amp;D docs\\x.py</code>');
    expect(out).toBe('<code><a class="file-link" data-path="C:\\R&amp;D docs\\x.py">C:\\R&amp;D docs\\x.py</a></code>');
  });

  it('a UNC path with a space links whole', () => {
    expect(paths('<code>\\\\server\\my share\\a.txt</code>')).toEqual(['\\\\server\\my share\\a.txt']);
  });

  it('a comma list in backticks stays two paths', () => {
    expect(paths('<code>src/a.ts,src/b.ts</code>')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('a directory (no file extension) with a space is not linked as one path', () => {
    expect(paths('<code>C:\\Program Files\\Foo</code>')).toEqual([]);
  });

  it('stays fast on a long line full of unmatched quotes and brackets', () => {
    const blob = '&quot;a b &#39;c [d](e '.repeat(5000);
    const t = performance.now();
    linkifyPaths(blob);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
