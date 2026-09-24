// subagentChangesPayload — t-ru0by6. The host's BOUNDED replacement for
// pulling a child's whole transcript just to find its diff-bearing tool
// parts: this calls the engine's `subagent_changes` directly and wraps each
// diff into the same one-entry-per-diff shape `subagentFileDiffs` already
// filters, so the puller (subagentChanges.test.ts) needs no change at all.
//
// The bugs worth catching: a call that still asks for the whole transcript
// instead of the bounded method; a found child with no diffs yet posting a
// phantom entry instead of an empty page; and a read failure reaching the
// chunk handler as a throw instead of degrading to an empty page.

import { describe, expect, it } from 'vitest';
import { subagentChangesPayload } from '../../../src/dashboard/subagentChangesPayload';
import { subagentFileDiffs } from '../../../src/dashboard/subagentChanges';

describe('subagentChangesPayload — the bounded engine lookup, not a transcript read', () => {
  it('calls ONLY getSubagentChanges, never a transcript method, and wraps every diff', async () => {
    const calls: Array<{ method: string; sessionId: string }> = [];
    const client = {
      getSubagentChanges: async (sessionId: string) => {
        calls.push({ method: 'getSubagentChanges', sessionId });
        return {
          found: true,
          diffs: [
            { path: '/w/a.ts', oldText: 'a', newText: 'b' },
            { path: '/w/c.ts', oldText: '', newText: 'x' },
          ],
        };
      },
      // If the payload ever fell back to a transcript read, this would be
      // called instead — it is not part of ChangesSource, so a type error
      // would catch a wrong wire choice too, but this proves the RUNTIME
      // behaviour.
      getSubagentTranscript: async () => {
        calls.push({ method: 'getSubagentTranscript', sessionId: 'wrong' });
        return { sessionId: 'wrong', found: true, running: false, entries: [], truncated: false };
      },
    };

    const payload = await subagentChangesPayload(client, 'child-1');

    expect(calls).toEqual([{ method: 'getSubagentChanges', sessionId: 'child-1' }]);
    expect(subagentFileDiffs(payload.entries)).toEqual([
      { path: '/w/a.ts', oldText: 'a', newText: 'b' },
      { path: '/w/c.ts', oldText: '', newText: 'x' },
    ]);
  });

  it('is an empty page for a child that made no diff-bearing calls at all', async () => {
    const client = { getSubagentChanges: async () => ({ found: true, diffs: [] }) };

    const payload = await subagentChangesPayload(client, 'child-1');

    expect(payload.entries).toEqual([]);
    expect(subagentFileDiffs(payload.entries)).toEqual([]);
  });

  it('is an empty page for a child the engine could not read at all', async () => {
    const client = { getSubagentChanges: async () => ({ found: false, diffs: [] }) };

    expect((await subagentChangesPayload(client, 'ses_gone')).entries).toEqual([]);
  });

  it('degrades a rejected call to an empty page instead of throwing', async () => {
    const client = { getSubagentChanges: async () => { throw new Error('engine gone'); } };

    await expect(subagentChangesPayload(client, 'child-1')).resolves.toEqual({ entries: [] });
  });

  it('is an empty page with no client and no sessionId, without calling anything', async () => {
    expect((await subagentChangesPayload(null, 'child-1')).entries).toEqual([]);
    const calls: string[] = [];
    const client = {
      getSubagentChanges: async (id: string) => {
        calls.push(id);
        return { found: true, diffs: [] };
      },
    };
    expect((await subagentChangesPayload(client, '')).entries).toEqual([]);
    expect(calls).toEqual([]);
  });
});
