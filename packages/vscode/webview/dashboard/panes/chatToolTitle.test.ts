// chatToolTitle.test.ts — the collapsed row's LABEL rules as pure data (no DOM,
// which is the point of the split: the row itself cannot be asserted here).
//
// The defect these pin: a GPT-family model's edit arrives as `apply_patch`, and
// the PENDING frame that builds the card has no patchText, so the row read
// "Edit: apply_patch" and stayed that way — the file path only reached the user
// if they expanded the card. The engine now derives a one-line title on the
// later frames; these tests say which titles the row takes and which it refuses.

import { describe, expect, it } from 'vitest';
import { toolCardTitle, updatedToolTitle } from './chatToolTitle';

describe('toolCardTitle', () => {
  it('prefixes an edit-family tool and leaves every other tool alone', () => {
    expect(toolCardTitle('edit', 'src/foo.ts')).toBe('Edit: src/foo.ts');
    expect(toolCardTitle('apply_patch', 'src/foo.ts')).toBe('Edit: src/foo.ts');
    expect(toolCardTitle('bash', 'npm test')).toBe('npm test');
  });

  it('falls back to "(tool call)" when the wire carried no title', () => {
    expect(toolCardTitle('bash', undefined)).toBe('(tool call)');
    expect(toolCardTitle('apply_patch', '')).toBe('Edit: (tool call)');
  });

  // The live PENDING frame, verbatim: the engine has no patchText yet, so the
  // only title it can send is the tool's own name. This is the row the user
  // complained about, and it is still what the card is BORN with.
  it('still shows the bare tool name on the pending frame', () => {
    expect(toolCardTitle('apply_patch', 'apply_patch')).toBe('Edit: apply_patch');
  });
});

describe('updatedToolTitle', () => {
  it('adopts a single file path for apply_patch', () => {
    expect(updatedToolTitle('apply_patch', 'src/foo.ts', undefined)).toBe('Edit: src/foo.ts');
  });

  it('adopts the multi-file count wording the engine sends', () => {
    expect(updatedToolTitle('apply_patch', '3 files', undefined)).toBe('Edit: 3 files');
  });

  // A rename is ONE file with two paths: acp/tool.ts titles it with the
  // destination while locations[0] stays the source, so the header names where
  // the file went and the path span still points at what was opened.
  it('adopts the destination path of a rename', () => {
    expect(updatedToolTitle('apply_patch', 'src/renamed.ts', undefined)).toBe('Edit: src/renamed.ts');
  });

  it('refuses a title that is only the tool name — the pending placeholder', () => {
    expect(updatedToolTitle('apply_patch', 'apply_patch', undefined)).toBeUndefined();
  });

  // apply_patch's own result title against an engine that predates the
  // flattening. Freezing beats installing the blob's first line as a header.
  it('refuses a multi-line title outright', () => {
    const blob = 'Success. Updated the following files:\nM src/a.ts\nM src/b.ts';
    expect(updatedToolTitle('apply_patch', blob, undefined)).toBeUndefined();
  });

  it('refuses an empty or absent title', () => {
    expect(updatedToolTitle('apply_patch', '   ', undefined)).toBeUndefined();
    expect(updatedToolTitle('apply_patch', undefined, undefined)).toBeUndefined();
  });

  // The scope decision, asserted rather than described: a `write` update's
  // title is just as resolved as apply_patch's, and it is STILL refused,
  // because widening adoption is what would put a `browser` failure's prose or
  // a completed tool's result text into headers that read correctly today.
  it.each(['write', 'edit', 'browser', 'task', 'read'])('freezes %s at the title its call carried', (toolName) => {
    expect(updatedToolTitle(toolName, 'src/other.ts', undefined)).toBeUndefined();
  });

  it('keeps the shell explanation rule ahead of everything else', () => {
    expect(updatedToolTitle('bash', 'ignored', { explanation: 'Run the suite' })).toBe('Run the suite');
    expect(updatedToolTitle('bash', 'ignored', { explanation: 'Run the suite', display: 'bash' })).toBe('bash: Run the suite');
  });

  it('matches the engine on tool-name case', () => {
    expect(updatedToolTitle('APPLY_PATCH', 'src/foo.ts', undefined)).toBe('Edit: src/foo.ts');
  });
});
