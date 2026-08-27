// Unit tests for the chatCommands helpers: turn-text capture (the /loop scheduler
// reads a run's reply through it), the /loop interval scheduler, the /compose coach,
// and the shell-gate runner (the worktree setup-script path uses it). These assert
// the CONTRACT of each piece, not the implementation.

import { describe, it, expect } from 'vitest';
import {
  agentBoundary,
  collectAgentTextSince,
  parseInterval,
  formatInterval,
  parseLoopCommand,
  buildScheduledRunPrompt,
  parseLoopDone,
  buildComposePrompt,
  runGate,
  classifyBrokenGate,
} from '../../../src/dashboard/chatCommands';

describe('collectAgentTextSince (turn text capture)', () => {
  // The bug this guards: the ACP handler APPENDS an agent chunk onto the prior
  // entry when it's already kind:'agent'. A judge turn following a work turn
  // (which ends on agent text) merges in and creates NO new entry, so a naive
  // "entries since length N" read returns '' and the rubric gate silently passes.
  it('captures a turn whose text merged into the prior agent entry (the bug case)', () => {
    const log = [{ kind: 'user', text: 'go' }, { kind: 'agent', text: 'did the work' }];
    const b = agentBoundary(log);
    log[1].text += '[FAIL: c1] weak'; // judge turn appended, no new entry
    expect(collectAgentTextSince(log, b)).toBe('[FAIL: c1] weak');
  });

  it('captures a turn that started a fresh agent entry (prior entry was a tool call)', () => {
    const log = [{ kind: 'agent', text: 'work' }, { kind: 'tool', text: 'edit' }];
    const b = agentBoundary(log);
    log.push({ kind: 'agent', text: '[PASS: c1] good' });
    expect(collectAgentTextSince(log, b)).toBe('[PASS: c1] good');
  });

  it('captures BOTH the appended tail and new agent entries', () => {
    const log = [{ kind: 'agent', text: 'work' }];
    const b = agentBoundary(log);
    log[0].text += 'tail';
    log.push({ kind: 'tool', text: 'x' });
    log.push({ kind: 'agent', text: 'more' });
    expect(collectAgentTextSince(log, b)).toBe('tail\nmore');
  });

  it('returns empty when the turn added nothing', () => {
    const log = [{ kind: 'agent', text: 'work' }];
    expect(collectAgentTextSince(log, agentBoundary(log))).toBe('');
  });
});

describe('loop mode (/loop) — the interval scheduler', () => {
  it('parseInterval reads s/m/h units and rejects junk', () => {
    expect(parseInterval('45s')).toBe(45_000);
    expect(parseInterval('30m')).toBe(30 * 60_000);
    expect(parseInterval('2 min')).toBe(2 * 60_000);
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(parseInterval('90 minutes')).toBe(90 * 60_000);
    expect(parseInterval('nonsense')).toBeNull();
    expect(parseInterval('0m')).toBeNull();
    expect(parseInterval('30')).toBeNull(); // no unit
  });

  it('formatInterval round-trips to a compact human string', () => {
    expect(formatInterval(30 * 60_000)).toBe('30m');
    expect(formatInterval(2 * 3_600_000)).toBe('2h');
    expect(formatInterval(45_000)).toBe('45s');
  });

  it('parseLoopCommand splits interval + prompt, recognises stop aliases, and floors tiny intervals', () => {
    expect(parseLoopCommand('30m triage newly failing tests')).toEqual({ action: 'start', intervalMs: 30 * 60_000, prompt: 'triage newly failing tests' });
    expect(parseLoopCommand('stop')).toEqual({ action: 'stop' });
    expect(parseLoopCommand('off')).toEqual({ action: 'stop' });
    // no prompt, bad interval, or empty -> usage
    expect(parseLoopCommand('30m')).toEqual({ action: 'usage' });
    expect(parseLoopCommand('do a thing')).toEqual({ action: 'usage' });
    expect(parseLoopCommand('')).toEqual({ action: 'usage' });
    // a 1s request is floored to the 10s minimum, not run as-is
    const r = parseLoopCommand('1s watch the build');
    expect(r).toMatchObject({ action: 'start', prompt: 'watch the build' });
    if (r.action === 'start') expect(r.intervalMs).toBe(10_000);
  });

  it('accepts a SPACED interval (number + unit as two words)', () => {
    expect(parseLoopCommand('10 minutes triage failing tests')).toEqual({ action: 'start', intervalMs: 10 * 60_000, prompt: 'triage failing tests' });
    expect(parseLoopCommand('2 h nightly digest')).toEqual({ action: 'start', intervalMs: 2 * 3_600_000, prompt: 'nightly digest' });
  });

  it('caps an over-long interval so setTimeout cannot overflow into a hammer loop', () => {
    const r = parseLoopCommand('720h monthly audit'); // 30 days > setTimeout max
    expect(r).toMatchObject({ action: 'start', prompt: 'monthly audit' });
    if (r.action === 'start') expect(r.intervalMs).toBe(24 * 3_600_000); // clamped to 24h
  });

  it('treats a stop alias as stop ONLY when it is the whole argument (not a prompt starting with it)', () => {
    expect(parseLoopCommand('clear')).toEqual({ action: 'stop' });
    // a start-intent whose prompt begins with an alias word must NOT kill the loop
    expect(parseLoopCommand('cancel stuck workflow runs')).toEqual({ action: 'usage' });
    expect(parseLoopCommand('clear stale caches')).toEqual({ action: 'usage' });
  });

  it('scheduled-run prompt frames it as a recurring cycle and allows a permanent-done signal', () => {
    const p = buildScheduledRunPrompt('watch CI and report new failures');
    expect(p).toContain('watch CI and report new failures');
    expect(p.toLowerCase()).toContain('recurring');
    expect(p).toContain('LOOP-DONE');
  });

  it('parseLoopDone fires only on a line that IS the token, never an inline/negated mention', () => {
    expect(parseLoopDone('made a change\nLOOP-DONE')).toBe(true);
    expect(parseLoopDone('  LOOP-DONE  ')).toBe(true);
    expect(parseLoopDone('**LOOP-DONE**')).toBe(true);
    expect(parseLoopDone('- LOOP-DONE')).toBe(true);
    expect(parseLoopDone('loop-done')).toBe(true); // case-insensitive like the other parsers
    // must NOT fire on inline / negated / compound mentions (the weak-model risk)
    expect(parseLoopDone("I won't write LOOP-DONE yet, more to do")).toBe(false);
    expect(parseLoopDone('LOOP-DONE-NOT-YET')).toBe(false);
    expect(parseLoopDone('still working, LOOP-DONENESS is not it')).toBe(false);
    expect(parseLoopDone('nothing here')).toBe(false);
    expect(parseLoopDone('')).toBe(false);
  });
});

