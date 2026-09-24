// t-qmzegs item 5, the HOST half — what happens when a card's path is clicked.
//
// Two halves, tested where each is decidable. The path RULE is pure and is
// exercised directly. The COMMAND is a `vscode` call the extension host makes,
// and this suite has no extension host, so that claim is made against the
// panel's source: the assertion is that the route exists and calls the verb VS
// Code actually publishes. Derived from VS Code's own command id, not invented
// here — `revealFileInOS` is the id the editor registers for "Reveal in File
// Explorer" / "Reveal in Finder".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCardPath } from '../../../src/dashboard/revealPath';
import { NAMED_REFUSALS } from '../../../src/remote/remoteVerbs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(path.resolve(here, '../../../src/dashboard/DashboardPanel.ts'), 'utf8');

const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws';
const abs = (...parts: string[]) => path.join(WS, ...parts);

describe('resolveCardPath — what the host is allowed to point the OS at', () => {
  it('passes an ABSOLUTE path straight through', () => {
    // The read-image rider IS absolute, and is routinely outside the workspace
    // (a temp render, a file in another repo). Confining it to the workspace
    // would break the card this feature exists for.
    const p = abs('..', 'elsewhere', 'render.png');
    expect(resolveCardPath(p, WS)).toBe(p);
  });

  it('resolves a workspace-relative path against the workspace root', () => {
    expect(resolveCardPath('src/tool/read.ts', WS)).toBe(abs('src', 'tool', 'read.ts'));
  });

  it('REFUSES a relative path that climbs out of the workspace', () => {
    // The model writes this string. A `..` chain would otherwise hand
    // revealFileInOS a directory the workspace does not reach.
    expect(resolveCardPath('../../../Windows/System32', WS)).toBeUndefined();
    expect(resolveCardPath('a/../../..', WS)).toBeUndefined();
  });

  it('allows the workspace root itself, which is inside the workspace by definition', () => {
    expect(resolveCardPath('.', WS)).toBe(path.resolve(WS));
  });

  it('refuses a relative path when there is no workspace to resolve it against', () => {
    expect(resolveCardPath('src/main.ts', undefined)).toBeUndefined();
    expect(resolveCardPath('src/main.ts', null)).toBeUndefined();
  });

  it('refuses an empty or whitespace-only path rather than acting on the cwd', () => {
    for (const empty of ['', '   ', '\t']) expect(resolveCardPath(empty, WS), empty).toBeUndefined();
  });
});

describe('the host route', () => {
  it('handles revealInExplorer and runs VS Code\'s own reveal command', () => {
    expect(PANEL).toMatch(/case 'revealInExplorer': \{/);
    expect(PANEL).toMatch(/executeCommand\('revealFileInOS', vscode\.Uri\.file\(fsPath\)\)/);
  });

  it('routes the path through the shared guard, not an inline resolve of its own', () => {
    const route = PANEL.slice(PANEL.indexOf("case 'revealInExplorer'"));
    expect(route.slice(0, route.indexOf('break;'))).toMatch(/resolveCardPath\(/);
  });

  it('is REFUSED to a phone — there is no explorer on the other end', () => {
    // remoteVerbsCoverage.test.ts fails on any posted type with neither a
    // PHONE_VERBS row nor a refusal; this says which of the two was intended,
    // so the coverage test passing is a decision and not an accident.
    expect(NAMED_REFUSALS).toContain('revealInExplorer');
  });
});
