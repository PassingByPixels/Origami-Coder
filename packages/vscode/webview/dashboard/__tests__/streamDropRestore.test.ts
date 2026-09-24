// streamDropRestore.test.ts — a dropped stream survives a window reload as the
// SAME card the user was looking at (t-q90gj9).
//
// A recalled chat's tab opens after start(), so live posts made during replay
// never reach it and the tab is caught up from the host's `Session.messageLog`
// instead. An entry the restore path cannot rebuild comes back as a plain text
// row — exactly the defect the structured notice replaced. So this drives the
// REAL pair: logStreamDrop writes the log, restoreLog rebuilds the rows.

import { describe, expect, it } from 'vitest';
import { logStreamDrop, type SessionMessage } from '../../../src/dashboard/sessionLog';
import type { StreamDropNotice } from '../../../src/acpStreamDrop';
import { restoreLog, type RestoredEntry } from '../panes/chatRestore';

const notice = (over: Partial<StreamDropNotice> = {}): StreamDropNotice => ({
  kind: 'retrying', attempt: 1, max: 3, detail: 'fetch failed (ECONNRESET)', terminal: false, ...over,
});

const ids = () => { let n = 1; return () => n++; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const restore = (log: SessionMessage[]) => restoreLog<any>([], log as RestoredEntry[], ids(), 'Tsuru');

describe('the log', () => {
  it('collapses a run of attempts onto ONE entry', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 1 }));
    logStreamDrop(log, notice({ attempt: 2 }));
    logStreamDrop(log, notice({ kind: 'stopped', attempt: 3, terminal: true }));
    expect(log).toHaveLength(1);
    expect(log[0].streamDrop).toMatchObject({ kind: 'stopped', attempt: 3 });
  });

  it('starts a NEW entry once prose came between two drops', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 1 }));
    log.push({ kind: 'agent', text: 'back again', timestamp: 2 });
    logStreamDrop(log, notice({ attempt: 1 }));
    expect(log.filter((e) => e.kind === 'streamDrop')).toHaveLength(2);
  });
});

describe('the restore', () => {
  it('rebuilds the card, not a text row', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 2 }));
    const rows = restore(log);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('streamDrop');
    expect(rows[0].streamDrop.notice).toMatchObject({ attempt: 2, detail: 'fetch failed (ECONNRESET)' });
    // Never a system/agent line: that is what the reader saw before the fix.
    expect(rows.some((r: { kind: string }) => r.kind === 'system' || r.kind === 'agent')).toBe(false);
  });

  it('restores a card that RECOVERED as recovered, because prose followed it', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 1 }));
    log.push({ kind: 'agent', text: 'carrying on', timestamp: 2 });
    const rows = restore(log);
    expect(rows[0].streamDrop.recovered).toBe(true);
  });

  // t-sj3fvo: after a retry the model often resumes with a tool call or
  // reasoning before any prose. A reload must read that the same way the
  // live pane does.
  it('recovers the card when a TOOL CALL landed after it, with no prose at all', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 1 }));
    log.push({ kind: 'tool', text: '', timestamp: 2, tool: { call: { toolCallId: 'tc-1', title: 'grep' } } });
    const rows = restore(log);
    expect(rows[0].streamDrop.recovered).toBe(true);
  });

  it('recovers the card when REASONING landed after it, with no prose at all', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ attempt: 1 }));
    log.push({ kind: 'thought', text: 'checking the loop', timestamp: 2 });
    const rows = restore(log);
    expect(rows[0].streamDrop.recovered).toBe(true);
  });

  it('never resurrects a STOPPED card, whatever followed it in the log', () => {
    const log: SessionMessage[] = [];
    logStreamDrop(log, notice({ kind: 'stopped', attempt: 3, terminal: true }));
    log.push({ kind: 'agent', text: 'a later, unrelated turn', timestamp: 2 });
    const rows = restore(log);
    expect(rows[0].streamDrop.recovered).toBeUndefined();
  });

  // Fail-closed, the same rule as a 'peer' entry: an entry whose rider did not
  // survive must not rebuild a card full of undefined.
  it('drops a streamDrop entry with no readable rider', () => {
    const rows = restore([{ kind: 'streamDrop', text: '', timestamp: 1 }]);
    expect(rows[0].kind).not.toBe('streamDrop');
  });

  // A log written before this change carries the notice as AGENT PROSE. It must
  // still restore, as prose, with nothing thrown and no pattern matched.
  it('restores a pre-t-q90gj9 text-form log unchanged', () => {
    const rows = restore([
      { kind: 'agent', text: 'Stream dropped (fetch failed) — retrying, attempt 1 of 3.', timestamp: 1 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('agent');
    expect(rows[0].text).toContain('Stream dropped');
    expect(rows[0].streamDrop).toBeUndefined();
  });
});
