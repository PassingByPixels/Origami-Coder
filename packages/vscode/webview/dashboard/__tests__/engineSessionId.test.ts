// The wire boundary for chat identity: what a session-scoped ACP ext-method is
// allowed to name, and what it must refuse to name.
//
// The bug this file guards is not hypothetical — it shipped in 0.4.12 and a
// user's exported transcript ends on it:
//
//     [!ERROR] Interject failed: Invalid params: session not found: session-3
//
// `session-3` is the WEBVIEW's id for the chat. The engine has never heard of
// it, so it answers with a raw "Invalid params" and the interjection is lost.
// 0.4.14 fixed the interject and shell_stop call sites; the tests here are
// about the rest of the class — a second call site that still fell back to the
// local id, and the mint whose shape this leaf mirrors.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { engineSessionId, isLocalSessionId } from '../../../src/dashboard/engineSessionId';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const LOCAL = 'session-3';
const ENGINE = 'ses_feb9engine';

describe('engineSessionId — only the engine may name the session on the wire', () => {
  it('hands over the engine id when the chat has one', () => {
    expect(engineSessionId({ currentSessionId: ENGINE }, LOCAL)).toBe(ENGINE);
  });

  it('answers null — never the local id — when the handshake has not finished', () => {
    expect(engineSessionId({ currentSessionId: null }, LOCAL)).toBeNull();
    expect(engineSessionId(null, LOCAL)).toBeNull();
    expect(engineSessionId(undefined, LOCAL)).toBeNull();
  });

  it('refuses a LOCAL id that reached currentSessionId by another route', () => {
    // AcpClient.start() assigns `this.sessionId = loadSessionId` verbatim, so a
    // recall path that ever passed a webview id would put one there. It still
    // must not cross: this is the exact value that produced the live error.
    expect(engineSessionId({ currentSessionId: LOCAL }, LOCAL)).toBeNull();
    expect(engineSessionId({ currentSessionId: 'session-11' }, LOCAL)).toBeNull();
  });

  it('does not mistake an engine id that merely reads like one', () => {
    // The refusal has to be narrow, or a legitimate id gets dropped and the
    // control goes silently inert — a quieter version of the same bug.
    expect(isLocalSessionId('ses_session-3')).toBe(false);
    expect(isLocalSessionId('session-abc')).toBe(false);
    expect(engineSessionId({ currentSessionId: 'ses_3' }, LOCAL)).toBe('ses_3');
  });

  it('mirrors DashboardPanel.ts’s local-id mint — a drift guard, both files read', () => {
    // Part 5 of WORKING_ON_ORIGAMI_CODER.md: a mirrored constant needs a test
    // that reads BOTH files. If the panel starts minting `chat-7`, this leaf's
    // matcher stops recognising the thing it exists to refuse, silently.
    const panel = readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8');
    const mint = /const sessionId = `([^`]+)`/.exec(panel)?.[1];
    expect(mint, 'DashboardPanel.ts no longer mints local ids from a template literal — re-point this guard').toBeTruthy();
    expect(isLocalSessionId(mint!.replace(/\$\{[^}]+\}/, '7')), `the mint is now ${mint}`).toBe(true);
  });
});

describe('no wire-bound session id falls back to the id the webview holds', () => {
  // A source scan, because the site it guards lives inside DashboardPanel.ts's
  // message switch, which cannot be reached from vitest (it imports `vscode`).
  // The pattern it catches was real: `plan_action` sent
  // `session.client.currentSessionId ?? sid ?? ''`, so a chat whose engine had
  // not answered yet named itself `session-N` to the engine.
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(pkgRoot, rel), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${rel}/${entry.name}`);
      else if (entry.name.endsWith('.ts')) files.push(`${rel}/${entry.name}`);
    }
  };
  walk('src');

  it('no `currentSessionId ?? <some other id>` anywhere in src/', () => {
    // A scan that found no files would pass while asserting nothing — the
    // failure mode this repo has been bitten by before. Say so out loud.
    expect(files.length, 'the walk found no source to scan — re-point pkgRoot').toBeGreaterThan(50);
    // `?? null` / `?? undefined` are fine: both mean "there is no engine id",
    // which is the honest answer. Only a fallback to another VALUE is the bug.
    const offenders: string[] = [];
    for (const rel of files) {
      readFileSync(path.join(pkgRoot, rel), 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        // Prose may quote the pattern — this leaf's own header does. Only a
        // line of CODE can put an id on the wire.
        if (code.startsWith('//') || code.startsWith('*')) return;
        if (/currentSessionId\s*\?\?\s*(?!undefined\b|null\b)[A-Za-z_$][\w$]*/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${code}`);
        }
      });
    }
    expect(offenders, 'resolve through engineSessionId() and report a reason instead').toEqual([]);
  });
});
