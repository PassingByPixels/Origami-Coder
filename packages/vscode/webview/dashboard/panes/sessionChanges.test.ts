// What the composer's changes row is allowed to claim.
//
// The counts here are hand-computed, not produced by running the code under
// test: each fixture states its own before/after and the answer a person gets
// by reading them. That is the only way this suite can catch the failure it
// exists for — `newLines - oldLines`, which reports a two-for-two replacement
// as "+0 −0" and looks perfectly reasonable in the UI.

import { describe, expect, it } from 'vitest';
import { aggregateSessionChanges, countDiffLines } from './sessionChanges';
import type { Message } from './chatMessage';

let nextId = 0;
/** A tool row shaped the way chatToolMsg.ts builds one (applyToolCall then
 *  applyToolResult), reduced to the fields this module reads. */
function toolMsg(fields: Partial<Message>): Message {
  return { id: nextId++, kind: 'tool', label: 'edit', text: 'edit', ...fields };
}
function edit(path: string, oldText: string, newText: string, extra: Partial<Message> = {}): Message {
  return toolMsg({ toolPath: path, toolDiff: { path, oldText, newText }, toolStatus: 'completed', ...extra });
}

describe('countDiffLines — real line adds/dels, not a length subtraction', () => {
  it('replacing 2 of 5 lines is +2 −2 (the case a subtraction calls +0 −0)', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB2\nC2\nd\ne';
    expect(countDiffLines(before, after)).toEqual({ adds: 2, dels: 2 });
  });

  it('inserting 3 lines into a file is +3 −0', () => {
    const before = 'a\nb';
    const after = 'a\nx\ny\nz\nb';
    expect(countDiffLines(before, after)).toEqual({ adds: 3, dels: 0 });
  });

  it('deleting 2 lines is +0 −2', () => {
    expect(countDiffLines('a\nb\nc\nd', 'a\nd')).toEqual({ adds: 0, dels: 2 });
  });

  it('an unchanged region is +0 −0', () => {
    expect(countDiffLines('a\nb\nc', 'a\nb\nc')).toEqual({ adds: 0, dels: 0 });
  });

  it('an empty oldText counts every new line as an add', () => {
    expect(countDiffLines('', 'one\ntwo\nthree')).toEqual({ adds: 3, dels: 0 });
  });

  it('an empty newText counts every old line as a del', () => {
    expect(countDiffLines('one\ntwo', '')).toEqual({ adds: 0, dels: 2 });
  });

  it('a trailing newline on both sides is not counted as a line change', () => {
    // 'a\nb\n'.split('\n') is ['a','b',''] — the empty tail matches on both
    // sides, so it must cancel rather than read as one added and one deleted.
    expect(countDiffLines('a\nb\n', 'a\nB\n')).toEqual({ adds: 1, dels: 1 });
  });

  it('an edit far inside a large file is still counted as one line, not the whole file', () => {
    // 400 identical lines with line 200 rewritten. A diff that does not trim
    // the common head and tail would report the whole middle as replaced.
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[200] = 'line 200 — changed';
    expect(countDiffLines(before.join('\n'), after.join('\n'))).toEqual({ adds: 1, dels: 1 });
  });
});

