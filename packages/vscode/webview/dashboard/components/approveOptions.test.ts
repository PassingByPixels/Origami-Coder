// approveOptions.test.ts — the Access rail's notches, and the drift guard
// between the rail and the host that has to honour every notch on it.
//
// THE FAILURE THIS EXISTS TO CATCH is silent in both directions and invisible
// in a screenshot:
//   · a notch the host does not map falls through `modeFromApprove`'s final
//     `return { mode: 'supervised' }`, so picking "Edits" would quietly put the
//     chat on Ask — the dot moves, the supervision does not;
//   · a mode the host honours with no notch is simply unreachable, which is the
//     exact bug phase 2 fixed (Claude's acceptEdits existed on the wire from
//     phase 1 and no control could ask for it).
// So the rail is read, the host is read, and they are compared.
//
// The webview cannot import `modeFromApprove` — tsconfig.webview.json pins
// rootDir to webview/ and a .ts leaf trips TS6059 on ANY import from src/. It
// is read as TEXT instead, which is the same technique repoMapPillars.test.ts
// uses for the pillar mirror.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { actionsRowOptions, approveButtonState } from './approveButtonState';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the Access rail on an engine chat', () => {
  it('is unchanged by phase 2', () => {
    // The whole passthrough branch must be invisible to an engine chat: this is
    // the same three notches, in the same order, with nothing disabled.
    expect(actionsRowOptions(false)).toEqual([
      { value: 'default', name: 'Ask' },
      { value: 'auto', name: 'Auto' },
      { value: 'bypass', name: 'Bypass' },
    ]);
  });
});

describe('the Access rail on a Claude Code chat', () => {
  const rows = actionsRowOptions(true);

  it('offers all three of Claude\'s real supervision levels', () => {
    expect(rows.map((r) => r.value)).toEqual(['default', 'acceptEdits', 'auto', 'bypass']);
  });

  it('keeps Bypass visible but dead, with the reason on it', () => {
    const bypass = rows.find((r) => r.value === 'bypass')!;
    // Dropping the notch would read as a rendering bug; a dead notch answers
    // "why can I not pick bypass" in the place the question is asked.
    expect(bypass.disabled).toBe(true);
    expect(bypass.hint).toContain('no unsupervised lane');
  });

  it('says which of the two armed levels the chat is on', () => {
    // Both light the button, so the LABEL is the only thing that separates
    // "edits go through" from "everything goes through".
    expect(approveButtonState('acceptEdits', 'ask', true).label).toBe('Edits approved');
    expect(approveButtonState('auto', 'ask', true).label).toBe('Auto-approve');
    expect(approveButtonState('default', 'ask', true).label).toBe('Approve');
  });

  it('never wears the bypass styling, whatever it is handed', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypass']) {
      expect(approveButtonState(mode, 'bypass', true).bypass, mode).toBe(false);
    }
  });
});

describe('the rail and the host agree on every notch', () => {
  it('maps each passthrough notch to a real CLI mode', () => {
    const src = readFileSync(path.join(pkgRoot, 'src/dashboard/claudeCodePermissions.ts'), 'utf8');
    const at = src.indexOf('export function modeFromApprove');
    expect(at, 'modeFromApprove moved — update this mirror').toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}', at));
    for (const row of actionsRowOptions(true)) {
      // Bypass is the one notch deliberately without its own mapping: it is
      // disabled on the rail and CLAMPED by the host, and the clamp is asserted
      // by name in claudeCodeSeam.test.ts.
      if (row.value === 'bypass') continue;
      const mapped = row.value === 'default'
        ? /return \{ mode: 'supervised'/.test(body)
        : body.includes(`approve === '${row.value}'`);
      expect(mapped, `the host has no branch for the "${row.name}" notch (${row.value})`).toBe(true);
    }
  });

  it('offers a notch for every mode the host can be asked for', () => {
    const src = readFileSync(path.join(pkgRoot, 'src/dashboard/claudeCodePermissions.ts'), 'utf8');
    const at = src.indexOf('export function modeFromApprove');
    const body = src.slice(at, src.indexOf('\n}', at));
    const asked = [...body.matchAll(/approve === '([a-zA-Z]+)'/g)].map((m) => m[1]!);
    const offered = new Set(actionsRowOptions(true).map((r) => r.value));
    for (const value of asked) {
      expect(offered.has(value), `the host honours "${value}" but no notch can ask for it`).toBe(true);
    }
  });
});
