// subagentTodosPayload — t-qd2riw. The host's BOUNDED replacement for pulling
// a child's whole transcript just to find its last todowrite: this calls the
// engine's `subagent_todos` directly and wraps the single hit into the same
// one-entry shape `todosFromTranscript` already decodes, so the puller
// (subagentTodos.test.ts) needs no change at all.
//
// The bugs worth catching: a call that still asks for the whole transcript
// instead of the bounded method; a found child with no todowrite yet posting
// a phantom entry instead of an empty page; and a read failure reaching the
// chunk handler as a throw instead of degrading to an empty page.

import { describe, expect, it } from 'vitest';
import { subagentTodosPayload } from '../../../src/dashboard/subagentTodosPayload';
import { todosFromTranscript } from '../../../src/dashboard/subagentTodos';

describe('subagentTodosPayload — the bounded engine lookup, not a transcript read', () => {
  it('calls ONLY getSubagentTodos, never a transcript method, and wraps the hit', async () => {
    const calls: Array<{ method: string; sessionId: string }> = [];
    const client = {
      getSubagentTodos: async (sessionId: string) => {
        calls.push({ method: 'getSubagentTodos', sessionId });
        return { found: true, rawInput: { todos: [{ content: 'read the ticket', status: 'pending' }] } };
      },
      // If the payload ever fell back to a transcript read, this would be
      // called instead — it is not part of TodosSource, so a type error would
      // catch a wrong wire choice too, but this proves the RUNTIME behaviour.
      getSubagentTranscript: async () => {
        calls.push({ method: 'getSubagentTranscript', sessionId: 'wrong' });
        return { sessionId: 'wrong', found: true, running: false, entries: [], truncated: false };
      },
    };

    const payload = await subagentTodosPayload(client, 'child-1');

    expect(calls).toEqual([{ method: 'getSubagentTodos', sessionId: 'child-1' }]);
    const todos = todosFromTranscript(payload.entries);
    expect(todos.map((t) => t.content)).toEqual(['read the ticket']);
  });

  it('is an empty page for a child that has written no todowrite at all', async () => {
    const client = { getSubagentTodos: async () => ({ found: true }) };

    const payload = await subagentTodosPayload(client, 'child-1');

    expect(payload.entries).toEqual([]);
    expect(todosFromTranscript(payload.entries)).toEqual([]);
  });

  it('is an empty page for a child the engine could not read at all', async () => {
    const client = { getSubagentTodos: async () => ({ found: false }) };

    expect((await subagentTodosPayload(client, 'ses_gone')).entries).toEqual([]);
  });

  it('degrades a rejected call to an empty page instead of throwing', async () => {
    const client = { getSubagentTodos: async () => { throw new Error('engine gone'); } };

    await expect(subagentTodosPayload(client, 'child-1')).resolves.toEqual({ entries: [] });
  });

  it('is an empty page with no client and no sessionId, without calling anything', async () => {
    expect((await subagentTodosPayload(null, 'child-1')).entries).toEqual([]);
    const calls: string[] = [];
    const client = { getSubagentTodos: async (id: string) => { calls.push(id); return { found: true }; } };
    expect((await subagentTodosPayload(client, '')).entries).toEqual([]);
    expect(calls).toEqual([]);
  });
});