describe('aggregateSessionChanges', () => {
  it('an empty transcript is the zero state', () => {
    expect(aggregateSessionChanges([])).toEqual({ fileCount: 0, adds: 0, dels: 0, files: [] });
  });

  it('a transcript with no tool rows at all is the zero state', () => {
    const msgs: Message[] = [
      toolMsg({ kind: 'user', label: 'You', text: 'fix the parser' }),
      toolMsg({ kind: 'agent', label: 'Coder', text: 'on it' }),
    ];
    expect(aggregateSessionChanges(msgs).fileCount).toBe(0);
  });

  it('a tool that only READ a file (path, no diff) does not count as a change', () => {
    const msgs = [
      toolMsg({ toolName: 'read_file', toolPath: '/w/src/a.ts', toolStatus: 'completed' }),
      toolMsg({ toolName: 'grep', toolPath: '/w/src/b.ts', toolStatus: 'completed' }),
    ];
    expect(aggregateSessionChanges(msgs)).toEqual({ fileCount: 0, adds: 0, dels: 0, files: [] });
  });

  it('an empty oldText marks the file CREATED and counts every line as an add', () => {
    const out = aggregateSessionChanges([edit('/w/src/new.ts', '', 'one\ntwo\nthree')]);
    expect(out).toEqual({
      fileCount: 1,
      adds: 3,
      dels: 0,
      files: [{ path: '/w/src/new.ts', adds: 3, dels: 0, created: true }],
    });
  });

  it('an edit with a real oldText is NOT marked created', () => {
    const out = aggregateSessionChanges([edit('/w/src/a.ts', 'a\nb\nc\nd\ne', 'a\nB2\nC2\nd\ne')]);
    expect(out.files).toEqual([{ path: '/w/src/a.ts', adds: 2, dels: 2, created: false }]);
    expect(out).toMatchObject({ fileCount: 1, adds: 2, dels: 2 });
  });

  it('several edits to ONE file are deduped into one row and summed', () => {
    const out = aggregateSessionChanges([
      edit('/w/src/a.ts', 'a\nb', 'a\nx\ny\nz\nb'),   // +3 −0
      edit('/w/src/a.ts', 'p\nq\nr\ns', 'p\ns'),      // +0 −2
    ]);
    expect(out.fileCount).toBe(1);
    expect(out.files).toEqual([{ path: '/w/src/a.ts', adds: 3, dels: 2, created: false }]);
    expect(out).toMatchObject({ adds: 3, dels: 2 });
  });

  it('a file CREATED and then edited keeps its created mark and sums both edits', () => {
    const out = aggregateSessionChanges([
      edit('/w/src/new.ts', '', 'one\ntwo'),          // created, +2 −0
      edit('/w/src/new.ts', 'one\ntwo', 'one\nTWO'),  // +1 −1
    ]);
    expect(out.files).toEqual([{ path: '/w/src/new.ts', adds: 3, dels: 1, created: true }]);
  });

  it('two different files are two rows, in first-touched order, and the totals add up', () => {
    const out = aggregateSessionChanges([
      edit('/w/src/b.ts', '', 'x\ny'),                 // +2 −0
      edit('/w/src/a.ts', 'a\nb\nc\nd', 'a\nd'),       // +0 −2
      edit('/w/src/b.ts', 'x\ny', 'x\nY\nz'),          // +2 −1
    ]);
    expect(out.files.map((f) => f.path)).toEqual(['/w/src/b.ts', '/w/src/a.ts']);
    expect(out).toMatchObject({ fileCount: 2, adds: 4, dels: 3 });
  });

  it('a no-op edit (oldText === newText) is not a changed file', () => {
    const out = aggregateSessionChanges([edit('/w/src/a.ts', 'a\nb\nc', 'a\nb\nc')]);
    expect(out).toEqual({ fileCount: 0, adds: 0, dels: 0, files: [] });
  });

  it('a call the engine reported FAILED changed nothing, whatever content came back', () => {
    const out = aggregateSessionChanges([
      edit('/w/src/a.ts', 'a\nb', 'a\nB', { toolStatus: 'failed' }),
    ]);
    expect(out.fileCount).toBe(0);
  });

  it("falls back to the diff's own path when the ACP location is absent", () => {
    const out = aggregateSessionChanges([
      toolMsg({ toolDiff: { path: 'src/only-here.ts', oldText: 'a', newText: 'b' }, toolStatus: 'completed' }),
    ]);
    expect(out.files).toEqual([{ path: 'src/only-here.ts', adds: 1, dels: 1, created: false }]);
  });

  it('a diff with no path anywhere is dropped rather than keyed on an empty string', () => {
    const out = aggregateSessionChanges([
      toolMsg({ toolDiff: { path: '', oldText: 'a', newText: 'b' }, toolStatus: 'completed' }),
    ]);
    expect(out).toEqual({ fileCount: 0, adds: 0, dels: 0, files: [] });
  });

  it('Windows and POSIX spellings of one path do NOT merge (documented limit)', () => {
    // The wire hands back one spelling per session, so this cannot happen in
    // practice — the test pins the behaviour so a future normaliser is a
    // deliberate change and not an accident.
    const out = aggregateSessionChanges([
      edit('C:\\w\\a.ts', 'a', 'b'),
      edit('C:/w/a.ts', 'a', 'b'),
    ]);
    expect(out.fileCount).toBe(2);
  });
});
