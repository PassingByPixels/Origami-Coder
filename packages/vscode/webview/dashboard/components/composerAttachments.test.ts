import { describe, expect, it } from 'vitest';
import { readTextAttachment, MAX_TEXT_CHARS } from './composerAttachments';

// A real NUL byte, built at runtime rather than typed as a literal — keeps
// the source file itself plain text regardless of how any given tool chain
// round-trips an embedded control character.
const NUL = String.fromCharCode(0);

describe('readTextAttachment', () => {
  it('reads a small text file whole, unflagged', async () => {
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const intake = await readTextAttachment(file);
    expect(intake).toEqual({ kind: 'text', name: 'notes.txt', content: 'hello world', truncated: false });
  });

  it('truncates a file over the cap and flags it', async () => {
    const big = 'x'.repeat(MAX_TEXT_CHARS + 500);
    const file = new File([big], 'huge.log', { type: 'text/plain' });
    const intake = await readTextAttachment(file);
    expect(intake.kind).toBe('text');
    if (intake.kind === 'text') {
      expect(intake.content).toHaveLength(MAX_TEXT_CHARS);
      expect(intake.truncated).toBe(true);
    }
  });

  it('a file exactly at the cap is NOT flagged truncated', async () => {
    const exact = 'x'.repeat(MAX_TEXT_CHARS);
    const file = new File([exact], 'exact.log', { type: 'text/plain' });
    const intake = await readTextAttachment(file);
    expect(intake).toMatchObject({ truncated: false });
  });

  it('a NUL byte in the first 8 KB reads as binary — name only', async () => {
    const file = new File(['abc' + NUL + 'def'], 'binary.dat', { type: '' });
    const intake = await readTextAttachment(file);
    expect(intake).toEqual({ kind: 'binary', name: 'binary.dat' });
  });

  it('a NUL byte AFTER the 8 KB sniff window is not seen — still read as text', async () => {
    const content = 'a'.repeat(9000) + NUL;
    const file = new File([content], 'mostly-text.dat', { type: '' });
    const intake = await readTextAttachment(file);
    expect(intake.kind).toBe('text');
  });

  it('a nameless file falls back to a generic label', async () => {
    const file = new File(['x'], '', { type: 'text/plain' });
    const intake = await readTextAttachment(file);
    expect(intake.name).toBe('attachment');
  });
});
