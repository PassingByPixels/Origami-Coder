// Where the extension host looks for the ENGINE, per platform.
//
// Everything here is asserted against an EXPLICIT platform, never the host's
// own — the trap the cron suites already had to unpick: a suite that reads
// `process.platform` passes on Windows and pins nothing, then fails the first
// time anyone runs it on the Mac it was supposed to protect.
//
// `node:os` is the only module mocked (the pattern the config suites already
// use). `node:fs` is deliberately NOT mocked: the vitest setup's realConfigGuard
// owns that mock, and replacing it here would switch the guard off for this
// file. So the probes run against REAL files in a REAL temp home instead.

import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as realOs from 'node:os';

const state = vi.hoisted(() => ({ platform: 'win32', home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const patched = { ...actual, platform: () => state.platform, homedir: () => state.home };
  return { ...patched, default: patched };
});

import { resolveOrigamiBinary, resolveEngineBinary, bundledEngineCandidate, bundledRgCandidate, bunCandidates } from '../../../src/acpClient';

const home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'origami-engine-resolve-'));
const bin = path.join(home, '.origami', 'bin');
fs.mkdirSync(bin, { recursive: true });
afterAll(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ } });

beforeEach(() => {
  state.home = home;
  // ORIGAMI_ACP_PATH short-circuits the whole search; a dev shell that happens
  // to export it would otherwise make this file pass without testing anything.
  delete process.env.ORIGAMI_ACP_PATH;
});

describe('resolveOrigamiBinary — the compiled engine, per platform', () => {
  it('takes ~/.origami/bin/origami.exe on Windows and ~/.origami/bin/origami elsewhere', () => {
    // Both names exist on disk, so the ONLY thing choosing between them is the
    // platform rule — a single-name fixture would pass with the rule deleted.
    fs.writeFileSync(path.join(bin, 'origami.exe'), '');
    fs.writeFileSync(path.join(bin, 'origami'), '');

    state.platform = 'win32';
    expect(resolveOrigamiBinary()).toBe(path.join(bin, 'origami.exe'));

    for (const nix of ['darwin', 'linux']) {
      state.platform = nix;
      expect(resolveOrigamiBinary()).toBe(path.join(bin, 'origami'));
    }
  });

  it('falls back to the bare name (a PATH lookup) when nothing is installed', () => {
    state.home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'origami-empty-home-'));
    state.platform = 'darwin';
    expect(resolveOrigamiBinary()).toBe('origami');
    state.platform = 'win32';
    expect(resolveOrigamiBinary()).toBe('origami.exe');
    fs.rmSync(state.home, { recursive: true, force: true });
  });
});

describe('resolveEngineBinary — the merged-VSIX engine wins, the dev order survives', () => {
  // bundledEngineCandidate resolves src/../engine under vitest and
  // out/../engine at runtime — the SAME package-root folder the packaging
  // script stages into. The test stages a real file there, exactly as
  // scripts/package-merged.ps1 does, and removes it after: the folder is
  // transient by design (gitignored, absent from every dev package).
  const stagedDir = path.dirname(bundledEngineCandidate());
  const unstage = () => { try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* transient */ } };
  afterAll(unstage);

  it('prefers the engine bundled inside the extension when one is staged', () => {
    fs.mkdirSync(stagedDir, { recursive: true });
    state.platform = 'win32';
    fs.writeFileSync(path.join(stagedDir, 'origami.exe'), '');
    expect(resolveEngineBinary()).toBe(path.join(stagedDir, 'origami.exe'));
    state.platform = 'darwin';
    fs.writeFileSync(path.join(stagedDir, 'origami'), '');
    expect(resolveEngineBinary()).toBe(path.join(stagedDir, 'origami'));
  });

  it('with no bundle staged it gives exactly resolveOrigamiBinary’s answer (the dev machine)', () => {
    unstage();
    // ~/.origami/bin holds both names from the suite above, so this pins the
    // fall-through reaching the stable order rather than a bare-name guess.
    fs.writeFileSync(path.join(bin, 'origami.exe'), '');
    state.platform = 'win32';
    expect(resolveEngineBinary()).toBe(resolveOrigamiBinary());
    expect(resolveEngineBinary()).toBe(path.join(bin, 'origami.exe'));
  });
});

describe('bundledRgCandidate — the merged-VSIX ripgrep, per platform', () => {
  // Same transient package-root folder the engine tests use; package-merged.ps1
  // stages rg beside the engine binary and the spawn env hands the path to the
  // engine as ORIGAMI_RG_PATH. The real defect this guards: a fresh machine
  // with no rg on PATH bricked the skill tool on the first macOS UAT, because
  // the fork keeps rg's runtime auto-download gated off.
  const stagedDir = path.dirname(bundledEngineCandidate());
  const unstage = () => { try { fs.rmSync(stagedDir, { recursive: true, force: true }); } catch { /* transient */ } };
  afterAll(unstage);

  it('returns undefined when no rg is staged (the dev, unmerged install)', () => {
    unstage();
    state.platform = 'win32';
    expect(bundledRgCandidate()).toBeUndefined();
    state.platform = 'darwin';
    expect(bundledRgCandidate()).toBeUndefined();
  });

  it('returns the staged rg, named per platform — both names on disk so only the rule chooses', () => {
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'rg.exe'), '');
    fs.writeFileSync(path.join(stagedDir, 'rg'), '');
    state.platform = 'win32';
    expect(bundledRgCandidate()).toBe(path.join(stagedDir, 'rg.exe'));
    state.platform = 'darwin';
    expect(bundledRgCandidate()).toBe(path.join(stagedDir, 'rg'));
  });
});

describe('bunCandidates — the devEngineSource interpreter, per platform', () => {
  it('Windows: the official installer path only, and it carries .exe', () => {
    expect(bunCandidates('win32', 'C:\\Users\\dev')).toEqual([
      path.join('C:\\Users\\dev', '.bun', 'bin', 'bun.exe'),
    ]);
  });

  it('macOS: ~/.bun/bin first, then BOTH Homebrew prefixes — no .exe anywhere', () => {
    const got = bunCandidates('darwin', '/Users/dev');
    expect(got[0]).toBe(path.join('/Users/dev', '.bun', 'bin', 'bun'));
    // The real defect this guards: VS Code launched from the Dock inherits a
    // minimal PATH with no Homebrew in it, so a bun installed by `brew` is
    // invisible to the bare-name fallback and dev mode silently never starts.
    expect(got).toContain('/opt/homebrew/bin/bun');   // Apple Silicon
    expect(got).toContain('/usr/local/bin/bun');      // Intel / older installs
    expect(got.some((c) => c.endsWith('.exe'))).toBe(false);
  });

  it('Linux gets the same POSIX list (one rule, not a darwin special case)', () => {
    expect(bunCandidates('linux', '/home/dev')).toEqual(bunCandidates('darwin', '/home/dev'));
  });

  it('every candidate is absolute — a relative one would resolve against the workspace', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const c of bunCandidates(platform, platform === 'win32' ? 'C:\\Users\\dev' : '/Users/dev')) {
        expect(path.isAbsolute(c) || path.posix.isAbsolute(c)).toBe(true);
      }
    }
  });
});
