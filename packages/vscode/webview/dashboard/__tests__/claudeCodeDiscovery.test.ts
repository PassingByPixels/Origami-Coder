// claudeCodeDiscovery.test.ts — WHICH binary a passthrough session spawns, and
// WHAT IT RECORDS about everything it tried.
//
// Two things this file exists to hold still.
//
// 1. THE SECURITY RULE. Origami once shipped a foreign-agent feature where a
//    checked-in definition could name the executable to spawn. Detection was
//    written with no configuration hook at all so that could not come back.
//    There IS an override now (`origamicoder.claudeCode.path`) because a work
//    PC could not be debugged without one — and it is declared `"scope":
//    "machine"` in package.json, which is what stops a repository setting it.
//    The last describe block asserts that scope against the real manifest; if
//    someone widens it, this suite goes red.
//
// 2. THE PROBE TRAIL. The round that produced this file started as "it didn't
//    pick up the Claude CLI on my work PC", and the only evidence available was
//    the sentence "install the CLI". Every candidate now records a verdict, so
//    the answer arrives with the report.
//
// NOTHING HERE TOUCHES THE REAL FILESYSTEM. Every dep is a fixture: a real
// `~/.vscode` scan or a real `claude --version` in a unit test would make the
// suite depend on the machine it runs on, which is the exact bug class above.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VERSION_FLOOR, discoverClaudeCli, meetsFloor, parseVersion,
  type DiscoveryDeps, type ProbeSource,
} from '../../../src/claudeCode/discovery';
import {
  CLAUDE_PATH_SETTING, extensionBinary, fileCandidates, needsShell,
} from '../../../src/claudeCode/discoveryProbes';

const HOME = 'C:\\Users\\u';
const ENV = {
  USERPROFILE: HOME,
  LOCALAPPDATA: `${HOME}\\AppData\\Local`,
  APPDATA: `${HOME}\\AppData\\Roaming`,
  PROGRAMFILES: 'C:\\Program Files',
};
// The real banner, from `claude --version` on the machine the contract was
// captured on (CLI 2.1.198).
const VERSION_BANNER = '2.1.198 (Claude Code)\n';

/** Where each source's FIRST candidate lands, given ENV above. */
const AT = {
  setting: 'D:\\tools\\claude.exe',
  path: 'C:\\shims\\claude.exe',
  'npm-global': `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`,
  'native-install': `${HOME}\\.claude\\local\\claude.exe`,
  'vscode-extension': `${HOME}\\.vscode\\extensions\\anthropic.claude-code-2.1.258-win32-x64\\resources\\native-binary\\claude.exe`,
  system: `${HOME}\\AppData\\Local\\Programs\\claude\\claude.exe`,
} as const;

const EXT_ROOT = `${HOME}\\.vscode\\extensions`;
const EXT_DIRS = ['anthropic.claude-code-2.1.9-win32-x64', 'anthropic.claude-code-2.1.258-win32-x64', 'passing-claude-theme-1.0.0'];

function deps(over: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    platform: 'win32',
    env: ENV,
    setting: () => '',
    stat: () => 'none',
    listDir: () => [],
    version: async () => ({ ok: true, stdout: VERSION_BANNER }),
    which: async () => ({ hits: [], detail: 'where claude -> exit 1' }),
    ...over,
  };
}

/** Only this one path is a runnable file; everything else is absent. */
const onlyAt = (wanted: string) => (p: string) => (p === wanted ? 'file' as const : 'none' as const);

