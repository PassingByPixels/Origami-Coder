// claudeScanNote.test.ts — the History popup's empty state has to be
// DIAGNOSABLE from another machine (t-5nmtva): the root scanned, how many
// project folders were in it, and the key looked for.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { claudeScanNote, type ClaudeScanFacts } from './claudeScanNote';

const SCAN: ClaudeScanFacts = {
  root: 'C:\\Users\\jane_doe\\.claude\\projects',
  seen: 12,
  keys: ['c--users-jane-doe-downloads-test-rig'],
};

describe('claudeScanNote', () => {
  it('names the root, the folder count and the key when nothing came back', () => {
    const note = claudeScanNote(SCAN, true, [{ kind: 'origami' }]);
    expect(note).toContain('C:\\Users\\jane_doe\\.claude\\projects');
    expect(note).toContain('12 project folders');
    expect(note).toContain('c--users-jane-doe-downloads-test-rig');
  });

  it('says nothing once a Claude row is in the list', () => {
    expect(claudeScanNote(SCAN, true, [{ kind: 'claude' }])).toBeUndefined();
  });

  it('says nothing while the Claude kind is switched off', () => {
    expect(claudeScanNote(SCAN, false, [])).toBeUndefined();
  });

  it('says nothing when the host sent no facts (an older build)', () => {
    expect(claudeScanNote(undefined, true, [])).toBeUndefined();
  });

  it('a root that held nothing reads as zero folders, not as a missing sentence', () => {
    expect(claudeScanNote({ ...SCAN, seen: 0 }, true, [])).toContain('0 project folders');
  });

  it('no open folder is its own answer, not an empty key', () => {
    const note = claudeScanNote({ ...SCAN, keys: [] }, true, []);
    expect(note).toContain('no open folder to match');
  });

  it('many folders: the line names two and counts the rest', () => {
    const note = claudeScanNote({ ...SCAN, keys: ['a', 'b', 'c', 'd'] }, true, []);
    expect(note).toContain('a, b +2 more');
  });
});

// A MIRROR NEEDS A GUARD (t-5yejvo finding 7).
//
// `ClaudeScanFacts` crosses the wire, so the host declares it in
// src/acpExtTypes.ts and this leaf restates it. One import would be better and
// is not available: tsconfig.webview.json pins rootDir to `webview/`, so a
// webview .ts that reaches into src/ fails the type gate with TS6059 — the same
// wall labyrinthHealth.ts's `RunStatRow` hit. What was missing was not the
// import but the guard, since a host that adds a field the popup never reads
// fails silently and cosmetically, which is why a stale mirror survives.
describe('the ClaudeScanFacts mirror stays in step with the host declaration', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  /** The `name: type;` members of `export interface X { ... }`, comments and
   *  blank lines dropped. */
  function members(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const start = source.indexOf('export interface ClaudeScanFacts {');
    if (start === -1) throw new Error(`no ClaudeScanFacts in ${file}`);
    const body = source.slice(start).split('\n').slice(1);
    const out: string[] = [];
    for (const line of body) {
      const t = line.trim();
      if (t === '}') return out;
      if (!t || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')) continue;
      out.push(t.replace(/\s+/g, ' '));
    }
    throw new Error(`ClaudeScanFacts in ${file} never closes`);
  }

  it('declares the same fields, in the same order, with the same types', () => {
    const host = members(path.resolve(here, '..', '..', 'src', 'acpExtTypes.ts'));
    expect(host).toEqual(members(path.resolve(here, 'claudeScanNote.ts')));
    // Guards the reader itself: an extractor that found nothing would "agree".
    expect(host).toEqual(['root: string;', 'seen: number;', 'keys: string[];']);
  });
});
