// A MIRROR NEEDS A GUARD.
//
// `packages/engine` is not resolvable from this package, so `PromptCapturePart`
// in src/acpExtTypes.ts is a hand-copy of `PartLabel` / `PartDelivery` in
// packages/engine/src/session/prompt-capture.ts. Nothing but a test that reads
// BOTH files keeps them in step.
//
// This is not hypothetical. Before this guard existed the mirror had already
// drifted four labels behind the engine (`collab-agent-base`, `collab-state`,
// `bot-memory`, `vision`), and nothing failed — the pane simply rendered a badge
// for a label its own type said could not occur. The failure mode of a stale
// mirror here is silent and cosmetic, which is exactly why it survives.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.resolve(here, '..', '..', '..', '..', 'engine', 'src', 'session', 'prompt-capture.ts');
const mirrorPath = path.resolve(here, '..', '..', '..', 'src', 'acpExtTypes.ts');

/**
 * The string-literal members of an `export type X = | "a" | "b"` union.
 *
 * The union's members are interleaved with doc comments, so the end is found by
 * scanning line by line until a line that is neither a `|` member, a comment,
 * nor blank — i.e. the next declaration. Stopping at the first blank line would
 * run straight past the end of a commented union and swallow the rest of the file.
 */
function unionMembers(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`no "export type ${typeName}" in the engine file`);
  const lines = source.slice(start).split('\n');
  const body: string[] = [lines[0]!];
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (t.startsWith('|') || t.startsWith('/*') || t.startsWith('*') || t === '') {
      body.push(line);
      continue;
    }
    break;
  }
  // Only the `| "member"` lines carry members — a doc comment above one may
  // quote another label's name in prose, and that must not count.
  return body
    .filter((l) => l.trim().startsWith('|') || l.includes('='))
    .flatMap((l) => [...l.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
}

/** The string-literal members of one field of the mirrored interface. */
function fieldMembers(source: string, field: string): string[] {
  const iface = source.slice(source.indexOf('export interface PromptCapturePart'));
  // The field may be optional (`delivery?:`), so match the name plus an optional `?`.
  const at = iface.search(new RegExp(`\\n\\s*${field}\\??:`));
  if (at === -1) throw new Error(`no "${field}" field on PromptCapturePart`);
  const body = iface.slice(at, iface.indexOf(';', at));
  return [...body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
}

/**
 * The field names of an `export type X = { ... }` block in the engine file.
 *
 * Line-anchored on purpose: a one-line field whose VALUE is an inline object
 * (`readonly sample: { readonly previous: string; ... }`) must count once, as
 * `sample`, not three times.
 */
function typeFields(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} = {`);
  if (start === -1) throw new Error(`no "export type ${typeName} = {" in the engine file`);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('}')) break;
    const m = /^\s*readonly (\w+)\??:/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** The field names of an `export interface Y { ... }` block in the mirror. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`no "export interface ${name}" in the mirror file`);
  const lines = source.slice(start).split('\n');
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('}')) break;
    const m = /^\s*(\w+)\??:/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

describe('the prompt-capture mirror still agrees with the engine', () => {
  const engine = readFileSync(enginePath, 'utf8');
  const mirror = readFileSync(mirrorPath, 'utf8');

  it('lists every PartLabel the engine defines, and invents none', () => {
    // Sorted comparison, not a subset check in one direction: a label removed
    // from the engine is as much a defect as one added, because the pane would
    // keep a branch for something that can no longer arrive.
    expect(fieldMembers(mirror, 'label').toSorted()).toEqual(unionMembers(engine, 'PartLabel').toSorted());
  });

  it('lists every PartDelivery the engine defines', () => {
    // The pane decides whether a part is expected to be absent from the final
    // system on this value. A new delivery site the mirror has not heard of
    // would silently fall through to the "should be in the system text" branch.
    expect(fieldMembers(mirror, 'delivery').toSorted()).toEqual(unionMembers(engine, 'PartDelivery').toSorted());
  });

  // The step digest is the cache diagnosis, and it is read by a human deciding
  // whether a session is re-billing its own context. A field the engine adds
  // and the mirror never hears about is a diagnosis silently missing a term.
  it('mirrors every field of the engine StepCapture', () => {
    expect(interfaceFields(mirror, 'PromptCaptureStep').toSorted()).toEqual(typeFields(engine, 'StepCapture').toSorted());
  });

  it('mirrors every field of the engine MessageDigest', () => {
    expect(interfaceFields(mirror, 'PromptCaptureMessageDigest').toSorted()).toEqual(
      typeFields(engine, 'MessageDigest').toSorted(),
    );
  });

  it('carries the steps field on the capture itself', () => {
    // Optional in the mirror (an older engine sends none) but it must EXIST,
    // or the pane cannot reach the digests at all.
    expect(interfaceFields(mirror, 'PromptCapture')).toContain('steps');
    expect(typeFields(engine, 'Capture')).toContain('steps');
  });
});
