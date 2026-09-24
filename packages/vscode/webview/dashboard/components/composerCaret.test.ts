import { describe, expect, it } from 'vitest';
import { decodeFileUri, decodeUriList, spliceAtCaret } from './composerCaret';

describe('spliceAtCaret', () => {
  it('splices at an empty selection and places the caret after the insertion', () => {
    expect(spliceAtCaret('hello world', 5, 5, 'XXX')).toEqual({ text: 'helloXXX world', caret: 8 });
  });

  it('replaces a non-empty selection', () => {
    expect(spliceAtCaret('hello world', 6, 11, 'there')).toEqual({ text: 'hello there', caret: 11 });
  });

  it('clamps an out-of-range start/end to the text length', () => {
    expect(spliceAtCaret('abc', 99, 99, 'X')).toEqual({ text: 'abcX', caret: 4 });
  });
});

describe('decodeFileUri', () => {
  it('decodes a Windows drive path, turning / into \\', () => {
    expect(decodeFileUri('file:///C:/a/b.ts')).toBe('C:\\a\\b.ts');
  });

  it('keeps a posix path exactly as-is (forward slashes)', () => {
    expect(decodeFileUri('file:///home/user/a.ts')).toBe('/home/user/a.ts');
  });

  it('decodes percent-escaped characters (a space in the path)', () => {
    expect(decodeFileUri('file:///C:/My%20Folder/a.ts')).toBe('C:\\My Folder\\a.ts');
  });

  it('returns an unparsable URI verbatim rather than throwing', () => {
    expect(decodeFileUri('not a uri at all')).toBe('not a uri at all');
  });
});

describe('decodeUriList', () => {
  it('drops blank lines and #-comments, keeps real entries in order', () => {
    const raw = '# a comment\nfile:///C:/a.txt\n\nfile:///C:/b.txt\n';
    expect(decodeUriList(raw)).toEqual(['C:\\a.txt', 'C:\\b.txt']);
  });

  it('keeps a non-file URI as its own text', () => {
    expect(decodeUriList('https://example.com/x')).toEqual(['https://example.com/x']);
  });

  it('handles CRLF line endings', () => {
    expect(decodeUriList('file:///C:/a.txt\r\nfile:///C:/b.txt\r\n')).toEqual(['C:\\a.txt', 'C:\\b.txt']);
  });

  it('an empty payload yields no items', () => {
    expect(decodeUriList('')).toEqual([]);
  });
});
