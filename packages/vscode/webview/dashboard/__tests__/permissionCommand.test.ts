// Tweak 1 (host seam) — the literal shell command the permission bar renders is
// extracted host-side from the ACP ask's rawInput (permission.metadata). The
// shell tool fires TWO asks that carry a `command`: the in-repo `bash` ask
// (ToolKind 'execute') AND an `external_directory` ask (ToolKind 'other') fired
// whenever the command's AST touches a path outside the workspace. Both are
// genuine shell commands and BOTH must surface — the earlier kind==='execute'
// gate silently dropped the external_directory one, so the user approved
// out-of-repo access for a command they never saw. These assert the extraction
// against that requirement, not the implementation.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { permissionCommand } from '../../../src/dashboard/agentManager/permissionCommand';

describe('permissionCommand — literal shell command from an ACP ask', () => {
  it('surfaces the command from an in-repo bash ask', () => {
    // tool/shell.ts second ask: metadata { command } under permission "bash".
    expect(permissionCommand({ command: 'git status --porcelain' })).toBe('git status --porcelain');
  });

  it('surfaces the command from an external_directory ask (kind other) — the previously dropped path', () => {
    // tool/shell.ts first ask: metadata { command, directories, patterns } under
    // permission "external_directory", which acp/tool.ts maps to ToolKind 'other'.
    expect(
      permissionCommand({
        command: 'ls C:\\Repos\\origami',
        directories: ['C:\\Repos\\origami'],
        patterns: ['C:\\Repos\\origami\\*'],
      }),
    ).toBe('ls C:\\Repos\\origami');
  });

  it('returns undefined when the ask carries no command (edit / read / fetch asks)', () => {
    expect(permissionCommand({ filepath: '/a/b.ts' })).toBeUndefined();
    expect(permissionCommand({ url: 'https://example.test' })).toBeUndefined();
  });

  it('returns undefined for a non-string or empty command (never an invented block)', () => {
    expect(permissionCommand({ command: 123 })).toBeUndefined();
    expect(permissionCommand({ command: ['a'] })).toBeUndefined();
    expect(permissionCommand({ command: '   ' })).toBeUndefined();
  });

  it('returns undefined for absent or non-object rawInput', () => {
    expect(permissionCommand(undefined)).toBeUndefined();
    expect(permissionCommand(null)).toBeUndefined();
    expect(permissionCommand('git status')).toBeUndefined();
  });

  // Wiring pin: the host actually FEEDS rawInput into permissionCommand for the
  // requestPermission `command` field (there is no DashboardPanel unit host). A
  // mutation that re-adds a kind gate, or reads a different metadata key, would
  // change this exact call shape and fail here.
  it('is wired into onPermissionRequest for the requestPermission command field', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'),
      'utf8',
    );
    expect(src).toMatch(/command:\s*permissionCommand\(rawInput\)/);
  });
});
