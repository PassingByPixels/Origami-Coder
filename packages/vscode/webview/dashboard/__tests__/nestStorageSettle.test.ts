// t-vbivj4 — the Nests Storage card always settles.
//
// Owner, 0.4.174: "nests measuring seems to never not be measuring". The card
// asked once and waited with no end; the host waited on one engine call with
// no bound; that call held the engine for 44-52 s on a copy of the owner's
// 15 GB store. Each block names the stuck state it reproduces.
//
// jsdom has no layout: asserted by text, roles and posted messages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
}));

import { handleNestStorageMessage } from '../../../src/dashboard/nestStoragePane';
import { ANSWER_MS, POLL_WAIT_MS } from '../../../src/dashboard/nestStorageMeasure';
import { NO_ANSWER_MS } from '../components/nestStorageSettle';
import type { NestDesk } from '../components/nestsStatus';
import NestStorage from '../components/NestStorage.svelte';

const desk = (id: string, name: string, extra: Partial<NestDesk> = {}): NestDesk => ({
  id, name, self: false, online: true, motherBase: false, os: 'windows', lastSeen: 0, ...extra,
});
const two = [desk('AAAAAAAAAAA', 'Surface', { self: true }), desk('BBBBBBBBBBB', '5090', { motherBase: true })];
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const fromHost = async (data: Record<string, unknown>) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
};
// The engine's nest_storage result (packages/engine/src/storage/nests.ts StorageResult).
const stats = (extra: Record<string, unknown> = {}) => ({
  deviceId: 'AAAAAAAAAAA',
  classes: { chats: 1_288_490_188, subagents: 751_619_276, toolOutput: 966_367_641, journal: 128_974_848, artifacts: 85_983_232 },
  fileBytes: 1, journalEventsPerPart: 1, method: 'length-sums', measuredMs: 3, ...extra,
});
const RETENTION = { windows: { chats: null, subagents: null, toolOutput: null, journal: null, artifacts: null }, unapplied: [] };

