// engineGateCoverage.test.ts — every session call a user can make before the engine is up goes
// through the chat's EngineGate (t-v5qn37, lead review item 2).
//
// Since lazy restore the pane is usable before its engine. Each AcpClient session method throws
// "<method> called before start()" until start() resolves, and the handlers turned that into a
// red Error row. engineGate.test.ts proves the gate holds work in order. THIS file proves the
// handlers use it: it reads src/dashboard/DashboardPanel.ts and fails on any session call that
// is neither inside `gate.turn(...)` nor after a `gate.whenUp()` in the same handler, unless it
// is named below with the reason it cannot run before start().

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const lines = readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8').split('\n');

/** The session methods that need a started session (each has a "called before start()" guard
 *  in src/acpClient.ts). */
const SESSION_CALL = /\.client\??\.(prompt|setConfigOption|setModel|setSessionMode|revert|unrevert)\(/;

/** Handlers whose session call cannot run before start(), and why. */
const CANNOT_RUN_BEFORE_START: Record<string, string> = {
  adoptLoadedModel: 'runs INSIDE the start (createSession start closure), after client.start() resolved',
  maybeAdoptRemoteServedModel: 'a background model probe, not a user action; its own try/catch owns a failure',
  promptSession: 'Agent Manager: createAgentSession resolves only after start() (createSession awaits startThenAnnounce)',
  setSessionModel: 'Agent Manager: same — the session it names was created by an awaited createSession',
  setSessionAgentMode: 'Agent Manager: same',
};

/** The handler a line belongs to: the nearest `case '...'`, class method, or host method above it. */
function handlerAbove(i: number): { name: string; from: number } {
  for (let j = i; j >= 0; j--) {
    const l = lines[j] ?? '';
    const m = l.match(/^ {6}case '([^']+)'/) ?? l.match(/^ {2}(?:(?:private|public|static|async)\s+)+(\w+)/) ?? l.match(/^ {6}(\w+): async /);
    if (m) return { name: m[1] ?? '', from: j };
  }
  return { name: '', from: 0 };
}

function unguardedCalls(): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!SESSION_CALL.test(line) || /^\s*\/\//.test(line)) return;
    if (/gate\.turn\(/.test(line)) return;
    const h = handlerAbove(i);
    if (lines.slice(h.from, i + 1).some((l) => /gate\.whenUp\(\)/.test(l))) return;
    if (h.name in CANNOT_RUN_BEFORE_START) return;
    out.push(`${i + 1} (${h.name}): ${line.trim().slice(0, 90)}`);
  });
  return out;
}

describe('every session call in DashboardPanel.ts waits for the engine', () => {
  it('finds the session calls it is meant to check', () => {
    expect(lines.filter((l) => SESSION_CALL.test(l)).length).toBeGreaterThan(20);
  });

  it('has no session call outside the gate', () => {
    expect(unguardedCalls()).toEqual([]);
  });

  // A fork reads the source chat's ENGINE id, which exists only once start() resolved; before
  // that, forkChat says "this chat has not started one yet". The Fork button and a typed /btw
  // both wait on the gate first (t-v5qv6u merged beside t-v5qn37).
  it('every forkChat call waits on the gate first', () => {
    const calls = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\bforkChat\(/.test(l) && !/^\s*(\/\/|import)/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const unguarded = calls.filter(({ l, i }) => !/gate\.whenUp\(\)/.test(l) && !lines.slice(handlerAbove(i).from, i).some((x) => /gate\.whenUp\(\)/.test(x)));
    expect(unguarded.map(({ i, l }) => `${i + 1}: ${l.trim().slice(0, 90)}`)).toEqual([]);
  });

  it('names no handler that no longer exists (a stale reason is not a reason)', () => {
    const names = new Set(lines.map((_, i) => handlerAbove(i).name));
    expect(Object.keys(CANNOT_RUN_BEFORE_START).filter((n) => !names.has(n))).toEqual([]);
  });
});
