// subagentLimitWire — how the drawer learns the sub-agent ceiling, and the
// guard that keeps it asking the host the question the host answers.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { limitFromMessage, SUBAGENT_LIMIT_DATA, watchSubagentLimit } from '../panes/subagentLimitWire';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('limitFromMessage', () => {
  it('decodes the host reply to milliseconds', () => {
    expect(limitFromMessage({ type: SUBAGENT_LIMIT_DATA, hours: 4 })).toBe(14_400_000);
  });

  it('reports 0 for an unusable value rather than falling back to four hours', () => {
    // The webview must never invent a ceiling: it would amber and sweep rows
    // against a limit the engine was not spawned with.
    expect(limitFromMessage({ type: SUBAGENT_LIMIT_DATA, hours: '4' })).toBe(0);
    expect(limitFromMessage({ type: SUBAGENT_LIMIT_DATA })).toBe(0);
  });

  it('returns undefined — NOT 0 — for any other message', () => {
    // 0 means "the setting is unusable" and would blank a ceiling the drawer
    // already has; undefined means "this was not the answer", so it is ignored.
    expect(limitFromMessage({ type: 'todoUpdate', hours: 4 })).toBeUndefined();
    expect(limitFromMessage(null)).toBeUndefined();
    expect(limitFromMessage(undefined)).toBeUndefined();
  });
});

describe('watchSubagentLimit', () => {
  function harness() {
    const posted: unknown[] = [];
    const seen: number[] = [];
    let handler: ((msg: unknown) => void) | undefined;
    let stopped = false;
    const stop = watchSubagentLimit({
      post: (msg) => posted.push(msg),
      listen: (h) => { handler = h; return () => { stopped = true; }; },
      onLimit: (ms) => seen.push(ms),
    });
    return { posted, seen, stop, deliver: (msg: unknown) => handler?.(msg), stopped: () => stopped };
  }

  it('subscribes BEFORE it asks, so a synchronous reply is not missed', () => {
    const h = harness();
    // The request went out and a listener was already in place to catch it.
    expect(h.posted).toEqual([{ type: 'requestSubagentLimit' }]);
    h.deliver({ type: SUBAGENT_LIMIT_DATA, hours: 2 });
    expect(h.seen).toEqual([7_200_000]);
  });

  it('KEEPS listening — the Insights card can change the setting mid-session', () => {
    const h = harness();
    h.deliver({ type: SUBAGENT_LIMIT_DATA, hours: 4 });
    h.deliver({ type: SUBAGENT_LIMIT_DATA, hours: 1 });
    expect(h.seen).toEqual([14_400_000, 3_600_000]);
  });

  it('ignores every other host message', () => {
    const h = harness();
    h.deliver({ type: 'todoUpdate' });
    h.deliver({ type: 'toolResult', sessionId: 's1' });
    expect(h.seen).toEqual([]);
  });

  it('tears the listener down when the caller stops', () => {
    const h = harness();
    h.stop();
    expect(h.stopped()).toBe(true);
  });
});

// The message literal is declared on both sides of the wire and the host is
// the one that answers it. House rule: every mirror gets a test.
describe('subagentLimitWire — the mirror guard against subagentLimitPane.ts', () => {
  it('the host still answers the type this file listens for, and the one it asks', () => {
    const host = readFileSync(path.resolve(here, '../../../src/dashboard/subagentLimitPane.ts'), 'utf8');
    expect(host, `the host no longer posts ${SUBAGENT_LIMIT_DATA}`).toContain(`type: '${SUBAGENT_LIMIT_DATA}'`);
    expect(host, 'the host no longer accepts requestSubagentLimit').toContain('requestSubagentLimit');
  });
});
