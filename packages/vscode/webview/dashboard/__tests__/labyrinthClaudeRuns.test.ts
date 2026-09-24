// Claude Code sessions in the Labyrinth's RUN INDEX (t-47bk8j): the mark, the
// switch that hides them, and the two things that must never reach the engine —
// a `claude:` id, and a delete.
//
// Asserted on the real pane in jsdom rather than on the leaf alone, because the
// defect this guards is a WIRE one: a Claude row whose id went to `run_steps`
// or `run_stats` would come back empty, and an empty run reads on screen as
// "this session recorded nothing", which looks like an answer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';
import { claudeRunStats, engineStatIds, labyrinthRunRows, visibleRunRows } from '../components/labyrinthClaudeRuns';
import { CLAUDE_MARK, claudeShownIn, withClaudeShown } from '../../chat/historyKinds';
import { runStatsPayload } from '../../../src/dashboard/runStats';
import { CLAUDE_RUN_PREFIX } from '../../../src/dashboard/claudeLabyrinth';

const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

const ENGINE = { sessionId: 'ses_a', title: 'Engine run', folder: 'lab', cwd: 'C:/ws/lab', updatedAt: '2026-09-09T10:00:00.000Z' };
const CLAUDE = {
  sessionId: 'sess-0001', title: 'Terrain banding', folder: 'lab', cwd: 'C:/ws/lab',
  updatedAt: '2026-09-09T11:00:00.000Z', kind: 'claude' as const,
  turns: 40, tokensIn: 1_000, tokensOut: 500, cacheRead: 9_000, cacheWrite: 200, model: 'claude-opus-5',
};
/** A Claude row with no folder: the transcript is found BY the folder, so this
 *  row names a file nothing can open. */
const HOMELESS = { ...CLAUDE, sessionId: 'sess-0002', title: 'No folder', cwd: '' };

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  globalThis.__vscodeApiMock.setState.mockClear();
  globalThis.__vscodeApiMock.getState.mockReturnValue(undefined);
});
afterEach(() => cleanup());

async function withRows(sessions: unknown[] = [ENGINE, CLAUDE]) {
  const rendered = render(LabyrinthPane);
  await tick();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  send({ type: 'historyList', sessions });
  await tick();
  return rendered;
}

describe('the run index lists Claude Code sessions, marked', () => {
  it('draws the SAME two letters the History popup puts on them, and only on them', async () => {
    const { container } = await withRows();
    const marks = Array.from(container.querySelectorAll('.lab-mark'));

    expect(CLAUDE_MARK).toBe('CC');
    expect(marks.map((m) => flat(m.textContent))).toEqual([CLAUDE_MARK]);
    expect(flat(container.textContent)).toContain('Terrain banding');
    expect(flat(container.textContent)).toContain('Engine run');
    // The mark says it in words too, for a reader who cannot read the tone.
    expect(marks[0]!.getAttribute('title')).toContain('Claude Code');
  });

  it('asks the engine about its OWN runs only — a `claude:` id would answer nothing, slowly', async () => {
    await withRows();
    const stats = posts().find((p) => p.type === 'requestRunStats')!;

    expect(stats.sessionIds).toEqual(['ses_a']);
  });

  it('routes a picked Claude run to the `claude:` id, in the folder it was made in', async () => {
    const { container } = await withRows();
    const cards = Array.from(container.querySelectorAll('.lab-run'));
    await fireEvent.click(cards.find((c) => flat(c.textContent).includes('Terrain banding'))!);
    await tick();

    expect(posts()).toContainEqual({ type: 'requestRunSteps', sessionId: `${CLAUDE_RUN_PREFIX}sess-0001`, cwd: 'C:/ws/lab' });
  });

  it('offers no DELETE on a Claude row — the engine has no session to cascade', async () => {
    const { container } = await withRows();
    const rows = Array.from(container.querySelectorAll('.lab-row'));
    const claudeRow = rows.find((r) => flat(r.textContent).includes('Terrain banding'))!;
    const engineRow = rows.find((r) => flat(r.textContent).includes('Engine run'))!;

    expect(claudeRow.querySelector('.lab-del')).toBeNull();
    expect(engineRow.querySelector('.lab-del')).not.toBeNull();
  });

  it('drops a Claude row with no folder rather than listing a run that cannot open', async () => {
    const { container } = await withRows([ENGINE, CLAUDE, HOMELESS]);
    expect(flat(container.textContent)).not.toContain('No folder');
    expect(container.querySelectorAll('.lab-run')).toHaveLength(2);
  });
});

