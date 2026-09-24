// What the Vision tri-state SAYS — the four rows, and the drift guard on the
// union they mirror.
//
// THE DISTINCTION UNDER TEST. `auto-on` and `on` write the identical flag into
// origami.json; nothing downstream can tell them apart, and that is the point —
// the USER has to be able to. "Auto (on — detected)" means the server answered
// and may answer differently tomorrow; "On (pinned)" means the owner decided and
// detection has been told to keep away. If those two ever read the same, the pin
// becomes invisible and the feature is back where it started.
//
// MIRRORED BY NECESSITY. `VisionState` is declared here AND in
// src/dashboard/visionPin.ts, because tsconfig.webview.json pins rootDir to
// webview/ — a component cannot import a host type. Types are erased at runtime,
// so the guard reads the host union out of its source and checks this table
// answers for every member of it. A fifth state added on the host side lands
// here as a missing row rather than as a silently blank line in the popover.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visionPinLine, type VisionState } from './visionPinState';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALL: VisionState[] = ['auto-on', 'auto-off', 'on', 'off'];

describe('the read-out line', () => {
  it.each([
    ['auto-on', 'Vision: Auto (on — detected)'],
    ['auto-off', 'Vision: Auto (off)'],
    ['on', 'Vision: On (pinned)'],
    ['off', 'Vision: Off (pinned)'],
  ])('%s reads "%s"', (state, line) => {
    expect(visionPinLine(state as VisionState)).toBe(line);
  });

  it('detected and pinned never read the same, in either direction', () => {
    expect(visionPinLine('auto-on')).not.toBe(visionPinLine('on'));
    expect(visionPinLine('auto-off')).not.toBe(visionPinLine('off'));
  });

  it('a pinned line says so in words, not by position', () => {
    // The row is three same-sized buttons; "which one is dark" is not a readable
    // answer to "did I set this, or did LM Studio?".
    expect(visionPinLine('on')).toContain('pinned');
    expect(visionPinLine('off')).toContain('pinned');
    expect(visionPinLine('auto-on')).toContain('detected');
  });

  it('an unknown wire value reads as plain Auto rather than blank', () => {
    // An older host sends no `visionState` at all; a newer one could send a state
    // this build has never heard of. Neither may paint an empty line.
    expect(visionPinLine(undefined as unknown as VisionState)).toBe('Vision: Auto (off)');
    expect(visionPinLine('auto-unknown' as VisionState)).toBe('Vision: Auto (off)');
  });
});

// WHICH CHOICE IS ARMED, and the choices on offer, moved to visionTriad.ts with
// the Auto/On/Profile redesign — see visionTriad.test.ts. They left because the
// answer stopped depending on the pin alone: an armed profile and a native model
// both change it, and neither is a fact this table has or should have.

describe('mirror drift — the host union and this table', () => {
  const host = readFileSync(path.join(pkgRoot, 'src/dashboard/visionPin.ts'), 'utf8');

  /** Pull `export type VisionState = 'a' | 'b';` out of a source file. */
  function unionOf(src: string): string[] {
    const decl = /export type VisionState =([^;]+);/.exec(src);
    if (!decl) throw new Error('no VisionState union found');
    return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  }

  it('the host declares exactly the states this table answers for', () => {
    expect(unionOf(host)).toEqual([...ALL].sort());
  });

  it('the webview copy of the union has not drifted from the host one', () => {
    const mine = readFileSync(path.join(pkgRoot, 'webview/dashboard/components/visionPinState.ts'), 'utf8');
    expect(unionOf(mine)).toEqual(unionOf(host));
  });

  it('every host state has a line of its own — no two share, none is the fallback', () => {
    // Set equality above proves nothing is missing; distinctness proves nothing
    // silently lands on the `?? LINES['auto-off']` fallback.
    const lines = unionOf(host).map((s) => visionPinLine(s as VisionState));
    expect(new Set(lines).size).toBe(lines.length);
  });
});
