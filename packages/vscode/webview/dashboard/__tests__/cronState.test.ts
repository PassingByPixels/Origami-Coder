// cronState — .origami/crons.json, the git-trackable truth. This file is meant
// to be hand-edited and committed, so the tests here are about not destroying
// someone's work: a corrupt file is backed up rather than clobbered, a single
// malformed entry is reported rather than silently dropped, and fields written
// by a newer Origami survive a round-trip through this one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cronsFilePath, loadCrons, parseCronRecord, saveCrons, type CronRecord } from '../../../src/dashboard/crons/cronState';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-crons-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (text: string) => {
  fs.mkdirSync(path.join(root, '.origami'), { recursive: true });
  fs.writeFileSync(cronsFilePath(root), text);
};

const cron = (over: Partial<CronRecord> = {}): CronRecord => ({
  id: 'c1', name: 'nightly', prompt: 'triage', schedule: { kind: 'daily', time: '09:30' },
  enabled: true, createdAt: 1000, ...over,
});

describe('cronState — round-trip', () => {
  it('a missing file is simply no crons, not an error', () => {
    expect(loadCrons(root)).toEqual({ crons: [], invalid: [], recovered: false });
  });

  it('saves and reads back a cron unchanged', () => {
    saveCrons(root, [cron({ agent: 'scout', model: 'anthropic/claude', taskName: '\\Origami\\c1', lastSyncedAt: 2000 })]);
    const { crons, invalid } = loadCrons(root);
    expect(invalid).toEqual([]);
    expect(crons).toEqual([cron({ agent: 'scout', model: 'anthropic/claude', taskName: '\\Origami\\c1', lastSyncedAt: 2000 })]);
  });

  it('writes readable, diffable JSON — this file lives in git', () => {
    saveCrons(root, [cron()]);
    const text = fs.readFileSync(cronsFilePath(root), 'utf8');
    expect(text).toContain('\n  "version": 1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('leaves no temp file behind', () => {
    saveCrons(root, [cron()]);
    expect(fs.readdirSync(path.join(root, '.origami')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('cronState — a corrupt file is recovered from, never overwritten blind', () => {
  it('backs up unparseable JSON beside itself and starts empty', () => {
    write('{ this is not json at all');
    const res = loadCrons(root);
    expect(res.recovered).toBe(true);
    expect(res.crons).toEqual([]);
    expect(res.backupPath).toBeDefined();
    // The user's bytes still exist, verbatim — that is the whole point.
    expect(fs.readFileSync(res.backupPath!, 'utf8')).toBe('{ this is not json at all');
  });

  it('backs up valid JSON of the WRONG SHAPE too (e.g. a bare array)', () => {
    write('[{"id":"c1"}]');
    const res = loadCrons(root);
    expect(res.recovered).toBe(true);
    expect(res.backupPath).toBeDefined();
    expect(fs.readFileSync(res.backupPath!, 'utf8')).toBe('[{"id":"c1"}]');
  });

  it('a later save after recovery does not destroy the backup', () => {
    write('garbage');
    const res = loadCrons(root);
    saveCrons(root, [cron()]);
    expect(fs.existsSync(res.backupPath!)).toBe(true);
    expect(loadCrons(root).crons).toHaveLength(1);
  });
});

describe('cronState — a malformed ENTRY is reported, not silently dropped', () => {
  it('keeps the good crons and reports the bad one with a reason', () => {
    write(JSON.stringify({
      version: 1,
      crons: [
        cron({ id: 'good' }),
        { id: 'bad', name: 'broken', prompt: 'x', schedule: { kind: 'hourly', every: 24 } },
      ],
    }));
    const res = loadCrons(root);
    expect(res.crons.map((c) => c.id)).toEqual(['good']);
    expect(res.invalid).toHaveLength(1);
    expect(res.invalid[0].reason).toContain('bad');
    // The original entry is handed back so the pane can show what was written.
    expect(res.invalid[0].raw).toMatchObject({ id: 'bad' });
  });

  it('reports entries missing required fields rather than inventing defaults', () => {
    expect(parseCronRecord({ name: 'x', prompt: 'y', schedule: { kind: 'daily', time: '09:30' } }).ok).toBe(false);
    expect(parseCronRecord({ id: 'c', prompt: 'y', schedule: { kind: 'daily', time: '09:30' } }).ok).toBe(false);
    expect(parseCronRecord({ id: 'c', name: 'x', schedule: { kind: 'daily', time: '09:30' } }).ok).toBe(false);
    expect(parseCronRecord(null).ok).toBe(false);
    expect(parseCronRecord('nope').ok).toBe(false);
  });

  it('an entry whose schedule cannot be translated is invalid — it must never be treated as runnable', () => {
    const res = parseCronRecord({ id: 'c', name: 'x', prompt: 'y', schedule: { kind: 'cron', expr: '0 9 * * 1-5' } });
    expect(res.ok).toBe(false);
  });
});

describe('cronState — hand-editing tolerance', () => {
  it('a hand-written cron omitting "enabled" defaults to enabled, not disabled', () => {
    // Someone adding a cron by hand in a PR expects it to run.
    const res = parseCronRecord({ id: 'c', name: 'x', prompt: 'y', schedule: { kind: 'daily', time: '09:30' } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.cron.enabled).toBe(true);
  });

  it('a hand-written cron EXPRESSION is normalised into a translated schedule on load', () => {
    const res = parseCronRecord({ id: 'c', name: 'x', prompt: 'y', schedule: { kind: 'cron', expr: '30 9 * * *' } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.cron.schedule).toEqual({ kind: 'daily', time: '09:30' });
  });

  it('fields we do not model are preserved through a load/save round-trip', () => {
    // A cron written by a NEWER Origami must not be quietly stripped by this one.
    write(JSON.stringify({
      version: 1,
      crons: [{ ...cron(), futureField: { retries: 3 } }],
    }));
    const loaded = loadCrons(root);
    expect((loaded.crons[0] as unknown as Record<string, unknown>).futureField).toEqual({ retries: 3 });
    saveCrons(root, loaded.crons);
    const again = loadCrons(root);
    expect((again.crons[0] as unknown as Record<string, unknown>).futureField).toEqual({ retries: 3 });
  });
});
