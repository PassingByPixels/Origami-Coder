// chatToolMsg.test.ts — the transcript's tool-message merge rules, tested as
// pure data (no DOM). These pin the behavior ChatPane's router delegated here
// verbatim (create / merge-by-toolCallId / detached fallback) plus the NEW
// shell-fact shaping: bash rawInput → toolShell IN facts on the call,
// rawOutput.metadata → exit/truncation OUT facts on the result.

import { describe, expect, it } from 'vitest';
import { applyToolCall, applyToolResult, type ToolCardMsg } from './chatToolMsg';

function call(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: 'npm test', toolCallId: 'tc-1', kind: 'execute', toolName: 'bash', status: 'in_progress', ...over };
}

describe('applyToolCall', () => {
  it('appends a tool card with the wire fields and defaults', () => {
    const out = applyToolCall<ToolCardMsg>([], call(), 7);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.id).toBe(7);
    expect(m.kind).toBe('tool');
    expect(m.label).toBe('npm test');
    expect(m.toolCallId).toBe('tc-1');
    expect(m.toolKind).toBe('execute');
    expect(m.toolName).toBe('bash');
    expect(m.toolStatus).toBe('in_progress');
  });

  it('falls back to "(tool call)" and defaults on an empty wire message', () => {
    const m = applyToolCall<ToolCardMsg>([], {}, 1)[0];
    expect(m.label).toBe('(tool call)');
    expect(m.toolKind).toBe('other');
    expect(m.toolName).toBe('');
    expect(m.toolStatus).toBe('in_progress');
  });

  it('shapes bash rawInput into toolShell (command/cwd/timeout)', () => {
    const m = applyToolCall<ToolCardMsg>(
      [],
      call({ rawInput: { command: 'npm test', cwd: 'C:\\repo', timeout: 300000 } }),
      1,
    )[0];
    expect(m.toolShell).toEqual({ command: 'npm test', cwd: 'C:\\repo', timeout: 300000 });
  });

  it('keeps the explanation as the collapsed title and the exact command in shell facts', () => {
    const m = applyToolCall<ToolCardMsg>([], call({
      title: 'Run the focused test suite',
      rawInput: { command: 'npm test -- --runInBand', explanation: 'Run the focused test suite' },
    }), 1)[0];
    expect(m.label).toBe('Run the focused test suite');
    expect(m.toolShell).toMatchObject({ command: 'npm test -- --runInBand' });
  });

  it('ignores rawInput for non-shell tools', () => {
    const m = applyToolCall<ToolCardMsg>(
      [],
      call({ toolName: 'read', rawInput: { filePath: 'a.ts' } }),
      1,
    )[0];
    expect(m.toolShell).toBeUndefined();
  });

  it.each(['edit', 'apply_patch'])('prefixes a clean %s title with Edit', (toolName) => {
    const m = applyToolCall<ToolCardMsg>([], call({ toolName, kind: 'edit', title: 'Update the title merge' }), 1)[0];
    expect(m.label).toBe('Edit: Update the title merge');
  });

  it('marks a repeated task session as resumed', () => {
    const first = applyToolCall<ToolCardMsg>([], call({ toolName: 'task', taskSessionId: 'child-1' }), 1);
    const both = applyToolCall<ToolCardMsg>(first, call({ toolName: 'task', taskSessionId: 'child-1', toolCallId: 'tc-2' }), 2);
    expect(both[0].taskResumed).toBe(false);
    expect(both[1].taskResumed).toBe(true);
  });
});

