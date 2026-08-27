// The guard that stops a test writing the developer's own global origami
// config. A guard with no test of its own is a guard that stops working
// silently — which is how the 2026-08-15 21:30 leak went unnoticed for 26
// minutes and five rotation slots.
//
// The deliberate leak is committed rather than run once and deleted: the thing
// that can rot here is the INTERCEPTION (a vitest upgrade that hands each
// importer a frozen namespace, an fs API that stops routing through the CJS
// object), and only an attempted write proves interception still happens. It is
// safe to commit precisely because the guard throws before calling through — if
// the interception ever breaks, this test writes a file it should not, so it
// asserts the byte count too, and reads the real file back to prove it did not
// move.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GUARD_MARK, guardedDir, isGuarded } from './realConfigGuard';

const REAL = path.resolve(os.homedir(), '.config', 'origami');
const patched = (fn: unknown) => Boolean((fn as Record<string, unknown>)[GUARD_MARK]);

describe('the guard knows which directory is the real one', () => {
  it('guards ~/.config/origami, resolved from the real homedir', () => {
    expect(guardedDir()).toBe(REAL);
  });

  it('matches the config file, its backups and anything else under the dir', () => {
    expect(isGuarded(path.join(REAL, 'origami.json'))).toBe(true);
    expect(isGuarded(path.join(REAL, 'origami.json.bak.3'))).toBe(true);
    expect(isGuarded(path.join(REAL, 'agent', 'x.md'))).toBe(true);
    expect(isGuarded(REAL)).toBe(true);
  });

  // The prefix test is a string compare, so the sibling directory whose name
  // merely STARTS with the guarded one must not be swept in — a real
  // ~/.config/origami-tickets is not this file's business.
  it('does not sweep in a sibling that shares the prefix', () => {
    expect(isGuarded(`${REAL}-tickets/data.jsonl`)).toBe(false);
    expect(isGuarded(path.join(os.tmpdir(), 'origami-writers-x', 'origami', 'origami.json'))).toBe(false);
  });

  it('ignores a numeric fd, which is not a path', () => {
    expect(isGuarded(3)).toBe(false);
  });
});

describe('the interception is actually installed', () => {
  // Both import forms, because production code uses the namespace and the test
  // files use both. If vitest ever stops sharing one object between them, this
  // is the assertion that says so instead of the leak saying it later.
  it('is on the namespace import and on the named import alike', () => {
    expect(patched(fs.writeFileSync), 'namespace fs.writeFileSync unpatched').toBe(true);
    expect(patched(writeFileSync), 'named writeFileSync unpatched').toBe(true);
    expect(patched(fs.renameSync), 'renameSync unpatched').toBe(true);
  });
});

describe('a deliberate leak is refused, and writes nothing', () => {
  const file = path.join(REAL, 'origami.json');

  it('a direct write at the real config file throws and leaves it byte-identical', () => {
    // Read first, so "unchanged" is measured rather than assumed.
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    expect(() => fs.writeFileSync(file, 'leaked')).toThrow(/TEST LEAK/);
    const after = fs.existsSync(file) ? fs.readFileSync(file) : null;
    expect(after === null ? null : after.length).toBe(before === null ? null : before.length);
    if (before) expect(after!.equals(before)).toBe(true);
  });

  // backupConfig() rotates with renameSync before it writes anything, so the
  // rename is the FIRST call a leaking writer makes — guarding only the write
  // would let the rotation shred the user's backup chain first.
  it('the backup rotation is refused too, at its rename', () => {
    expect(() => fs.renameSync(`${file}.bak`, `${file}.bak.1`)).toThrow(/TEST LEAK/);
  });

  it('and so is a delete', () => {
    expect(() => fs.rmSync(file)).toThrow(/TEST LEAK/);
    expect(() => fs.unlinkSync(file)).toThrow(/TEST LEAK/);
  });

  it('names the operation and the path, so the red says which writer leaked', () => {
    expect(() => fs.writeFileSync(file, 'x')).toThrow(/fs\.writeFileSync targeted the real user config/);
  });
});

describe('the temp XDG the correct code lands in', () => {
  it('points at a per-process temp dir that exists', () => {
    const xdg = process.env.XDG_CONFIG_HOME;
    expect(xdg, 'XDG_CONFIG_HOME not set by the guard').toBeTruthy();
    expect(xdg!.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(xdg!)).toBe(true);
  });
});
