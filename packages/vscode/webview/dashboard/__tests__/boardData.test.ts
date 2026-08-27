// boardData — the host-side leaves behind the Labyrinth and Instructions
// panes. The behaviour that matters is what happens when things go WRONG: no
// session, a throwing engine, or a reply that is missing the very fields the
// panes rely on to stay honest (`truncated` / `total`).

import { describe, it, expect } from 'vitest';
import { runStepsPayload, instructionsPayload } from '../../../src/dashboard/boardData';

const step = (ordinal: number) => ({ ordinal, kind: 'tool' as const, title: `s${ordinal}` });

describe('runStepsPayload', () => {
  it('passes the engine’s truncation through verbatim', async () => {
    const client = { getRunSteps: async () => ({ steps: [step(0), step(1)], truncated: true, total: 941 }) };
    expect(await runStepsPayload(client, 'ses_a')).toEqual({
      sessionId: 'ses_a', steps: [step(0), step(1)], truncated: true, total: 941,
    });
  });

  it('a reply with no `total` falls back to the steps received — it can under-claim, never over-claim', async () => {
    const client = { getRunSteps: async () => ({ steps: [step(0)] }) as never };
    const out = await runStepsPayload(client, 'ses_a');
    expect(out.total).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('a non-boolean `truncated` is not treated as truthy truncation', async () => {
    const client = { getRunSteps: async () => ({ steps: [step(0)], truncated: 'yes', total: 1 }) as never };
    expect((await runStepsPayload(client, 'ses_a')).truncated).toBe(false);
  });

  it('a throwing engine returns an error field, not a rejected promise', async () => {
    const client = { getRunSteps: async () => { throw new Error('session not found'); } };
    const out = await runStepsPayload(client, 'ses_a');
    expect(out.error).toBe('session not found');
    expect(out.steps).toEqual([]);
    expect(out.total).toBe(0);
  });

  // A listed run does not always live in the active workspace: acpClient's
  // listSessions widens to EVERY workspace when the cwd-scoped query returns
  // nothing. Drop the run's own cwd and the engine resolves it against its
  // process cwd instead, which finds no messages — an empty run rendered as
  // fact rather than an error. So the cwd must reach the engine verbatim.
  it('forwards the run’s own directory to the engine', async () => {
    const seen: Array<string | undefined> = [];
    const client = {
      getRunSteps: async (_id: string, cwd?: string) => {
        seen.push(cwd);
        return { steps: [step(0)], truncated: false, total: 1 };
      },
    };
    await runStepsPayload(client, 'ses_a', 'C:/repos/other-project');
    expect(seen).toEqual(['C:/repos/other-project']);
  });

  it('sends no directory at all when the run has none — the engine decides, we do not guess one', async () => {
    const seen: Array<string | undefined> = [];
    const client = {
      getRunSteps: async (_id: string, cwd?: string) => {
        seen.push(cwd);
        return { steps: [], truncated: false, total: 0 };
      },
    };
    await runStepsPayload(client, 'ses_a', '');
    await runStepsPayload(client, 'ses_a');
    expect(seen).toEqual([undefined, undefined]);
  });

  it('no client and no sessionId each give their own error, never a silent empty run', async () => {
    expect((await runStepsPayload(null, 'ses_a')).error).toContain('Open a chat first');
    expect((await runStepsPayload({ getRunSteps: async () => ({ steps: [], truncated: false, total: 0 }) }, '')).error)
      .toContain('No run was selected');
  });
});

describe('instructionsPayload', () => {
  it('passes the inventory and the engine’s own estimator name through', async () => {
    const set = {
      entries: [{ path: '/ws/AGENTS.md', source: 'project' as const, chars: 8, bytes: 8, tokensApprox: 2 }],
      totalChars: 8, totalBytes: 8, totalTokensApprox: 2, tokensApproxMethod: 'chars/4' as const,
    };
    expect(await instructionsPayload({ listInstructions: async () => set })).toEqual(set);
  });

  it('a throwing engine yields zeroed totals PLUS an error — the pane must show the error, not the zeros', async () => {
    const out = await instructionsPayload({ listInstructions: async () => { throw new Error('engine offline'); } });
    expect(out.error).toBe('engine offline');
    expect(out.entries).toEqual([]);
    expect(out.totalTokensApprox).toBe(0);
  });

  it('no client reports that a chat is needed', async () => {
    expect((await instructionsPayload(undefined)).error).toContain('Open a chat first');
  });

  it('a malformed reply degrades to an empty inventory instead of throwing', async () => {
    const out = await instructionsPayload({ listInstructions: async () => ({}) as never });
    expect(out.entries).toEqual([]);
    expect(out.totalChars).toBe(0);
    expect(out.tokensApproxMethod).toBe('chars/4');
  });
});
