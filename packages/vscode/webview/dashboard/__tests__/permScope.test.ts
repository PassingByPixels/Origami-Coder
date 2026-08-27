// Agent Manager S6e — REPO-SCOPED auto-approve. S5.2 auto-allowed EVERY ask from
// a background agent, so a run could write into the OS Temp dir and the user's
// Python Scripts dir. These assert the scoping decision that closes that:
// an ask is auto-allowed only when every ABSOLUTE path it carries is inside the
// session's repo root; an out-of-repo ask is auto-DENIED (never left to hang);
// chat / toggle-off / no-option all forward unchanged. Windows path semantics
// (case, separators, the C:/repo2-is-not-in-C:/repo boundary) are forced via the
// injectable `win` flag so the matrix is deterministic on any test host.

import { describe, it, expect } from 'vitest';
import {
  repoRootFromCwd,
  isPathInside,
  collectPermPaths,
  pickRejectOption,
  autoDenyNote,
  decideAgentPermission,
} from '../../../src/dashboard/agentManager/permScope';
import type { PermOption } from '../../../src/dashboard/agentManager/permissions';

// The real engine option set (allow_once / allow_always / reject_once).
const OPTS: PermOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];
const ALLOW_ONLY: PermOption[] = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
const REJECT_ONLY: PermOption[] = [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }];

// A Windows worktree cwd: the agent runs under <repoRoot>/.origami/worktrees/<x>.
const WT = 'C:\\repo\\.origami\\worktrees\\abc';
// Convenience: force Windows semantics regardless of the host OS.
const decide = (
  kind: 'chat' | 'agent' | undefined,
  autoApprove: boolean,
  cwd: string,
  options: PermOption[],
  paths: string[],
) => decideAgentPermission(kind, autoApprove, cwd, options, paths.map((p) => ({ path: p })), undefined, 'tool — detail', true);

describe('repoRootFromCwd', () => {
  it('ascends a worktree cwd to the repo root that owns it', () => {
    expect(repoRootFromCwd(WT)).toBe('C:/repo');
    expect(repoRootFromCwd('C:/repo/.origami/worktrees/x/deep/nest')).toBe('C:/repo');
  });
  it('falls back to the cwd itself (forward-slashed, no trailing slash) when there is no worktree marker', () => {
    expect(repoRootFromCwd('C:\\some\\plain\\repo\\')).toBe('C:/some/plain/repo');
  });
});

describe('isPathInside (Windows semantics forced)', () => {
  it('accepts the root itself and anything strictly beneath it', () => {
    expect(isPathInside('C:/repo', 'C:/repo', true)).toBe(true);
    expect(isPathInside('C:/repo', 'C:/repo/src/a.ts', true)).toBe(true);
  });
  it('is case-insensitive and separator-normalised on Windows', () => {
    expect(isPathInside('c:/REPO', 'C:\\repo\\src\\a.ts', true)).toBe(true);
  });
  it('enforces a prefix BOUNDARY: C:/repo2 is NOT inside C:/repo', () => {
    expect(isPathInside('C:/repo', 'C:/repo2/evil.ts', true)).toBe(false);
    expect(isPathInside('C:/repo', 'C:/repository/x', true)).toBe(false);
  });
  it('is case-SENSITIVE when not on Windows', () => {
    expect(isPathInside('/home/repo', '/home/Repo/a', false)).toBe(false);
    expect(isPathInside('/home/repo', '/home/repo/a', false)).toBe(true);
  });
});

describe('collectPermPaths', () => {
  it('gathers ACP file locations + the path-ish rawInput keys, ignoring url/command', () => {
    const got = collectPermPaths(
      [{ path: 'C:/repo/a.ts' }, { path: '' }, {}],
      { parentDir: 'C:/repo/sub', directory: 'C:/other', url: 'https://x', command: 'dotnet build', reason: 'because' },
    );
    expect(got).toEqual(['C:/repo/a.ts', 'C:/repo/sub', 'C:/other']);
  });
});

describe('pickRejectOption / autoDenyNote', () => {
  it('picks a reject option, or null when none is offered', () => {
    expect(pickRejectOption(OPTS)).toBe('reject');
    expect(pickRejectOption(ALLOW_ONLY)).toBeNull();
  });
  it('formats the deny note with the tool detail', () => {
    expect(autoDenyNote('write_file — C:/Temp/x')).toBe('⚙ auto-denied out-of-repo permission: write_file — C:/Temp/x');
    expect(autoDenyNote('   ')).toBe('⚙ auto-denied out-of-repo permission');
  });
});

