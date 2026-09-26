// engineNotice.test.ts — the engine card's rules, and the MIRROR guard with
// src/dashboard/engineGate.ts (t-v5qn37). The host names the stage; if the two stage lists
// drift, asEngineNotice refuses the post and a failed start silently draws no card.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { asEngineNotice, engineAlert, foldEngineNotice, opensEngineCard, type EngineNotice } from './engineNotice';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkgRoot, rel), 'utf8');

/** The string members of `type EngineStage = 'a' | 'b' ...;`. */
function stages(src: string): string[] {
  const m = src.match(/export type EngineStage = ([^;]+);/);
  expect(m, 'no EngineStage').not.toBeNull();
  return [...(m?.[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1] ?? '').sort();
}

/** The field names out of an `interface X { … }` block. */
function fields(src: string, name: string): string[] {
  const start = src.indexOf('interface ' + name + ' {');
  expect(start, 'no interface ' + name).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]).sort();
}

const host = read('src/dashboard/engineGate.ts');
const web = read('webview/dashboard/panes/engineNotice.ts');
const n = (stage: EngineNotice['stage'], held = 0, reason = '', retry = stage === 'failed'): EngineNotice => ({ stage, reason, held, retry });
const card = (notice: EngineNotice) => ({ kind: 'engine', engine: notice });

describe('the mirror with src/dashboard/engineGate.ts', () => {
  it('names the same stages on both sides', () => {
    expect(stages(web)).toEqual(stages(host));
    expect(stages(web).length).toBe(4);
  });
  it('t-wdyi2t (review #10): no `parked` card: the host never posts it (a parked chat shows nothing; its next message opens the "Starting" card)', () => {
    expect(stages(host)).not.toContain('parked');
    expect(asEngineNotice({ stage: 'parked', reason: '', held: 0 })).toBeUndefined();
  });
  it('reads the same fields the host posts', () => {
    expect(fields(web, 'EngineNotice')).toEqual(fields(host, 'EngineStatePost'));
  });
  it('accepts every stage the host can post', () => {
    for (const stage of stages(host)) expect(asEngineNotice({ stage, reason: '', held: 0 })?.stage).toBe(stage);
  });
});

describe('which card the pane shows', () => {
  it('refuses a post with no known stage', () => {
    expect(asEngineNotice({ stage: 'booting', held: 1 })).toBeUndefined();
    expect(asEngineNotice(undefined)).toBeUndefined();
  });
  it('only a failed start offers Retry', () => {
    expect(engineAlert(n('failed', 1, 'x')).retry).toBe(true);
    expect(engineAlert(n('stopped', 0, 'x')).retry).toBe(false);
    expect(engineAlert(n('starting', 1)).retry).toBe(false);
    expect(engineAlert(n('failed', 1, 'x', false)).retry).toBe(false); // a fork the host refuses to retry
  });
  it('offers Retry only when the host said so (fail-closed off the wire)', () => {
    expect(asEngineNotice({ stage: 'failed', reason: 'x', held: 1 })?.retry).toBe(false);
    expect(asEngineNotice({ stage: 'failed', reason: 'x', held: 1, retry: true })?.retry).toBe(true);
    expect(asEngineNotice({ stage: 'stopped', reason: 'x', held: 0, retry: true })?.retry).toBe(false);
  });
  it('a ready card is closed: the next wait opens a new card below it', () => {
    const rows = [card(n('ready', 1)), { kind: 'user' }];
    expect(foldEngineNotice(rows, n('starting', 1))).toBeUndefined();
    expect(opensEngineCard(n('starting', 1))).toBe(true);
  });
  it('a failed card takes the retry that follows it, even with rows after it', () => {
    const rows = [card(n('failed', 1, 'boom')), { kind: 'system' }];
    expect(foldEngineNotice(rows, n('starting', 1))?.[0]).toEqual(card(n('starting', 1)));
  });
  it('an engine loss always gets its own card, under the prompt it answers', () => {
    expect(foldEngineNotice([card(n('failed', 1, 'boom'))], n('stopped', 0, 'gone'))).toBeUndefined();
    expect(opensEngineCard(n('stopped'))).toBe(true);
  });
});

describe('t-x3a89j: a failed start or a stopped engine says WHEN, and carries the text Copy details copies', () => {
  const at = new Date(2026, 8, 25, 14, 3, 7).getTime(); // local time
  it('keeps a finite `at` and a string `details` off the wire, and drops anything else', () => {
    expect(asEngineNotice({ stage: 'failed', reason: 'x', held: 0, retry: true, at, details: 'Why: x' })).toMatchObject({ at, details: 'Why: x' });
    const junk = asEngineNotice({ stage: 'failed', reason: 'x', held: 0, at: 'soon', details: 42 });
    expect(junk && 'at' in junk).toBe(false);
    expect(junk && 'details' in junk).toBe(false);
  });
  it('the failed card shows the time it failed, next to the reason', () => {
    const a = engineAlert({ ...n('failed', 1, 'origami-acp exited (code=3, signal=null)'), at, details: 'd' });
    expect(a.detail).toContain('origami-acp exited (code=3, signal=null)');
    expect(a.detail).toContain('at 14:03:07');
    expect(a.details).toBe('d');
  });
  it('the stopped card shows its time too; a starting or ready card has none', () => {
    expect(engineAlert({ ...n('stopped', 0, 'gone'), at }).detail).toContain('at 14:03:07');
    expect(engineAlert(n('starting', 1)).detail).not.toMatch(/\bat \d/);
    expect(engineAlert(n('starting', 1)).details).toBeUndefined();
  });
});