describe('every source can be the one that finds it', () => {
  const cases: Array<[ProbeSource, Partial<DiscoveryDeps>]> = [
    ['setting', { setting: () => AT.setting, stat: onlyAt(AT.setting) }],
    ['path', { which: async () => ({ hits: [AT.path], detail: 'ok' }), stat: onlyAt(AT.path) }],
    ['npm-global', { stat: onlyAt(AT['npm-global']) }],
    ['native-install', { stat: onlyAt(AT['native-install']) }],
    ['vscode-extension', {
      stat: onlyAt(AT['vscode-extension']),
      listDir: (d) => (d === EXT_ROOT ? EXT_DIRS : []),
    }],
    ['system', { stat: onlyAt(AT.system) }],
  ];

  for (const [source, over] of cases) {
    it(`finds the CLI at the ${source} location when it is the ONLY one present`, async () => {
      const result = await discoverClaudeCli(deps(over));
      expect(result.found).toEqual({ binary: AT[source], version: '2.1.198', source });
      // …and the row that found it says so, rather than the trail ending blank.
      expect(result.probes.filter((p) => p.result === 'hit')).toEqual([{ source, path: AT[source], result: 'hit', detail: '2.1.198' }]);
    });
  }
});

describe('probe order', () => {
  // MUTATION GUARD. Swap any two rows in discoveryProbes.ts's tables, or move
  // the `which` call in discovery.ts, and this list stops matching. Recorded
  // when NOTHING validates, which is the case the diagnostics exist for.
  it('walks setting -> PATH -> npm global -> native install -> VS Code extension -> system, and records every step', async () => {
    const result = await discoverClaudeCli(deps({
      setting: () => AT.setting,
      stat: () => 'file',
      listDir: (d) => (d === EXT_ROOT ? EXT_DIRS : []),
      which: async () => ({ hits: [AT.path], detail: 'ok' }),
      version: async () => ({ ok: false, error: 'not the claude you are looking for' }),
    }));
    expect(result.found).toBeUndefined();
    expect(result.probes.map((p) => [p.source, p.path])).toEqual([
      ['setting', AT.setting],
      ['path', AT.path],
      ['npm-global', `${HOME}\\AppData\\Roaming\\npm\\claude.cmd`],
      ['native-install', `${HOME}\\.claude\\local\\claude.exe`],
      ['native-install', `${HOME}\\.claude\\local\\bin\\claude.exe`],
      ['native-install', `${HOME}\\.local\\bin\\claude.exe`],
      ['vscode-extension', AT['vscode-extension']],
      ['system', `${HOME}\\AppData\\Local\\Programs\\claude\\claude.exe`],
      ['system', `${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`],
      ['system', 'C:\\Program Files\\Claude\\claude.exe'],
    ]);
  });

  // t-vd9s7z, the owner's PC: the standalone CLI on PATH stopped updating at
  // 2.1.198 while the VS Code Claude Code extension ships 2.1.281. First-hit
  // discovery took PATH, and the subscription route said "version too old".
  it('picks the NEWEST binary that runs, not the first one found', async () => {
    const oldPath = `${HOME}\\.local\\bin\\claude.exe`;
    const extBin = `${EXT_ROOT}\\anthropic.claude-code-2.1.281-win32-x64\\resources\\native-binary\\claude.exe`;
    const result = await discoverClaudeCli(deps({
      which: async () => ({ hits: [oldPath], detail: 'ok' }),
      stat: (p) => (p === oldPath || p === extBin ? 'file' : 'none'),
      listDir: (d) => (d === EXT_ROOT ? ['anthropic.claude-code-2.1.281-win32-x64'] : []),
      version: async (b) => ({ ok: true, stdout: b === extBin ? '2.1.281 (Claude Code)\n' : VERSION_BANNER }),
    }));
    expect(result.found).toEqual({ binary: extBin, version: '2.1.281', source: 'vscode-extension' });
  });

  it('keeps probe order on a tie', async () => {
    const result = await discoverClaudeCli(deps({ stat: () => 'file' }));
    expect(result.found?.source).toBe('npm-global'); // the first FILE candidate, every one says 2.1.198
  });

  it('asks each file once: PATH and the native-install row naming the same file cost one --version', async () => {
    const same = `${HOME}\\.local\\bin\\claude.exe`;
    const asked: string[] = [];
    const result = await discoverClaudeCli(deps({
      which: async () => ({ hits: [same.toUpperCase()], detail: 'ok' }), // `where` may differ in case
      stat: (p) => (p.toLowerCase() === same.toLowerCase() ? 'file' : 'none'),
      version: async (b) => { asked.push(b); return { ok: true, stdout: VERSION_BANNER }; },
    }));
    expect(asked).toEqual([same.toUpperCase()]);
    expect(result.found?.source).toBe('path');
  });

  it('ranks a hit whose banner has no version below one that has', async () => {
    const result = await discoverClaudeCli(deps({
      stat: () => 'file',
      version: async (b) => ({ ok: true, stdout: b === AT['npm-global'] ? 'odd banner' : VERSION_BANNER }),
    }));
    expect(result.found?.source).toBe('native-install');
  });

  it('lets the setting beat a perfectly good CLI on PATH', async () => {
    const result = await discoverClaudeCli(deps({
      setting: () => AT.setting,
      stat: () => 'file',
      which: async () => ({ hits: [AT.path], detail: 'ok' }),
    }));
    expect(result.found?.binary).toBe(AT.setting);
    expect(result.probes).toHaveLength(1); // PATH was never even asked
  });

  it('falls through a setting that points at nothing, rather than bricking the feature', async () => {
    const result = await discoverClaudeCli(deps({
      setting: () => 'D:\\gone\\claude.exe',
      stat: onlyAt(AT['native-install']),
    }));
    expect(result.found?.source).toBe('native-install');
    expect(result.probes[0]).toEqual({ source: 'setting', path: 'D:\\gone\\claude.exe', result: 'missing' });
  });
});