function host(impl: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const out: Array<Record<string, unknown>> = [];
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const h = {
    deviceId: 'AAAAAAAAAAA',
    now: () => 99,
    post: (m: Record<string, unknown>) => void out.push(m),
    client: { extMethod: (m: string, p?: Record<string, unknown>) => { calls.push([m, p]); return impl(m, p); } },
  };
  return { h, out, calls };
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('host: the measure is bounded and reports progress', () => {
  it('an engine that never answers ends in a plain error, not an endless wait', async () => {
    vi.useFakeTimers();
    const { h, out } = host(() => new Promise(() => undefined));
    const done = handleNestStorageMessage(h, { type: 'requestNestStorage' });
    await vi.advanceTimersByTimeAsync(ANSWER_MS + 1);
    await done;
    expect(out).toEqual([{ type: 'nestStorageData', error: 'The engine did not answer in 20 s. Try again.' }]);
  });

  it('a slow measure posts the sums so far with progress, then the final sizes', async () => {
    const answers = [stats({ done: false, progress: 0.25 }), stats({ done: false, progress: 0.75 }), stats({ done: true, progress: 1 })];
    const { h, out, calls } = host(async (m) => (m === 'nest_storage' ? answers.shift()! : RETENTION));
    await handleNestStorageMessage(h, { type: 'requestNestStorage' });
    expect(calls.map(([m, p]) => [m, p?.['waitMs']])).toEqual([
      ['nest_storage', POLL_WAIT_MS], ['nest_storage', POLL_WAIT_MS], ['nest_storage', POLL_WAIT_MS], ['nest_retention', undefined],
    ]);
    expect(out.map((m) => [m['partial'] === true, (m['stats'] as { progress?: number }).progress])).toEqual([[true, 0.25], [true, 0.75], [false, 1]]);
    expect(out.at(-1)).toMatchObject({ type: 'nestStorageData', retention: RETENTION, measuredAt: 99 });
  });

  it('an older engine that ignores waitMs answers once, and that answer is final', async () => {
    const { h, out } = host(async (m) => (m === 'nest_storage' ? stats() : RETENTION));
    await handleNestStorageMessage(h, { type: 'requestNestStorage' });
    expect(out).toEqual([{ type: 'nestStorageData', stats: stats(), retention: RETENTION, measuredAt: 99 }]);
  });
});

// t-vb87lt: the dry run (what a Keep choice frees) and Apply waited on the
// engine with no bound, the same fault t-vbivj4 fixed for the measure.
describe('host: the dry run and Apply are bounded', () => {
  it('a dry run the engine never answers ends in a plain error', async () => {
    vi.useFakeTimers();
    const { h, out } = host(() => new Promise(() => undefined));
    const done = handleNestStorageMessage(h, { type: 'nestRetentionSet', windows: { toolOutput: 7, artifacts: 30 }, dryRun: true });
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    await done;
    expect(out).toEqual([{ type: 'nestRetentionData', error: 'The engine did not answer in 60 s. Try again.' }]);
  });

  it('an Apply the engine never answers ends in a plain error, and nothing is measured after it', async () => {
    vi.useFakeTimers();
    const { h, out, calls } = host(() => new Promise(() => undefined));
    const done = handleNestStorageMessage(h, { type: 'nestRetentionSet', windows: { artifacts: 30 }, dryRun: false });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await done;
    expect(out).toEqual([{ type: 'nestRetentionData', error: 'The engine did not answer in 600 s. Try again.' }]);
    expect(calls.map(([m]) => m)).toEqual(['nest_retention']);
  });

  it('a dry run asks nest_retention with the chosen windows, and frees counts tool output and artifacts', async () => {
    const reply = { ...RETENTION, applied: { toolOutput: { bytes: 2_000 }, artifacts: { dryRun: true, olderThanDays: 30, blobs: 2, bytes: 500 } } };
    const { h, out, calls } = host(async () => reply);
    await handleNestStorageMessage(h, { type: 'nestRetentionSet', windows: { toolOutput: 7, artifacts: 30 }, dryRun: true });
    expect(calls).toEqual([['nest_retention', { enabled: false, deviceId: 'AAAAAAAAAAA', apply: { dryRun: true, windows: { toolOutput: 7, artifacts: 30 } } }]]);
    expect(out).toEqual([{ type: 'nestRetentionData', dryRun: true, frees: 2_500 }]);
  });
});

describe('card: always settles', () => {
  it('no answer at all: the card stops measuring, says so, and Retry asks again', async () => {
    vi.useFakeTimers();
    const view = render(NestStorage, { props: { desks: two } });
    expect(view.container.textContent).toContain('measuring this desk');
    await vi.advanceTimersByTimeAsync(NO_ANSWER_MS + 1);
    expect(view.getByRole('alert').textContent).toContain('No answer from the engine');
    expect(view.container.textContent).not.toContain('measuring this desk');
    const before = posted().filter((m) => m['type'] === 'requestNestStorage').length;
    await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    expect(posted().filter((m) => m['type'] === 'requestNestStorage').length).toBe(before + 1);
    expect(view.getByRole('button', { name: 'Measuring…' })).toBeTruthy();
  });

  it('a partial answer shows the sizes so far and the progress, and keeps measuring', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    await fromHost({ type: 'nestStorageData', stats: stats({ done: false, progress: 0.42 }), partial: true });
    expect(view.container.textContent).toContain('measuring this desk… 42%');
    expect(view.getByText('1.2 GB')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Measuring…' })).toBeTruthy();
    await fromHost({ type: 'nestStorageData', stats: stats({ done: true, progress: 1 }), retention: RETENTION, measuredAt: Date.now() });
    expect(view.container.textContent).toContain('measured');
    expect(view.getByRole('button', { name: 'Measure' })).toBeTruthy();
  });

  it('a host error settles the card with the reason and Retry', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    await fromHost({ type: 'nestStorageData', error: 'The engine did not answer in 20 s. Try again.' });
    expect(view.getByRole('alert').textContent).toContain('did not answer');
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('t-vb87lt: a failed dry run shows the reason, and Retry sends the dry run again, not a measure', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    const windows = { chats: null, subagents: null, toolOutput: null, artifacts: null };
    await fromHost({ type: 'nestStorageData', stats: stats(), retention: { windows }, measuredAt: Date.now() });
    await fireEvent.change(view.getByLabelText('Keep Artifacts'), { target: { value: '30' } });
    const dry = { type: 'nestRetentionSet', windows: { ...windows, artifacts: 30 }, dryRun: true };
    expect(posted().at(-1)).toEqual(dry);
    await fromHost({ type: 'nestRetentionData', error: 'The engine did not answer in 60 s. Try again.' });
    expect(view.getByRole('alert').textContent).toContain('did not answer in 60 s');
    const measures = posted().filter((m) => m['type'] === 'requestNestStorage').length;
    await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    expect(posted().at(-1)).toEqual(dry);
    expect(posted().filter((m) => m['type'] === 'requestNestStorage').length).toBe(measures);
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('t-vb87lt: the Apply confirm says the newest artifact version keeps its files; a small store reads in KB', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    const windows = { chats: null, subagents: null, toolOutput: null, artifacts: null };
    const small = stats({ classes: { chats: 0, subagents: 0, toolOutput: 0, journal: 0, artifacts: 118_784 } });
    await fromHost({ type: 'nestStorageData', stats: small, retention: { windows }, measuredAt: Date.now() });
    expect(view.getAllByText('116 KB').length).toBeGreaterThan(0);
    await fireEvent.change(view.getByLabelText('Keep Artifacts'), { target: { value: '30' } });
    await fromHost({ type: 'nestRetentionData', dryRun: true, frees: 2_048 });
    await fireEvent.click(view.getByText('Apply…'));
    const dialog = view.getByRole('dialog');
    expect(dialog.textContent).toContain('Remove 2 KB from');
    expect(dialog.textContent).toContain('The newest version of each artifact keeps its files.');
    await fireEvent.click(view.getByText('Remove'));
    expect(posted().at(-1)).toEqual({ type: 'nestRetentionSet', windows: { ...windows, artifacts: 30 }, dryRun: false });
  });

  it('partial answers keep the silence bound off: a long measure is not cut short', async () => {
    vi.useFakeTimers();
    const view = render(NestStorage, { props: { desks: two } });
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(NO_ANSWER_MS - 1_000);
      await fromHost({ type: 'nestStorageData', stats: stats({ done: false, progress: i / 4 }), partial: true });
    }
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('button', { name: 'Measuring…' })).toBeTruthy();
  });
});