describe('the show/hide switch is the History popup\u2019s own preference, not a second one', () => {
  it('hides Claude rows and leaves every engine row exactly where it was', async () => {
    const { container, getByRole } = await withRows();
    await fireEvent.click(getByRole('button', { name: /shown/i }));
    await tick();

    expect(flat(container.textContent)).not.toContain('Terrain banding');
    expect(flat(container.textContent)).toContain('Engine run');
    expect(container.querySelectorAll('.lab-mark')).toHaveLength(0);
  });

  it('writes the state back under the key historyKinds.ts owns — one setting, one reader', async () => {
    const { getByRole } = await withRows();
    await fireEvent.click(getByRole('button', { name: /shown/i }));

    const written = globalThis.__vscodeApiMock.setState.mock.calls.at(-1)![0];
    expect(claudeShownIn(written)).toBe(false);
    // ...and it is the SAME object shape the popup writes, other keys kept.
    expect(withClaudeShown({ other: 1 }, false)).toMatchObject({ other: 1 });
    expect(written).toEqual(withClaudeShown(undefined, false));
  });

  it('starts HIDDEN when that stored preference was already off in this window', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue(withClaudeShown({}, false));
    const { container, getByRole } = await withRows();

    expect(flat(container.textContent)).not.toContain('Terrain banding');
    await fireEvent.click(getByRole('button', { name: /hidden/i }));
    await tick();
    expect(flat(container.textContent)).toContain('Terrain banding');
  });
});

describe('a Claude run\u2019s stats come off the row the scan already measured', () => {
  it('draws its cache share with no runStatsData for it at all', async () => {
    const { container } = await withRows();
    // Only the ENGINE row was ever answered for.
    send({ type: 'runStatsData', stats: [{ sessionId: 'ses_a', requests: 40, tokens: { input: 1_000, output: 9, cacheRead: 3_000 } }], truncated: false });
    await tick();

    const cells = Array.from(container.querySelectorAll('.lab-health')).map((c) => flat(c.textContent));
    // 9_000 / (9_000 + 1_000) from the row itself; 3_000 / 4_000 from the engine.
    expect(cells).toContain('cache 90%');
    expect(cells).toContain('cache 75%');
  });

  it('never lets a Claude id reach the engine, even when the engine would explode on one', async () => {
    const client = {
      getRunStats: async (ids: string[]) => {
        if (ids.some((id) => id.startsWith(CLAUDE_RUN_PREFIX))) throw new Error('the engine was asked about a Claude transcript');
        return { stats: ids.map((sessionId) => ({ sessionId })), truncated: false, requested: ids.length };
      },
    };
    const rows = labyrinthRunRows([ENGINE, CLAUDE]);

    const payload = await runStatsPayload(client, engineStatIds(rows));
    expect(payload.error).toBeUndefined();
    expect(payload.stats).toEqual([{ sessionId: 'ses_a' }]);
    // ...and the Claude row still has its numbers, from the index row.
    expect(claudeRunStats(rows)[`${CLAUDE_RUN_PREFIX}sess-0001`]).toEqual({
      sessionId: `${CLAUDE_RUN_PREFIX}sess-0001`, requests: 40, tokens: { input: 1_000, cacheRead: 9_000 },
    });
  });

  it('gives a row that measured NOTHING no stats entry — an absent cell, never a 0%', () => {
    const bare = { ...CLAUDE, turns: undefined, tokensIn: undefined, cacheRead: undefined };
    expect(claudeRunStats(labyrinthRunRows([bare]))).toEqual({});
  });
});

describe('the leaf on its own', () => {
  it('stamps the route onto Claude ids and leaves every engine id alone', () => {
    const rows = labyrinthRunRows([ENGINE, CLAUDE]);
    expect(rows.map((r) => r.sessionId)).toEqual(['ses_a', `${CLAUDE_RUN_PREFIX}sess-0001`]);
    expect(rows[0]).toBe(ENGINE); // untouched, not a copy with the same fields
  });

  it('hides only Claude rows, whatever the switch says about the rest', () => {
    const rows = labyrinthRunRows([ENGINE, CLAUDE]);
    expect(visibleRunRows(rows, true).map((r) => r.sessionId)).toEqual(['ses_a', `${CLAUDE_RUN_PREFIX}sess-0001`]);
    expect(visibleRunRows(rows, false).map((r) => r.sessionId)).toEqual(['ses_a']);
    expect(visibleRunRows([], false)).toEqual([]);
  });
});