describe('what a candidate is allowed to count as', () => {
  // MUTATION GUARD. Delete the `if (!out.ok)` branch in discovery.ts and this
  // fails twice over: the trail loses its reason, and a binary that cannot
  // answer --version is adopted and then fails at the user's first prompt.
  it('records a candidate that exists but will not answer --version, and keeps going', async () => {
    const result = await discoverClaudeCli(deps({
      stat: () => 'file',
      version: async (b) => (b.endsWith('.local\\bin\\claude.exe')
        ? { ok: true, stdout: VERSION_BANNER }
        : { ok: false, error: 'EACCES: blocked by policy' }),
    }));
    expect(result.found?.binary).toBe(`${HOME}\\.local\\bin\\claude.exe`);
    // Every source is probed now (t-vd9s7z), so the rows after the hit are recorded too.
    const failed = (path: string) => ({ path, result: 'version-failed', detail: 'EACCES: blocked by policy' });
    expect(result.probes.filter((p) => p.result === 'version-failed').map(({ source: _s, ...rest }) => rest)).toEqual([
      failed(AT['npm-global']),
      failed(AT['native-install']),
      failed(`${HOME}\\.claude\\local\\bin\\claude.exe`),
      failed(AT.system),
      failed(`${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe`),
      failed('C:\\Program Files\\Claude\\claude.exe'),
    ]);
  });

  it('separates "nothing there" from "there but not runnable"', async () => {
    const result = await discoverClaudeCli(deps({
      stat: (p) => (p === AT['npm-global'] ? 'other' : 'none'),
    }));
    expect(result.found).toBeUndefined();
    expect(result.probes.find((p) => p.path === AT['npm-global'])?.result).toBe('not-executable');
    expect(result.probes.find((p) => p.path === AT.system)?.result).toBe('missing');
  });

  it('says WHY PATH produced nothing instead of leaving the row silent', async () => {
    const result = await discoverClaudeCli(deps({ which: async () => ({ hits: [], detail: 'where claude -> exit 1' }) }));
    expect(result.probes[0]).toEqual({ source: 'path', path: 'claude', result: 'missing', detail: 'where claude -> exit 1' });
  });
});

describe('a .cmd shim', () => {
  // Node has refused to spawn a batch file without a shell since the
  // CVE-2024-27980 fix. An npm -g install on Windows has NO other entry point,
  // so probing it without the shell flag reports every npm user as CLI-less.
  it('is version-checked through the shell, and a real executable is not', async () => {
    const asked: Array<[string, boolean]> = [];
    await discoverClaudeCli(deps({
      stat: () => 'file',
      version: async (b, shell) => { asked.push([b, shell]); return { ok: false, error: 'x' }; },
    }));
    expect(asked[0]).toEqual([AT['npm-global'], true]);
    expect(asked[1]).toEqual([AT['native-install'], false]);
  });

  it('classifies by extension, case-insensitively', () => {
    expect(needsShell('C:\\x\\claude.cmd')).toBe(true);
    expect(needsShell('C:\\x\\claude.BAT')).toBe(true);
    expect(needsShell('C:\\x\\claude.exe')).toBe(false);
    expect(needsShell('/usr/local/bin/claude')).toBe(false);
  });
});