describe('applyToolResult', () => {
  function seeded(over: Record<string, unknown> = {}): ToolCardMsg[] {
    return applyToolCall<ToolCardMsg>([], call(over), 1);
  }

  it('merges status/result into the matching card and returns a NEW array', () => {
    const msgs = seeded();
    const out = applyToolResult(msgs, { toolCallId: 'tc-1', status: 'completed', content: 'ok' }, 9);
    expect(out).not.toBe(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].toolStatus).toBe('completed');
    expect(out[0].toolResult).toBe('ok');
  });

  it('caps a non-shell result at 2000 chars and a bash result at 8000', () => {
    const long = 'x'.repeat(10_000);
    const bash = applyToolResult(seeded(), { toolCallId: 'tc-1', content: long }, 9);
    expect(bash[0].toolResult).toHaveLength(8000);
    const read = applyToolResult(seeded({ toolName: 'read', kind: 'read' }), { toolCallId: 'tc-1', content: long }, 9);
    expect(read[0].toolResult).toHaveLength(2000);
  });

  it('stamps shell OUT facts (exit/truncated/outputPath) and keeps the IN facts', () => {
    const msgs = seeded({ rawInput: { command: 'npm test', cwd: 'C:\\repo' } });
    const out = applyToolResult(msgs, {
      toolCallId: 'tc-1',
      status: 'completed',
      content: 'boom',
      rawOutputMeta: { output: 'boom', exit: 2, truncated: true, outputPath: 'C:\\tmp\\full.txt' },
    }, 9);
    expect(out[0].toolShell).toEqual({
      command: 'npm test',
      cwd: 'C:\\repo',
      timeout: undefined,
      exit: 2,
      truncated: true,
      outputPath: 'C:\\tmp\\full.txt',
    });
  });

  it('merges detached telemetry state, job id, and output timing onto the same card', () => {
    const out = applyToolResult(seeded({ rawInput: { command: 'npm run dev' } }), {
      toolCallId: 'tc-1',
      status: 'in_progress',
      content: 'server ready',
      rawOutputMeta: {
        background: true,
        state: 'promoted',
        jobId: 'job_1',
        startedAt: 1000,
        lastOutputAt: 1500,
      },
    }, 9);
    expect(out[0].toolResult).toBe('server ready');
    expect(out[0].toolShell).toMatchObject({
      command: 'npm run dev',
      background: true,
      state: 'promoted',
      jobId: 'job_1',
      startedAt: 1000,
      lastOutputAt: 1500,
    });
  });

  it('keeps a detached command running after its model-facing tool result completes', () => {
    const out = applyToolResult(seeded({ rawInput: { command: 'npm run dev' } }), {
      toolCallId: 'tc-1',
      status: 'completed',
      content: 'Started in background',
      rawOutputMeta: {
        background: true,
        state: 'background',
        jobId: 'shell-tc-1',
        exit: null,
        startedAt: 1000,
      },
    }, 9);
    expect(out[0].toolStatus).toBe('in_progress');
    expect(out[0].toolShell).toMatchObject({ command: 'npm run dev', state: 'background', jobId: 'shell-tc-1' });
  });

  it('replaces the provisional bash title and input when decoded arguments arrive on the running update', () => {
    const out = applyToolResult(seeded({ title: 'bash', rawInput: undefined }), {
      toolCallId: 'tc-1',
      toolName: 'bash',
      status: 'in_progress',
      title: 'Run the focused test suite',
      rawInput: { explanation: 'Run the focused test suite', command: 'npm test' },
    }, 9);
    expect(out[0].label).toBe('Run the focused test suite');
    expect(out[0].text).toBe('Run the focused test suite');
    expect(out[0].toolShell?.command).toBe('npm test');
  });

  it('formats a shell update as shell family plus model explanation', () => {
    const out = applyToolResult(seeded({ title: 'bash', rawInput: undefined }), {
      toolCallId: 'tc-1', toolName: 'bash', status: 'in_progress', title: 'ignored command title',
      rawInput: { explanation: 'Run the focused test suite', command: 'npm test', shellDisplay: 'PowerShell' },
    }, 9);
    expect(out[0].label).toBe('PowerShell: Run the focused test suite');
    expect(out[0].toolShell).toMatchObject({ command: 'npm test', explanation: 'Run the focused test suite', display: 'PowerShell' });
  });

  it('keeps the formatted shell title when completion carries only the command title', () => {
    const running = applyToolResult(seeded({ title: 'bash', rawInput: undefined }), {
      toolCallId: 'tc-1', toolName: 'bash', status: 'in_progress', title: 'npm test',
      rawInput: { explanation: 'Run the focused test suite', command: 'npm test', shellDisplay: 'PowerShell' },
    }, 9);
    const completed = applyToolResult(running, {
      toolCallId: 'tc-1', toolName: 'bash', status: 'completed', title: 'npm test', content: 'passed',
      rawOutputMeta: { exit: 0, state: 'foreground' },
    }, 10);
    expect(completed[0].label).toBe('PowerShell: Run the focused test suite');
  });

  it.each([
    ['read', 'Read AGENTS.md', 'C:\\Users\\dev\\Desktop\\Workspace\\AGENTS.md'],
    ['grep', 'Find shell update handlers', 'runningToolUpdate\\(|duplicateRunningToolUpdate\\('],
    ['edit', 'Update the title merge', 'C:\\repo\\chatToolMsg.ts'],
    ['write', 'Create the release note', 'C:\\repo\\release.md'],
    ['glob', 'Find dashboard cards', '**/*Card.svelte'],
    ['task', 'Inspect the title flow', 'Explore title flow'],
    ['browser', 'Open the test page', 'browser open: test page'],
    ['chart', 'Draw verification results', 'chart'],
  ])('keeps the clean %s pill when a later update carries raw detail', (toolName, clean, raw) => {
    const out = applyToolResult(seeded({ toolName, title: clean }), {
      toolCallId: 'tc-1', toolName, status: 'completed', title: raw, content: 'done',
    }, 9);
    expect(out[0].label).toBe(toolName === 'edit' ? `Edit: ${clean}` : clean);
  });

  it('keeps exit null (a killed run) as a stamped fact, distinct from absent', () => {
    const out = applyToolResult(seeded(), { toolCallId: 'tc-1', rawOutputMeta: { exit: null } }, 9);
    expect(out[0].toolShell?.exit).toBeNull();
  });

  it('does NOT stamp shell facts from a non-shell metadata shape', () => {
    // read's metadata carries a display block, never an exit key.
    const out = applyToolResult(seeded({ toolName: 'read' }), {
      toolCallId: 'tc-1',
      rawOutputMeta: { display: { type: 'file', text: 'hi' } },
    }, 9);
    expect(out[0].toolShell).toBeUndefined();
  });

  it('stamps toolLines from a read display block, and leaves shell shapes without it', () => {
    const read = applyToolResult(seeded({ toolName: 'read' }), {
      toolCallId: 'tc-1',
      rawOutputMeta: { display: { type: 'file', text: 'hi', lineStart: 26, lineEnd: 61, totalLines: 61, truncated: false } },
    }, 9);
    expect(read[0].toolLines).toEqual({ start: 26, end: 61 });

    const shell = applyToolResult(seeded({ rawInput: { command: 'npm test' } }), {
      toolCallId: 'tc-1',
      rawOutputMeta: { output: 'boom', exit: 0 },
    }, 9);
    expect(shell[0].toolLines).toBeUndefined();
  });

  it('threads path, diff and the resumed-on-update task session check', () => {
    const prior = applyToolCall<ToolCardMsg>([], call({ toolName: 'task', toolCallId: 'tc-0', taskSessionId: 'child-1' }), 1);
    const msgs = applyToolCall(prior, call({ toolName: 'task', toolCallId: 'tc-1' }), 2);
    const out = applyToolResult(msgs, {
      toolCallId: 'tc-1',
      path: 'src\\a.ts',
      taskSessionId: 'child-1',
      diff: { path: 'src\\a.ts', oldText: 'a', newText: 'b' },
    }, 9);
    expect(out[1].toolPath).toBe('src\\a.ts');
    expect(out[1].taskResumed).toBe(true);
    expect(out[1].toolDiff).toEqual({ path: 'src\\a.ts', oldText: 'a', newText: 'b' });
  });

  it('falls back to a detached result row when no card matches', () => {
    const out = applyToolResult<ToolCardMsg>([], { toolCallId: 'tc-miss', content: 'orphan' }, 42);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(42);
    expect(out[0].label).toBe('result');
    expect(out[0].toolStatus).toBe('completed');
    expect(out[0].toolResult).toBe('orphan');
  });

  // replay-toolcards: the engine stamps `_meta.origami_tool_name` on every
  // tool_call AND tool_call_update, but the card's toolName used to be set
  // ONLY from the first tool_call. An update-without-call sequence (a
  // replayed/reordered `tool_call_update` that never matched an initial
  // `tool_call`) therefore carried the tool name and it was still discarded,
  // so the card fell to GenericCard (toolName '') instead of e.g. BrowserCard.
  it('an update-without-call sequence still carries the toolName once it arrives on the update', () => {
    const out = applyToolResult<ToolCardMsg>(
      [],
      { toolCallId: 'tc-orphan', content: 'screenshot taken', toolName: 'browser' },
      1,
    );
    expect(out).toHaveLength(1);
    // toolName present -> ToolCard.svelte's isBrowser dispatch (toolName ===
    // 'browser') renders BrowserCard instead of GenericCard.
    expect(out[0].toolName).toBe('browser');
  });

  it('a later update can set the toolName a matched card never got from its call', () => {
    // The call landed but its own tool_call carried no toolName (e.g. a plain
    // ACP server, or the rider was lost) -- a later update supplying it heals
    // the card's identity rather than leaving it stuck on GenericCard.
    const msgs = seeded({ toolName: '' });
    const out = applyToolResult(msgs, { toolCallId: 'tc-1', toolName: 'browser' }, 9);
    expect(out[0].toolName).toBe('browser');
  });

  it('never overwrites an already-known toolName with an absent one on a later update', () => {
    const msgs = seeded({ toolName: 'browser' });
    const out = applyToolResult(msgs, { toolCallId: 'tc-1', status: 'completed' }, 9);
    expect(out[0].toolName).toBe('browser');
  });

  // The sub-agent SPAN (taskRiders.ts). The start is write-if-present like every
  // other rider; the END is write-ONCE, and that asymmetry is load-bearing.
  it('takes the engine span off the update, and keeps the FIRST end it is given', () => {
    let out = applyToolResult(seeded({ toolName: 'task' }), { toolCallId: 'tc-1', status: 'completed', taskStartedAt: 1000, taskSessionId: 'child-1' }, 2);
    expect(out[0].taskStartedAt).toBe(1000);
    expect(out[0].taskEndedAt).toBeUndefined();

    out = applyToolResult(out, { toolCallId: 'tc-1', status: 'completed', taskEndedAt: 5000 }, 3);
    expect(out[0].taskEndedAt).toBe(5000);
    // A detached child's terminal marker can be re-emitted while the parent's
    // turn runs on, each time stamped a LATER `Date.now()`. Taking the newest
    // would make a finished sub-agent's total creep upward on screen.
    out = applyToolResult(out, { toolCallId: 'tc-1', status: 'completed', taskEndedAt: 9000 }, 4);
    expect(out[0].taskEndedAt).toBe(5000);
  });

  it('never lets an absent or junk span erase one an earlier update delivered', () => {
    // Every rider here is write-if-present for this reason: the frames arrive in
    // no guaranteed order and most of them carry none of these fields.
    let out = applyToolResult(seeded({ toolName: 'task' }), { toolCallId: 'tc-1', taskStartedAt: 1000, taskEndedAt: 5000 }, 2);
    out = applyToolResult(out, { toolCallId: 'tc-1', status: 'completed', content: 'done' }, 3);
    expect(out[0].taskStartedAt).toBe(1000);
    out = applyToolResult(out, { toolCallId: 'tc-1', taskStartedAt: 0, taskEndedAt: 'later' }, 4);
    expect(out[0].taskStartedAt).toBe(1000);
    expect(out[0].taskEndedAt).toBe(5000);
  });
});

