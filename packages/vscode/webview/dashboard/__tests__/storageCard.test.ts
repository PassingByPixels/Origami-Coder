// storageCard.test.ts — the Storage card's host half and its formatting (t-dcjs40).
//
// The promise this surface makes is not "a card renders". It is: nothing is
// written until a user asked for a write. So what is tested is the REFUSALS —
// a missing chat, a window under the engine's floor, a malformed `dryRun` — and
// that the one destructive call reaches the engine with the exact verb and
// params the engine validates.
import { describe, expect, it } from 'vitest';
import { formatBytes, pruneSummary } from '../components/storageSplit';
import { MIN_WINDOW_DAYS, STORAGE_PANE_MESSAGE_TYPES, handleStorageMessage } from '../../../src/dashboard/storagePane';
import { NAMED_REFUSALS } from '../../../src/remote/remoteVerbs';

function harness(answer?: (method: string, params?: Record<string, unknown>) => Record<string, unknown>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const posted: Record<string, unknown>[] = [];
  const host = {
    client: {
      extMethod: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (!answer) throw new Error('engine said no');
        return answer(method, params);
      },
    },
    post: (message: Record<string, unknown>) => posted.push(message),
  };
  return { host, calls, posted };
}

describe('storagePane — the Insights Storage card host half', () => {
  it('measures through the engine and hands the split back untouched', async () => {
    const stats = { fileBytes: 10, journalBytes: 4, parts: { toolOutput: 3 } };
    const { host, calls, posted } = harness(() => stats);

    await handleStorageMessage(host, { type: 'requestStorageStats' });

    expect(calls).toEqual([{ method: 'storage_stats', params: {} }]);
    expect(posted).toEqual([{ type: 'storageStatsData', stats }]);
  });

  it('sends a prune only as the engine verb, with a floored integer window', async () => {
    const { host, calls } = harness(() => ({ parts: 2, bytes: 99, olderThanDays: 60 }));

    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60.7, dryRun: false });

    // The re-measure after a real prune is the second call; see its own test below.
    expect(calls[0]).toEqual({ method: 'storage_prune', params: { olderThanDays: 60, dryRun: false } });
  });

  it('refuses a window under the engine floor without calling the engine', async () => {
    const { host, calls, posted } = harness(() => ({}));

    for (const olderThanDays of [MIN_WINDOW_DAYS - 1, 0, -30, Number.NaN, '60']) {
      await handleStorageMessage(host, { type: 'storagePrune', olderThanDays, dryRun: false });
    }

    expect(calls).toEqual([]);
    expect(posted.every((m) => typeof m['error'] === 'string')).toBe(true);
  });

  it('treats anything but an exact dryRun:false as a dry run', async () => {
    const { host, calls } = harness(() => ({ parts: 0 }));

    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60 });
    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60, dryRun: 'false' });

    expect(calls.map((c) => c.params?.['dryRun'])).toEqual([true, true]);
  });

  it('re-measures after a real prune, and not after a dry run', async () => {
    const { host, calls } = harness(() => ({ parts: 1, bytes: 10, olderThanDays: 60 }));

    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60, dryRun: true });
    expect(calls.map((c) => c.method)).toEqual(['storage_prune']);

    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60, dryRun: false });
    expect(calls.map((c) => c.method)).toEqual(['storage_prune', 'storage_prune', 'storage_stats']);
  });

  it('says so when there is no chat, rather than failing silently', async () => {
    const posted: Record<string, unknown>[] = [];
    const host = { post: (m: Record<string, unknown>) => posted.push(m) };

    await handleStorageMessage(host, { type: 'requestStorageStats' });
    await handleStorageMessage(host, { type: 'storagePrune', olderThanDays: 60, dryRun: false });

    expect(posted.map((m) => typeof m['error'])).toEqual(['string', 'string']);
  });

  it('turns an engine failure into a reason, not a thrown message handler', async () => {
    const { host, posted } = harness();

    await handleStorageMessage(host, { type: 'requestStorageStats' });

    expect(posted[0]).toEqual({ type: 'storageStatsData', error: 'engine said no' });
  });

  it('keeps the destructive verb off the phone', () => {
    expect(STORAGE_PANE_MESSAGE_TYPES.has('storagePrune')).toBe(true);
    expect(NAMED_REFUSALS).toContain('storagePrune');
  });
});

describe('storageSplit — what the card prints', () => {
  it('scales bytes and refuses to print a defect as a number', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.26 * 1024 ** 3)).toBe('3.3 GB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('summarises a prune in PARTS, and names an empty result as empty', () => {
    expect(pruneSummary({ parts: 0, bytes: 0, olderThanDays: 60 })).toBe('Nothing to prune older than 60 days.');
    expect(pruneSummary({ parts: 1, bytes: 1024, olderThanDays: 90 })).toBe(
      '1 tool part older than 90 days, 1.0 KB of payload.',
    );
    expect(pruneSummary({ parts: 4, bytes: 2048, olderThanDays: 60 })).toContain('4 tool parts');
  });
});