describe("the VS Code extension's bundled binary", () => {
  it('picks the NEWEST version numerically — a string sort would take 2.1.9 over 2.1.258', () => {
    const found = extensionBinary('win32', ENV, (d) => (d === EXT_ROOT ? EXT_DIRS : []));
    expect(found).toBe(AT['vscode-extension']);
  });

  it('scans Insiders and the server root too — a work PC is where the plain desktop host is not the one running', () => {
    const insiders = `${HOME}\\.vscode-insiders\\extensions`;
    const found = extensionBinary('win32', ENV, (d) => (d === insiders ? ['anthropic.claude-code-2.0.1-win32-x64'] : []));
    expect(found).toBe(`${insiders}\\anthropic.claude-code-2.0.1-win32-x64\\resources\\native-binary\\claude.exe`);
  });

  it('yields nothing when the extension is not installed', () => {
    expect(extensionBinary('win32', ENV, () => [])).toBeNull();
    expect(extensionBinary('win32', ENV, () => ['ms-python.python-2024.1.0'])).toBeNull();
  });
});

describe('the table', () => {
  it('drops a candidate whose variable is unset rather than half-expanding it', () => {
    const paths = fileCandidates('win32', {}, () => []).map((c) => c.path);
    expect(paths).toEqual([]);
    expect(fileCandidates('win32', ENV, () => []).every((c) => !c.path.includes('${'))).toBe(true);
  });

  it('is a different table on darwin — homebrew and /usr/local, no .exe, no winget', () => {
    const paths = fileCandidates('darwin', { HOME: '/Users/u' }, () => []).map((c) => c.path);
    expect(paths).toEqual([
      '/Users/u/.npm-global/bin/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/Users/u/.claude/local/claude',
      '/Users/u/.claude/local/bin/claude',
      '/Users/u/.local/bin/claude',
    ]);
  });
});

describe('version', () => {
  it('reads the number out of the real banner', () => {
    expect(parseVersion(VERSION_BANNER)).toBe('2.1.198');
    expect(parseVersion('nothing numeric here')).toBe('');
  });

  it('compares against the floor without refusing an unreadable banner', () => {
    expect(meetsFloor('2.1.198', VERSION_FLOOR)).toBe(true);
    expect(meetsFloor('2.0.9', VERSION_FLOOR)).toBe(false);
    expect(meetsFloor('3.0', VERSION_FLOOR)).toBe(true);
    expect(meetsFloor('', VERSION_FLOOR)).toBe(true); // unknown != unusable
  });
});

describe('no repository may name the binary', () => {
  // The override exists, so "there is no config hook" is no longer the guard.
  // THE SCOPE is. VS Code refuses to read a machine-scoped setting out of a
  // workspace or folder settings file, so a checked-in .vscode/settings.json
  // cannot redirect the executable we spawn. Read from the REAL manifest — a
  // constant mirrored in a test would not catch the manifest changing.
  it('declares the override machine-scoped in package.json', () => {
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { scope?: string; type?: string }> } };
    };
    const prop = manifest.contributes.configuration.properties[CLAUDE_PATH_SETTING];
    expect(prop, `${CLAUDE_PATH_SETTING} is missing from the manifest`).toBeDefined();
    expect(prop!.scope).toBe('machine');
    expect(prop!.type).toBe('string');
  });

  it('reads the override through a dep, so nothing in the walk can open a file to get it', () => {
    expect(Object.keys(deps()).sort())
      .toEqual(['env', 'listDir', 'platform', 'setting', 'stat', 'version', 'which']);
  });
});
