// subagentTranscript.ts — a child's stored session, shaped into the replay-log
// rows the chat is rebuilt from.
//
// The claim worth pinning is REUSE, not translation. A `task` card drawn in a
// sub-agent's transcript has to be the same card the parent's chat drew for
// the same call, which is only true if this projection hands
// applyToolCall/applyToolResult exactly what the live wire hands them. So the
// assertions are about the FIELDS those two rules read — the tool-name rider,
// the ACP location, the decoded content and diff, the task riders — rather
// than about a shape invented here.
//
// (Lives beside boardData.test.ts, which tests the sibling run_steps leaf the
// same way: a fake client, no extension host.)

import { describe, expect, it } from 'vitest';
import { subagentTranscriptPayload, transcriptEntry } from '../../../src/dashboard/subagentTranscript';
import type { SubagentEntry, SubagentTranscriptResult } from '../../../src/acpExtTypes';

const client = (res: Partial<SubagentTranscriptResult>) => ({
  getSubagentTranscript: async () => ({
    sessionId: 'ses_child', found: true, running: false, entries: [], truncated: false, ...res,
  } as SubagentTranscriptResult),
});

const TOOL: SubagentEntry = {
  type: 'tool',
  messageId: 'msg_1',
  toolCall: {
    toolCallId: 'call_9',
    kind: 'edit',
    status: 'completed',
    title: 'src/foo.ts',
    locations: [{ path: 'C:/repo/src/foo.ts' }],
    rawInput: { filePath: 'C:/repo/src/foo.ts' },
    rawOutput: { metadata: { exit: 0 } },
    content: [
      { type: 'content', content: { type: 'text', text: 'edited 1 hunk' } },
      { type: 'diff', path: 'C:/repo/src/foo.ts', oldText: 'a', newText: 'b' },
    ],
    _meta: { origami_tool_name: 'apply_patch' },
  },
};

describe('transcriptEntry — a settled ToolCall becomes the card rules’ own pair', () => {
  it('carries the tool NAME rider, so the card routes to its real renderer', () => {
    // Without it every sub-agent tool falls back to GenericCard — the flat-log
    // problem again, one layer prettier.
    const row = transcriptEntry(TOOL);
    expect(row.tool?.call.toolName).toBe('apply_patch');
    expect(row.tool?.result?.toolName).toBe('apply_patch');
  });

  it('lifts the ACP location onto both halves, so the card says WHERE', () => {
    const row = transcriptEntry(TOOL);
    expect(row.tool?.call.path).toBe('C:/repo/src/foo.ts');
    expect(row.tool?.result?.path).toBe('C:/repo/src/foo.ts');
  });

  it('decodes the WHOLE content array — text AND the structured diff', () => {
    // The donor bug this reuses the fix for: reading content[0] only drops an
    // edit's diff, and EditCard silently renders a summary instead of a diff.
    const row = transcriptEntry(TOOL);
    expect(row.tool?.result?.content).toBe('edited 1 hunk');
    expect(row.tool?.result?.diff).toEqual({ path: 'C:/repo/src/foo.ts', oldText: 'a', newText: 'b' });
  });

  it('passes rawInput and rawOutput.metadata through for the shell facts', () => {
    const row = transcriptEntry(TOOL);
    expect(row.tool?.call.rawInput).toEqual({ filePath: 'C:/repo/src/foo.ts' });
    expect(row.tool?.result?.rawOutputMeta).toEqual({ exit: 0 });
  });

  it('keeps the task riders, so a GRANDCHILD is still reachable one level down', () => {
    const row = transcriptEntry({
      type: 'tool', messageId: 'm', toolCall: {
        toolCallId: 'c', status: 'completed', title: 'task',
        _meta: { origami_tool_name: 'task', origami_task_session: 'ses_grandchild', origami_task_background: true },
      },
    });
    expect(row.tool?.call.taskSessionId).toBe('ses_grandchild');
    expect(row.tool?.call.taskBackground).toBe(true);
  });

  it('marks the timestamp UNKNOWN, because the engine sends no time', () => {
    // 0 means "not recorded". Note what this does NOT prove: chatRestore only
    // overrides on a truthy stamp, so the rebuilt card keeps its own Date.now()
    // and would read "0s elapsed" for a command that ran an hour ago. What
    // prevents that is ToolCard's read-only gate, asserted in ToolCard.test.ts
    // — not this line. Asserting only this would be echoing the implementation.
    expect(transcriptEntry(TOOL).timestamp).toBe(0);
  });

  it('routes prose by role and keeps a failed turn visible as an error row', () => {
    expect(transcriptEntry({ type: 'text', role: 'user', messageId: 'm', text: 'go' }).kind).toBe('user');
    expect(transcriptEntry({ type: 'text', role: 'assistant', messageId: 'm', text: 'ok' }).kind).toBe('agent');
    const err = transcriptEntry({ type: 'error', messageId: 'm', name: 'RateLimit', message: 'slow down' });
    expect(err.kind).toBe('error');
    // Dropping it would turn a child that died into one that finished silently.
    expect(err.text).toBe('RateLimit: slow down');
  });
});

describe('subagentTranscriptPayload — a panel always gets something to draw', () => {
  it('passes the engine’s own verdicts straight through', async () => {
    const out = await subagentTranscriptPayload(
      client({ found: true, running: true, truncated: true, entries: [TOOL] }), 'ses_child',
    );
    expect(out).toMatchObject({ sessionId: 'ses_child', found: true, running: true, truncated: true });
    expect(out.entries).toHaveLength(1);
    expect(out.error).toBeUndefined();
  });

  it('a child that is GONE is not an error — found:false, and no message', async () => {
    // The distinction the panel renders on: "no transcript" for a cleaned-up
    // child, vs an error the user can actually act on. Collapsing the two
    // would tell someone to reconnect when the child was deleted an hour ago.
    const out = await subagentTranscriptPayload(client({ found: false }), 'ses_gone');
    expect(out.found).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.entries).toEqual([]);
  });

  it('a THROWN call is an error, and still returns a drawable empty result', async () => {
    const boom = { getSubagentTranscript: async () => { throw new Error('engine died'); } };
    const out = await subagentTranscriptPayload(boom, 'ses_child');
    expect(out.error).toBe('engine died');
    expect(out).toMatchObject({ found: false, running: false, entries: [] });
  });

  it('no client and no id each say so, without calling anything', async () => {
    expect((await subagentTranscriptPayload(null, 'ses_child')).error).toContain('Open a chat first');
    expect((await subagentTranscriptPayload(client({}), '')).error).toContain('No sub-agent');
  });

  it('reads a malformed entries field defensively', async () => {
    const bad = { getSubagentTranscript: async () => ({ found: true } as unknown as SubagentTranscriptResult) };
    expect((await subagentTranscriptPayload(bad, 'ses_child')).entries).toEqual([]);
  });
});
