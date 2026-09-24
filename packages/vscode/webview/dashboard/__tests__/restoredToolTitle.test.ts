// restoredToolTitle.test.ts (t-q90p6v) — a reopened chat must show the title the LIVE card showed.
//
// THE DEFECT. A card's identity arrives spread across frames. The PENDING frame carries the bare
// tool name and a partial input (a bash call's arguments are still streaming, so it held only
// `{cwd}`); the RUNNING frame carries the real title and the rawInput the shell card is drawn from;
// the COMPLETED frame carries the resolved title but no input. The host's archive kept the pending
// title on `tool.call` and REPLACED the result with the last frame, so the rawInput was thrown away
// — and a reopened session showed `bash`, `Edit: edit`, `read` where the live card showed the
// command and the path.
//
// FIXTURE PROVENANCE. The frames below are the shapes read off the owner's own store on
// 2026-09-21: `C:\Users\dev\.origami\sessions\session-9.json` for the archived entry (call
// `{title:'bash', rawInput:{cwd}}`, result `{title:'<the command>'}` with no rawInput), and
// packages/engine/src/acp/tool.ts for the frames that produce them. Contents are shortened; no key
// is invented.

import { describe, expect, it } from 'vitest';
import { logToolCall, logToolResult, type SessionMessage } from '../../../src/dashboard/sessionLog';
import { restoreLog, type RestoredEntry } from '../panes/chatRestore';

const ids = () => { let n = 1; return () => n++; };

function restore(log: SessionMessage[]) {
  return restoreLog<any>([], log as RestoredEntry[], ids(), 'Tsuru');
}

/** A bash turn exactly as DashboardPanel.ts logs one: pending, running, completed. */
function bashTurn(): SessionMessage[] {
  const log: SessionMessage[] = [];
  logToolCall(log, { toolCallId: 'b1', title: 'bash', kind: 'execute', status: 'pending', toolName: 'bash', rawInput: { cwd: 'c:\\Cortex' } });
  logToolResult(log, {
    toolCallId: 'b1', status: 'in_progress', toolName: 'bash', title: 'read the handoff',
    rawInput: { command: 'Get-Content HANDOFF.md -TotalCount 80', explanation: 'read the handoff', cwd: 'c:\\Cortex' },
  });
  logToolResult(log, { toolCallId: 'b1', status: 'completed', toolName: 'bash', title: 'read the handoff', contentText: '# HANDOFF' });
  return log;
}

describe('a restored tool card reads like the live one', () => {
  it('a bash card comes back with its command and explanation, not the word bash', () => {
    const log = bashTurn();

    // The stored CALL is what a restore builds the label from, so the fix has to land there.
    // RED before the fix: 'bash'.
    expect(log[0].tool?.call.title).toBe('read the handoff');
    // The running frame's input must survive the completed frame that carries none. RED before the
    // fix: the result was replaced wholesale, leaving `{cwd}` on the call and nothing here.
    expect(log[0].tool?.result?.rawInput).toMatchObject({ command: 'Get-Content HANDOFF.md -TotalCount 80' });

    const card = restore(log).find((m) => m.toolCallId === 'b1');
    expect(card.kind).toBe('tool');
    // No `shellDisplay` on this call, so the label is the bare explanation — the same rule the live
    // card follows (chatToolTitle.ts updatedToolTitle).
    expect(card.label).toBe('read the handoff');
    expect(card.toolShell?.command).toBe('Get-Content HANDOFF.md -TotalCount 80');
  });

  it('an edit card comes back as Edit: <path>, not Edit: edit', () => {
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'e1', title: 'edit', kind: 'edit', status: 'pending', toolName: 'edit', rawInput: {} });
    logToolResult(log, {
      toolCallId: 'e1', status: 'completed', toolName: 'edit', title: 'src\\app.ts', contentText: 'Edit applied successfully.',
      rawInput: { filePath: 'src\\app.ts', oldString: 'before', newString: 'after' },
    });

    expect(restore(log).find((m) => m.toolCallId === 'e1').label).toBe('Edit: src\\app.ts');
  });

  it('a read card comes back with its path', () => {
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'r1', title: 'read', kind: 'read', status: 'pending', toolName: 'read', rawInput: {} });
    logToolResult(log, { toolCallId: 'r1', status: 'completed', toolName: 'read', title: 'wiki\\pages\\mediagen.md', contentText: '---' });

    expect(restore(log).find((m) => m.toolCallId === 'r1').label).toBe('wiki\\pages\\mediagen.md');
  });

  it('refuses a title that is the tool name or a multi-line blob', () => {
    // apply_patch's own result title is the multi-line "Success. Updated the following files:..."
    // summary. Against an engine that predates the flattening it must NOT become the header, and
    // the pending placeholder must never be re-installed as if it were a real title.
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'p1', title: 'apply_patch', toolName: 'apply_patch' });
    logToolResult(log, { toolCallId: 'p1', status: 'completed', toolName: 'apply_patch', title: 'Success. Updated:\nM src/app.ts', contentText: 'ok' });
    expect(log[0].tool?.call.title).toBe('apply_patch');

    const bare: SessionMessage[] = [];
    logToolCall(bare, { toolCallId: 'g1', title: 'glob', toolName: 'glob' });
    logToolResult(bare, { toolCallId: 'g1', status: 'completed', toolName: 'glob', title: 'Glob', contentText: '' });
    expect(bare[0].tool?.call.title).toBe('glob');
  });

  it('keeps a whole patch out of the archive while keeping the fields the card needs', () => {
    // The stored rawInput exists for the title and the shell/task fields. A patch body or an edit's
    // replacement text is CONTENT — the diff travels on its own field — and the history pane reads
    // every archive back whole, so the big strings are dropped.
    const log: SessionMessage[] = [];
    logToolCall(log, { toolCallId: 'a1', title: 'apply_patch', toolName: 'apply_patch' });
    logToolResult(log, {
      toolCallId: 'a1', status: 'completed', toolName: 'apply_patch', title: 'src/app.ts', contentText: 'ok',
      rawInput: { patchText: 'x'.repeat(5000), explanation: 'rename the field' },
    });

    const raw = log[0].tool?.result?.rawInput as Record<string, unknown>;
    expect(raw.patchText).toBeUndefined();
    expect(raw.explanation).toBe('rename the field');
  });
});
