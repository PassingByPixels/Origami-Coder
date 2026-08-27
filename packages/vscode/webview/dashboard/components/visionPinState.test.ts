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
import { VISION_MODES, visionPinLine, visionPinState, type VisionState } from './visionPinState';

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

describe('which button is the current answer', () => {
  it.each([
    ['auto-on', 'auto'],
    ['auto-off', 'auto'],
    ['on', 'on'],
    ['off', 'off'],
  ])('%s arms the %s button', (state, mode) => {
    expect(visionPinState(state as VisionState).mode).toBe(mode);
  });

  it('BOTH detected states arm Auto — a detected answer is not a pin', () => {
    // If auto-on armed On, clicking On would look like a no-op and the row's
    // "already the answer" guard would refuse to write the pin the user asked for.
    expect(visionPinState('auto-on').mode).toBe('auto');
    expect(visionPinState('auto-off').mode).toBe('auto');
  });

  it('an unknown state falls back to Auto, which is the one state that is safe', () => {
    // Auto means "detection owns this" — the behaviour a build that does not
    // understand the value should be asking for.
    expect(visionPinState('nonsense' as VisionState).mode).toBe('auto');
  });

  it('carries its line with it, so a row cannot draw one and mean the other', () => {
    for (const state of ALL) {
      expect(visionPinState(state).line).toBe(visionPinLine(state));
    }
  });
});

describe('the three choices offered', () => {
  it('is Auto, On, Off — in that order', () => {
    expect(VISION_MODES.map((m) => m.mode)).toEqual(['auto', 'on', 'off']);
    expect(VISION_MODES.map((m) => m.name)).toEqual(['Auto', 'On', 'Off']);
  });

  it('Auto is the ABSENCE of a pin on the wire, not a third pin value', () => {
    expect(VISION_MODES.find((m) => m.mode === 'auto')?.wire).toBe('');
    expect(VISION_MODES.find((m) => m.mode === 'on')?.wire).toBe('on');
    expect(VISION_MODES.find((m) => m.mode === 'off')?.wire).toBe('off');
  });

  it('every mode is reachable — each one is some state\'s answer', () => {
    const reachable = new Set(ALL.map((s) => visionPinState(s).mode));
    expect([...reachable].sort()).toEqual(VISION_MODES.map((m) => m.mode).sort());
  });

  it('each button explains what it does, and Auto names the servers that answer', () => {
    for (const m of VISION_MODES) expect(m.title.length).toBeGreaterThan(20);
    const auto = VISION_MODES.find((m) => m.mode === 'auto')!;
    expect(auto.title).toContain('LM Studio');
    expect(auto.title).toContain('Ollama');
  });
});

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
