// changelogSection.test.ts — the pure leaf that merges CHANGELOG.md sections into one
// summary (src/dashboard/changelogSection.ts, t-obg1yz, t-v5r1fd). No vscode, no fs:
// a plain string in, a plain string out.

import { describe, expect, it } from 'vitest';
import { mergeChangelogSince } from '../../../src/dashboard/changelogSection';

const MD = `# Changelog

Intro text that is not a section.

## 0.4.157

### Nests

- Nests from 157.

## 0.4.156

- Loose item from 156.

### Nests

- Nests from 156.

### Chat

- Chat from 156.

## 0.4.155

### Nests

- Already public.

## 0.4.5

- Ancient entry.
`;

describe('mergeChangelogSince', () => {
  it('takes every section after `from` up to and including `to`', () => {
    const out = mergeChangelogSince(MD, '0.4.155', '0.4.157');
    expect(out).toContain('Nests from 157.');
    expect(out).toContain('Nests from 156.');
    expect(out).toContain('Chat from 156.');
    expect(out).not.toContain('Already public.');
    expect(out).not.toContain('Intro text');
  });

  it('puts the same group from several versions under ONE heading, newest first, as one tight list', () => {
    const out = mergeChangelogSince(MD, '0.4.155', '0.4.157');
    expect(out.match(/^### Nests$/gm)).toHaveLength(1);
    expect(out).toContain('### Nests\n\n- Nests from 157.\n- Nests from 156.');
    expect(out.indexOf('### Nests')).toBeLessThan(out.indexOf('### Chat')); // first-seen order
  });

  it('items with no group heading go under "More changes" at the end', () => {
    const out = mergeChangelogSince(MD, '0.4.155', '0.4.157');
    expect(out).toMatch(/### More changes\n\n- Loose item from 156\.$/);
  });

  it('compares versions as numbers, so 0.4.5 is older than 0.4.155 (not a string match)', () => {
    expect(mergeChangelogSince(MD, '0.4.4', '0.4.5')).toContain('Ancient entry.');
    expect(mergeChangelogSince(MD, '0.4.5', '0.4.155')).not.toContain('Ancient entry.');
  });

  it('no lower bound takes everything up to `to`', () => {
    const out = mergeChangelogSince(MD, undefined, '0.4.155');
    expect(out).toContain('Already public.');
    expect(out).toContain('Ancient entry.');
    expect(out).not.toContain('Nests from 156.');
  });

  it('returns an empty string when no section is in range', () => {
    expect(mergeChangelogSince(MD, '0.4.157', '0.4.200')).toBe('');
    expect(mergeChangelogSince('Just notes, no headings.', undefined, '0.4.151')).toBe('');
  });

  it('reads CRLF files the same as LF files', () => {
    const crlf = MD.replace(/\n/g, '\r\n');
    expect(mergeChangelogSince(crlf, '0.4.155', '0.4.157')).toBe(mergeChangelogSince(MD, '0.4.155', '0.4.157'));
  });
});