describe('decideAgentPermission — scoping matrix (agent + toggle ON)', () => {
  it('ALLOWS an ask whose path is inside the worktree', () => {
    const d = decide('agent', true, WT, OPTS, ['C:\\repo\\.origami\\worktrees\\abc\\src\\file.ts']);
    expect(d.action).toBe('auto-allow');
    expect(d.optionId).toBe('once');
    expect(d.note).toContain('auto-approved permission');
  });

  it('ALLOWS a parent-repo ask (the case S5.2 existed for): under repoRoot, outside the worktree', () => {
    const d = decide('agent', true, WT, OPTS, ['C:\\repo\\package.json']);
    expect(d.action).toBe('auto-allow');
  });

  it('DENIES an OS Temp write with the reject option + an out-of-repo note (the incident)', () => {
    const d = decide('agent', true, WT, OPTS, ['C:\\Users\\u\\AppData\\Local\\Temp\\testbuild\\test.exe']);
    expect(d.action).toBe('auto-deny');
    expect(d.optionId).toBe('reject');
    expect(d.note).toBe('⚙ auto-denied out-of-repo permission: tool — detail');
  });

  it('DENIES a write into the user Python Scripts dir (the other incident path)', () => {
    expect(decide('agent', true, WT, OPTS, ['C:\\Python312\\Scripts\\foo.exe']).action).toBe('auto-deny');
  });

  it('accepts case / separator variants of an in-repo path', () => {
    expect(decide('agent', true, 'c:\\REPO\\.origami\\worktrees\\x', OPTS, ['C:/repo/src/a.ts']).action).toBe('auto-allow');
  });

  it('DENIES a prefix-boundary false sibling: C:/repo2 is not inside C:/repo', () => {
    expect(decide('agent', true, WT, OPTS, ['C:\\repo2\\evil.ts']).action).toBe('auto-deny');
  });

  it('DENIES when ANY of several paths is out of repo (all-must-be-inside)', () => {
    expect(decide('agent', true, WT, OPTS, ['C:\\repo\\ok.ts', 'C:\\Temp\\bad.ts']).action).toBe('auto-deny');
  });

  it('ALLOWS an ask with no absolute path target (a command/url ask keeps S5.2 behaviour)', () => {
    const d = decideAgentPermission('agent', true, WT, OPTS, undefined, { command: 'npm test' }, 'run — npm test', true);
    expect(d.action).toBe('auto-allow');
  });

  it('ALLOWS a relative target that RESOLVES inside the worktree', () => {
    expect(decide('agent', true, WT, OPTS, ['src/file.ts']).action).toBe('auto-allow');
    // benign `..` that still lands inside the worktree stays allowed
    expect(decide('agent', true, WT, OPTS, ['sub\\..\\src\\a.ts']).action).toBe('auto-allow');
  });

  // Defect 3/4: a `..` traversal must be RESOLVED against cwd before the inside
  // check - a raw string check let it escape the repo entirely.
  it('DENIES a relative path that `..`-escapes the repo (the incident, phrased relatively)', () => {
    // from the worktree, ..\..\..\.. climbs out of C:\repo into the OS Temp dir
    expect(decide('agent', true, WT, OPTS, ['..\\..\\..\\..\\Users\\u\\AppData\\Local\\Temp\\testbuild\\test.exe']).action).toBe('auto-deny');
  });

  it('DENIES an absolute path with embedded `..` that only PREFIXES the repo root', () => {
    // lexically starts with C:\repo\... but resolves to C:\Temp\evil.exe
    expect(decide('agent', true, WT, OPTS, ['C:\\repo\\.origami\\worktrees\\abc\\..\\..\\..\\..\\Temp\\evil.exe']).action).toBe('auto-deny');
  });

  it('ALLOWS a relative `..` that climbs only into the PARENT REPO (the S5.2 case)', () => {
    // ..\..\.. from the worktree lands back at C:\repo\package.json - still in-repo
    expect(decide('agent', true, WT, OPTS, ['..\\..\\..\\package.json']).action).toBe('auto-allow');
  });
});

describe('decideAgentPermission — forwarding (byte-identical S5.2 edges)', () => {
  it('FORWARDS a chat session regardless of scope', () => {
    expect(decide('chat', true, WT, OPTS, ['C:\\Temp\\x']).action).toBe('forward');
    expect(decide(undefined, true, WT, OPTS, ['C:\\Temp\\x']).action).toBe('forward');
  });

  it('FORWARDS an agent session with the toggle OFF', () => {
    expect(decide('agent', false, WT, OPTS, ['C:\\repo\\a.ts']).action).toBe('forward');
  });

  it('FORWARDS an in-scope ALLOW when no permissive option exists (never invents consent)', () => {
    expect(decide('agent', true, WT, REJECT_ONLY, ['C:\\repo\\a.ts']).action).toBe('forward');
  });

  it('FORWARDS an out-of-scope DENY when no reject option exists (never invents a denial)', () => {
    expect(decide('agent', true, WT, ALLOW_ONLY, ['C:\\Temp\\x']).action).toBe('forward');
  });
});