// The apply_patch collapsed row, end to end through the merge rules. The label
// RULES themselves live in chatToolTitle.test.ts; these pin that a card walks
// from the pending placeholder to the engine's derived title, and — the case
// most easily missed — that a RESTORED card reads the same as the live one.
describe('apply_patch row', () => {
  const patch = (over: Record<string, unknown> = {}) => ({
    toolCallId: 'tc-p', kind: 'edit', toolName: 'apply_patch', ...over,
  });
  // acp/tool.ts's own wording for a completed patch, which a restore replays.
  const RESULT = 'Success. Updated the following files:\nM src/foo.ts';

  it('heals from the pending placeholder to the file the patch touched', () => {
    // PENDING: the part is created with input:{}, so the engine has no
    // patchText and the only title it can send is the tool name.
    const born = applyToolCall<ToolCardMsg>([], patch({ title: 'apply_patch', status: 'pending' }), 1);
    expect(born[0].label).toBe('Edit: apply_patch');
    // RUNNING: patchText has arrived, so the title is the real path.
    const running = applyToolResult(born, patch({ status: 'in_progress', title: 'src/foo.ts', path: 'src/foo.ts' }), 2);
    expect(running[0].label).toBe('Edit: src/foo.ts');
    expect(running[0].text).toBe('Edit: src/foo.ts');
    // ...and the path span lights up from the same frame's locations[0].
    expect(running[0].toolPath).toBe('src/foo.ts');
  });

  it('says "N files" for a multi-file patch', () => {
    const born = applyToolCall<ToolCardMsg>([], patch({ title: 'apply_patch' }), 1);
    const out = applyToolResult(born, patch({ status: 'in_progress', title: '3 files' }), 2);
    expect(out[0].label).toBe('Edit: 3 files');
  });

  it('names where a renamed file WENT while the path span keeps what was opened', () => {
    const born = applyToolCall<ToolCardMsg>([], patch({ title: 'apply_patch' }), 1);
    const out = applyToolResult(born, patch({ status: 'completed', title: 'src/new.ts', path: 'src/old.ts' }), 2);
    expect(out[0].label).toBe('Edit: src/new.ts');
    expect(out[0].toolPath).toBe('src/old.ts');
  });

  // acp/event.ts replays a COMPLETED part back through toolStart, so on restore
  // the PENDING frame already carries the derived title. The two paths must
  // land on the same string or a reopened chat would disagree with the live one.
  it('reads identically after a session restore', () => {
    let live = applyToolCall<ToolCardMsg>([], patch({ title: 'apply_patch', status: 'pending' }), 1);
    live = applyToolResult(live, patch({ status: 'in_progress', title: 'src/foo.ts', path: 'src/foo.ts' }), 2);
    live = applyToolResult(live, patch({ status: 'completed', title: 'src/foo.ts', path: 'src/foo.ts', content: RESULT }), 3);

    let restored = applyToolCall<ToolCardMsg>([], patch({ title: 'src/foo.ts', status: 'pending' }), 1);
    restored = applyToolResult(restored, patch({ status: 'completed', title: 'src/foo.ts', path: 'src/foo.ts', content: RESULT }), 2);

    expect(restored[0].label).toBe('Edit: src/foo.ts');
    expect(restored[0].label).toBe(live[0].label);
    expect(restored[0].toolPath).toBe(live[0].toolPath);
  });

  it('leaves a non-adopting tool frozen at the title its call carried', () => {
    const born = applyToolCall<ToolCardMsg>([], call({ toolName: 'write', kind: 'edit', title: 'write' }), 1);
    const out = applyToolResult(born, { toolCallId: 'tc-1', status: 'completed', title: 'src/written.ts', path: 'src/written.ts' }, 2);
    expect(out[0].label).toBe('write');
    expect(out[0].toolPath).toBe('src/written.ts');
  });
});
