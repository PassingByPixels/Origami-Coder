// claudeCodeDiscoveryReport.test.ts — the two surfaces a probe trail reaches:
// the pill's tooltip and the clipboard blob.
//
// The requirement these assert against is not "the string looks nice". It is:
// a user on a machine we cannot reach must be able to paste ONE thing that says
// what was tried, where, and what each attempt returned. So the assertions are
// about COMPLETENESS and ORDER, not wording.

import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../../../src/claudeCode/discovery';
import { diagnosticsText, pillTooltip, probeSummary } from '../../../src/claudeCode/discoveryReport';

const NOTHING: DiscoveryResult = {
  probes: [
    { source: 'path', path: 'claude', result: 'missing', detail: 'where claude -> exit 1' },
    { source: 'npm-global', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', result: 'missing' },
    { source: 'native-install', path: 'C:\\Users\\u\\.local\\bin\\claude.exe', result: 'version-failed', detail: 'timed out after 5s' },
    { source: 'vscode-extension', path: 'C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code-2.1.258-win32-x64\\resources\\native-binary\\claude.exe', result: 'not-executable' },
    { source: 'system', path: 'C:\\Program Files\\Claude\\claude.exe', result: 'missing' },
  ],
};

const FOUND: DiscoveryResult = {
  found: { binary: 'C:\\Users\\u\\.local\\bin\\claude.exe', version: '2.1.198', source: 'native-install' },
  probes: [
    { source: 'path', path: 'claude', result: 'missing', detail: 'where claude -> exit 1' },
    { source: 'npm-global', path: 'C:\\x\\claude.cmd', result: 'missing' },
    { source: 'native-install', path: 'C:\\Users\\u\\.local\\bin\\claude.exe', result: 'hit', detail: '2.1.198' },
  ],
};

describe('the one-line summary', () => {
  it('names every source that was reached, in probe order', () => {
    expect(probeSummary(NOTHING.probes)).toBe(
      'PATH (missing), npm global (missing), native install (version-failed), '
      + 'VS Code extension (not-executable), system install (missing)',
    );
  });

  it('reports the ACTIONABLE verdict when one source produced several', () => {
    // A source with a missing row and a row that ran and failed must show the
    // failure: "missing" would send the user to install something they have.
    expect(probeSummary([
      { source: 'npm-global', path: 'a', result: 'missing' },
      { source: 'npm-global', path: 'b', result: 'version-failed', detail: 'EACCES' },
    ])).toBe('npm global (version-failed)');
  });

  it('omits sources the walk never reached rather than guessing at them', () => {
    expect(probeSummary(FOUND.probes)).toBe('PATH (missing), npm global (missing), native install (hit)');
  });
});

describe('the tooltip', () => {
  it('tells an undetected user what was tried, how to override it, and that a click retries', () => {
    const tip = pillTooltip(NOTHING);
    expect(tip).toContain('Claude Code — not found. Probed: PATH (missing)');
    expect(tip).toContain('VS Code extension (not-executable)');
    expect(tip).toContain('origamicoder.claudeCode.path');
    expect(tip).toContain('copy diagnostics');
    expect(tip).toContain('Click to probe again.');
  });

  it('names the binary AND how it was found when it is there', () => {
    expect(pillTooltip(FOUND)).toBe(
      'Claude Code 2.1.198 — passthrough (C:\\Users\\u\\.local\\bin\\claude.exe, via native install); '
      + 'click to open a Claude Code chat',
    );
  });
});

describe('the clipboard blob', () => {
  const ENV = { platform: 'win32', pathVar: 'C:\\Windows;C:\\Windows\\System32', setting: '' };

  it('lists every probe in order, with its path, verdict and reason', () => {
    const text = diagnosticsText(NOTHING, ENV);
    const rows = text.split('\n').filter((l) => /^\s+\d+\./.test(l));
    expect(rows).toHaveLength(NOTHING.probes.length);
    expect(rows[0]).toContain('[PATH] claude');
    expect(rows[3]).toContain('[VS Code extension]');
    expect(text).toContain('missing — where claude -> exit 1');
    expect(text).toContain('version-failed — timed out after 5s');
    expect(text).toContain('not-executable');
  });

  it('carries the three things a report from another machine cannot be read without', () => {
    const text = diagnosticsText(NOTHING, ENV);
    expect(text).toContain('platform: win32');
    expect(text).toContain('origamicoder.claudeCode.path: (unset)');
    expect(text).toContain('found: NOTHING');
    expect(text.split('\n').slice(-2)).toEqual(['  C:\\Windows', '  C:\\Windows\\System32']);
  });

  it('splits PATH on the host platform\'s separator, not on drive-letter colons', () => {
    const text = diagnosticsText(NOTHING, { ...ENV, platform: 'darwin', pathVar: '/usr/bin:/opt/homebrew/bin' });
    expect(text.split('\n').slice(-2)).toEqual(['  /usr/bin', '  /opt/homebrew/bin']);
  });

  it('names the winner when there is one', () => {
    expect(diagnosticsText(FOUND, { ...ENV, setting: 'D:\\tools\\claude.exe' }))
      .toContain('found: C:\\Users\\u\\.local\\bin\\claude.exe  version 2.1.198  via native install');
  });
});
