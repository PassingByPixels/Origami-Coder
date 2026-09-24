// Origami Remote — the coverage half of R-1. remoteVerbs.test.ts proves the
// TABLE does what it says; this file proves the table still matches the
// SHELL. Until now the allowlist was reviewed by eye against whatever the
// author remembered `chat.js` could post — which is exactly how `setModel`
// went silently dead on the phone (ORIGAMI_REMOTE_DEVICE_PASS_FINDINGS,
// 2026-09-06): a real message the picker sent had no row, and nothing said so.
//
// This scans the ACTUAL shipped webview source at test time for every
// `postMessage({ type: '...' })` a real component posts, and fails if any of
// them has neither a PHONE_VERBS row nor a NAMED_REFUSALS name (the `request*`
// prefix rule counts as covered too — it is the table's own escape hatch, and
// `remoteVerbs.test.ts` already proves it holds). A future PR that adds a new
// message type with no security review breaks THIS test, not a silent gap.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NAMED_REFUSALS, PHONE_VERBS } from '../../../src/remote/remoteVerbs';

const webviewRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `postMessage({ type: '...' })` literal in one file's text. Object-literal
 *  only (matches how every real caller in this codebase constructs the message) —
 *  a type built up in a variable would not be caught, same limitation the table's
 *  own author has when reading the source by eye, just automated instead of relied
 *  on from memory. */
export function extractPostedTypes(source: string): string[] {
  const found = new Set<string>();
  const re = /(?:vscode\.)?postMessage\(\{\s*type:\s*['"]([A-Za-z0-9_.]+)['"]/g;
  for (const m of source.matchAll(re)) found.add(m[1]);
  return [...found];
}

/** A type is covered when it has a table row, a named refusal, OR falls under
 *  the `request*` prefix rule — the three ways `verbNeeds` ever returns
 *  non-null-or-refused. Anything else is a type the table has never seen. */
export function uncoveredTypes(
  types: readonly string[],
  verbs: ReadonlyMap<string, unknown>,
  refusals: readonly string[],
): string[] {
  return types
    .filter((t) => !verbs.has(t))
    .filter((t) => !refusals.includes(t))
    .filter((t) => !t.startsWith('request'))
    .sort();
}

/** The phone SHELL's own wire verbs: every `remote/...` frame `webview/remote/`
 *  builds as an object literal. These never go through `postMessage` — they are
 *  sealed and put on the socket — so the scan above cannot see them, and a shell
 *  that invents one the desk's allowlist has never heard of is refused at
 *  `verbVerdict` with nothing but a status line to say so. */
export function extractWireVerbs(source: string): string[] {
  return [...new Set([...source.matchAll(/type: '(remote\/[a-z-]+)'/g)].map((m) => m[1]))];
}

/** Walk a directory for real, shipped webview source — `.svelte` and `.ts`,
 *  never a test, mock, harness or e2e fixture: those simulate BOTH ends of the
 *  wire and would salt the scan with host->webview types (`sessionCreated`,
 *  `restoreMessages`, `requestPermission`, …) that the phone receives, not
 *  sends. Same scope the 2026-09-06 sweep used to build the table by hand. */
function listProductionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'e2e' || entry.name === 'node_modules') continue;
      out.push(...listProductionSourceFiles(full));
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.svelte') && !lower.endsWith('.ts')) continue;
    if (lower.includes('.test.') || lower.includes('harness') || lower.includes('mock')) continue;
    out.push(full);
  }
  return out;
}

describe('extractPostedTypes / uncoveredTypes — the scanner logic, on synthetic input', () => {
  it('finds a type posted through vscode.postMessage, single- or multi-line', () => {
    const src = `
      vscode.postMessage({ type: 'send', text });
      vscode.postMessage({
        type: 'cancel',
        sessionId,
      });
    `;
    expect(extractPostedTypes(src).sort()).toEqual(['cancel', 'send']);
  });
  it('does not double-count a type posted from two call sites', () => {
    const src = `vscode.postMessage({ type: 'send' }); vscode.postMessage({ type: 'send' });`;
    expect(extractPostedTypes(src)).toEqual(['send']);
  });
  it('flags a brand-new message type that has no row and no refusal — the regression this file exists to catch', () => {
    const verbs = new Map([['send', 'ask']]);
    const refusals = ['setApproveMode'];
    const found = ['send', 'setApproveMode', 'requestFoo', 'brandNewMessageNobodyReviewed'];
    expect(uncoveredTypes(found, verbs, refusals)).toEqual(['brandNewMessageNobodyReviewed']);
  });
  it('a `request*` type needs no row at all', () => {
    expect(uncoveredTypes(['requestAnything'], new Map(), [])).toEqual([]);
  });
});

describe('the phone shell own wire verbs, scanned at test time', () => {
  const verbs = [
    ...new Set(
      listProductionSourceFiles(path.join(webviewRoot, 'remote')).flatMap((f) =>
        extractWireVerbs(readFileSync(f, 'utf8')),
      ),
    ),
  ]
    // `remote/chunk` is the transport ENVELOPE, not a verb: `chunk.ts`
    // reassembles a run into the real message BEFORE anything dispatches it, so
    // the table never sees one.
    .filter((v) => v !== 'remote/chunk')
    .sort();

  it('found the frames the shell really sends (sanity: the scan is not silently empty)', () => {
    expect(verbs).toContain('remote/hello');
    expect(verbs).toContain('remote/snapshot');
    expect(verbs).toContain('remote/cursors');
  });

  it('every one of them has a PHONE_VERBS row', () => {
    const missing = verbs.filter((v) => !PHONE_VERBS.has(v));
    expect(missing, `the shell sends these and the desk refuses them: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the real webview source, scanned at test time', () => {
  const files = listProductionSourceFiles(webviewRoot);
  const allTypes = [...new Set(files.flatMap((f) => extractPostedTypes(readFileSync(f, 'utf8'))))];

  it('found a plausible number of production message types (sanity: the scan is not silently empty)', () => {
    // A regression in the walker (wrong root, every file excluded) would make
    // every other assertion in this describe block vacuously true.
    expect(allTypes.length).toBeGreaterThan(80);
  });

  it('every type the shell can post has a PHONE_VERBS row, a NAMED_REFUSALS name, or the request* prefix', () => {
    const uncovered = uncoveredTypes(allTypes, PHONE_VERBS, NAMED_REFUSALS);
    expect(uncovered, `no disposition for: ${uncovered.join(', ')} — add a PHONE_VERBS row or a NAMED_REFUSALS name`).toEqual([]);
  });
});