describe('compose coach (/compose)', () => {
  it('with a task: classifies LOOP/NEITHER, drafts a ready-to-paste /loop, carries the task', () => {
    const p = buildComposePrompt('watch CI for new failures');
    expect(p).toContain('LOOP');
    expect(p).toContain('NEITHER');
    expect(p).toContain('/loop');
    expect(p).toContain('watch CI for new failures'); // the user's task
    // The removed /goal mode must not be advertised or described as a live mode -
    // it exists nowhere (neither in-chat nor on the board) after the Kami removal.
    expect(p).not.toContain('/goal');
    expect(p).not.toContain('GOAL');
  });

  it('with no task: interviews the user instead of inventing one', () => {
    const p = buildComposePrompt('');
    expect(p.toLowerCase()).toContain('ask them');
    expect(p.toLowerCase()).toContain('wait');
    expect(p).not.toContain('Task to compose:');
  });
});

describe('runGate', () => {
  it('passes on exit 0 and fails on non-zero, keyed off the real exit code', async () => {
    const ok = await runGate('node -e "process.exit(0)"', process.cwd());
    expect(ok.passed).toBe(true);
    expect(ok.timedOut).toBe(false);

    const bad = await runGate('node -e "process.exit(3)"', process.cwd());
    expect(bad.passed).toBe(false);
  });

  it('captures command output', async () => {
    const r = await runGate('node -e "console.log(\'hello-gate\')"', process.cwd());
    expect(r.passed).toBe(true);
    expect(r.output).toContain('hello-gate');
  });

  it('reports a timeout as a fail without hanging', async () => {
    const r = await runGate('node -e "setTimeout(()=>{}, 5000)"', process.cwd(), 300);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  });
});

describe('classifyBrokenGate (the setup-gate runner reuses it)', () => {
  it('classifies from the REAL failure shape, not an output-text scan (kills the app-ENOENT false positive)', () => {
    // win32: cmd.exe's not-recognized text is the only signal — a missing command
    // exits 1, the SAME code as an ordinary failure (verified), so the text decides.
    expect(classifyBrokenGate({ code: 1, output: "'test' is not recognized as an internal or external command,\noperable program or batch file." }, true)).toBe(true);
    // ...but a command that RAN and failed while printing its OWN "ENOENT" / spawn
    // ENOENT / "command not found" text is a REAL, fixable failure — NOT a broken
    // gate. This is the false-positive class that aborted the fix loop on round 1:
    expect(classifyBrokenGate({ code: 1, output: "Error: ENOENT: no such file or directory, stat 'C:\\repo\\missing.md'" }, true)).toBe(false);
    expect(classifyBrokenGate({ code: 7, output: 'ENOENT: no such file or directory, open config.json' }, true)).toBe(false);
    expect(classifyBrokenGate({ code: 1, output: 'Error: spawn geckodriver ENOENT' }, true)).toBe(false);
    expect(classifyBrokenGate({ code: 1, output: 'command not found: docker' }, true)).toBe(false);
    expect(classifyBrokenGate({ code: 1, output: 'AssertionError: expected 1 to be 2' }, true)).toBe(false);
    // POSIX: /bin/sh exits EXACTLY 127 for command-not-found — that code is
    // authoritative, and app text on an ordinary exit code is ignored.
    expect(classifyBrokenGate({ code: 127, output: 'sh: 1: test: not found' }, false)).toBe(true);
    expect(classifyBrokenGate({ code: 1, output: 'bash: docker: command not found' }, false)).toBe(false);
    // the shell itself could not be launched -> broken regardless of platform.
    expect(classifyBrokenGate({ code: null, output: 'spawn error: EACCES', spawnFailed: true }, true)).toBe(true);
    // a passing run is never a broken gate; empty output on a fail isn't either.
    expect(classifyBrokenGate({ passed: true, code: 0, output: '' }, true)).toBe(false);
    expect(classifyBrokenGate({ code: 1, output: '' }, true)).toBe(false);
  });
});
