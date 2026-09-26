// engineGate.test.ts — work the user starts before the chat's engine is up (t-v5qn37).
//
// The owner's 0.4.173 report: with lazy restore the pane is ready before its engine, and a
// prompt sent then showed a red "prompt failed: AcpClient.prompt called before start()". These
// tests drive the REAL AcpClient (src/acpClient.ts), whose guards are what threw, and the REAL
// turnMessages.ts interject path, through the gate every such path in DashboardPanel.ts now
// takes:
//     const turn = await session.gate.turn(() => session.client.prompt(...));   // send, compose,
//                                            // slash command, /compact, a /loop run
//     routeTurnMessage(session.gate, m, () => handleTurnMessage(...))        // interject
//     if (!(await session.gate.whenUp())) break;                             // mode, model, ...
// `startRun` stands in for the start closure in createSession: the client gets its connection
// and session id only when that start resolves, exactly like AcpClient.start().

import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate, forkRetryRefusal, routeTurnMessage, type EngineStatePost } from '../../../src/dashboard/engineGate';
import { handleTurnMessage } from '../../../src/dashboard/turnMessages';

function harness() {
  const client = new AcpClient({ onClose: vi.fn(), onError: vi.fn() } as unknown as AcpEventHandlers);
  /** What reached the engine, in order: `prompt:<text>`, `interject:<text>`, `config:<id>=<v>`. */
  const wire: string[] = [];
  /** The engine's answer to each prompt, so a test decides when a turn ENDS. */
  const turnEnds: Array<() => void> = [];
  const posts: Array<Record<string, unknown>> = [];
  const told: EngineStatePost[] = [];
  const gate = new EngineGate((p) => told.push(p));
  let finish: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const startRun = () => new Promise<void>((resolve, reject) => {
    finish = () => {
      (client as unknown as { connection: unknown }).connection = {
        prompt: vi.fn((req: { prompt: Array<{ text?: string }> }) => {
          wire.push(`prompt:${req.prompt[0]?.text ?? ''}`);
          return new Promise((done) => turnEnds.push(() => done({ stopReason: 'end_turn' })));
        }),
        extMethod: vi.fn(async (method: string, params: { text?: string }) => {
          wire.push(`${method.replace(/^_/, '')}:${params.text ?? ''}`);
          return { delivered: true };
        }),
        setSessionConfigOption: vi.fn(async (p: { configId: string; value: string }) => {
          wire.push(`config:${p.configId}=${p.value}`);
          return { configOptions: [] };
        }),
      };
      (client as unknown as { sessionId: string }).sessionId = 'ses_engine';
      resolve();
    };
    fail = reject;
  });
  /** The send path (and compose, slash, /compact, a /loop run): one turn through the gate. */
  const prompt = async (text: string): Promise<string> => {
    const turn = await gate.turn(() => client.prompt(text));
    return turn.sent ? turn.value : turn.why;
  };
  /** The interject path, exactly as DashboardPanel routes it. */
  const interject = (text: string) =>
    routeTurnMessage(gate, { type: 'interject' }, () => handleTurnMessage({ client, sessionId: 'session-1', post: (m) => posts.push(m) }, { type: 'interject', text }));
  /** A session call that is not a turn (setMode / setEffort / ...). */
  const setMode = async (mode: string): Promise<boolean> => {
    if (!(await gate.whenUp())) return false;
    await client.setConfigOption('mode', mode);
    return true;
  };
  const endTurn = async () => { turnEnds.shift()?.(); await flush(); };
  return { gate, client, wire, told, posts, startRun, prompt, interject, setMode, endTurn, up: () => finish(), down: (e: Error) => fail(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const redRows = (posts: Array<Record<string, unknown>>) => posts.filter((p) => p['type'] === 'error');

describe('EngineGate — a prompt sent before the engine is up (t-v5qn37)', () => {
  it('holds prompts sent while starting and sends each once, in order, when start completes', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    const first = h.prompt('first');
    const second = h.prompt('second');
    await flush();
    expect(h.wire).toEqual([]); // nothing reaches the engine before it is up
    expect(h.told.map((p) => [p.stage, p.held])).toEqual([['starting', 1], ['starting', 2]]);
    h.up();
    await started;
    await flush();
    expect(h.wire).toEqual(['prompt:first', 'prompt:second']);
    expect(h.told.at(-1)).toEqual({ stage: 'ready', reason: '', held: 2, retry: false });
    await h.endTurn();
    await h.endTurn();
    await expect(first).resolves.toBe('end_turn');
    await expect(second).resolves.toBe('end_turn');
  });

  it('keeps the prompt when the start fails, says why, and Retry sends it once', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    const turn = h.prompt('keep me');
    await flush();
    h.down(new Error('spawn origami.exe ENOENT'));
    await expect(started).rejects.toThrow('ENOENT');
    await flush();
    expect(h.wire).toEqual([]);
    expect(h.told.at(-1)).toMatchObject({ stage: 'failed', reason: 'spawn origami.exe ENOENT', held: 1, retry: true });
    const retried = h.gate.retry();
    expect(h.told.at(-1)).toEqual({ stage: 'starting', reason: '', held: 1, retry: false });
    h.up();
    await retried;
    await flush();
    expect(h.wire).toEqual(['prompt:keep me']);
    await h.endTurn();
    await expect(turn).resolves.toBe('end_turn');
    expect(JSON.stringify(h.told)).not.toContain('called before start');
  });

  it('puts what the engine said while starting into the failure reason, not beside it', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun).catch(() => {});
    expect(h.gate.exited('origami-acp exited (code=1, signal=null)')).toBe(true);
    h.down(new Error('ACP connection closed'));
    await started;
    expect(h.told.at(-1)?.reason).toBe('ACP connection closed (origami-acp exited (code=1, signal=null))');
    expect(h.gate.exited('late close')).toBe(true); // not a "Disconnected" row either
  });

  it('a start nobody waits on tells the pane nothing', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    h.up();
    await started;
    expect(h.told).toEqual([]);
    const turn = h.prompt('after');
    await flush();
    await h.endTurn();
    await expect(turn).resolves.toBe('end_turn');
    expect(h.told).toEqual([]);
  });

  it('Stop releases a held prompt unsent, and a later Retry does not send it', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun).catch(() => {});
    const turn = h.prompt('stop me');
    await flush();
    h.down(new Error('boom'));
    await started;
    h.gate.drop();
    await expect(turn).resolves.toBe('cancelled');
    expect(h.told.at(-1)).toMatchObject({ stage: 'failed', reason: 'boom', held: 0, retry: true });
    const retried = h.gate.retry();
    h.up();
    await retried;
    expect(h.wire).toEqual([]);
  });

  it('after the engine was up and exited, a prompt is refused with the card, never the raw guard error', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    h.up();
    await started;
    expect(h.gate.exited('origami-acp exited (code=null, signal=SIGKILL)')).toBe(false); // the caller posts `closed`
    await expect(h.prompt('too late')).resolves.toBe('error');
    expect(h.wire).toEqual([]);
    expect(h.told.at(-1)).toMatchObject({ stage: 'stopped', reason: 'origami-acp exited (code=null, signal=SIGKILL)', held: 0, retry: false });
  });

  it('a second Retry click while the first is running starts nothing more', async () => {
    const h = harness();
    const run = vi.fn(h.startRun);
    const started = h.gate.start(run).catch(() => {});
    await flush();
    h.down(new Error('boom'));
    await started;
    const a = h.gate.retry();
    const b = h.gate.retry();
    h.up();
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('EngineGate — typing again while a prompt waits (lead review item 1)', () => {
  it('holds the interjection and delivers it AFTER the first turn, with no red row', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    const first = h.prompt('first');
    h.interject('and also this');
    await flush();
    expect(redRows(h.posts)).toEqual([]);
    expect(h.told.at(-1)).toMatchObject({ stage: 'starting', held: 2 });
    h.up();
    await started;
    await flush();
    // The first prompt is on the wire; the interjection waits for its turn to END. Sent now,
    // the engine would take it as a turn of its own and write it BEFORE the first prompt.
    expect(h.wire).toEqual(['prompt:first']);
    await h.endTurn();
    await first;
    await flush();
    expect(h.wire).toEqual(['prompt:first', 'interject:and also this']);
    expect(h.posts).toEqual([{ type: 'interjected', sessionId: 'session-1' }]);
    expect(redRows(h.posts)).toEqual([]);
  });

  it('keeps the interjection with the first prompt when the start fails, and Retry sends both in order', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun).catch(() => {});
    void h.prompt('first');
    h.interject('second');
    await flush();
    h.down(new Error('boom'));
    await started;
    expect(h.told.at(-1)).toMatchObject({ stage: 'failed', reason: 'boom', held: 2, retry: true });
    expect(redRows(h.posts)).toEqual([]);
    const retried = h.gate.retry();
    h.up();
    await retried;
    await flush();
    await h.endTurn();
    expect(h.wire).toEqual(['prompt:first', 'interject:second']);
  });

  it('an interjection into a turn that is already running still goes at once', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    h.up();
    await started;
    void h.prompt('running');
    await flush();
    h.interject('now');
    await flush();
    expect(h.wire).toEqual(['prompt:running', 'interject:now']);
  });
});

describe('EngineGate — /compact, a /loop run and session calls wait too (lead review item 2)', () => {
  it('a /compact clicked while the engine starts goes after the prompt sent before it, never before start', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    void h.prompt('hello');
    const compact = h.prompt('/compact');
    await flush();
    expect(h.wire).toEqual([]);
    h.up();
    await started;
    await flush();
    expect(h.wire).toEqual(['prompt:hello', 'prompt:/compact']);
    await h.endTurn();
    await h.endTurn();
    await expect(compact).resolves.toBe('end_turn');
  });

  it("a /loop's first run (which goes at once) waits for the engine instead of failing", async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    const run = h.prompt('Scheduled run: triage the failing tests');
    await flush();
    expect(h.told.at(-1)).toMatchObject({ stage: 'starting', held: 1 });
    h.up();
    await started;
    await flush();
    await h.endTurn();
    await expect(run).resolves.toBe('end_turn');
    expect(h.wire).toEqual(['prompt:Scheduled run: triage the failing tests']);
  });

  it('a mode change made while starting is applied once the engine is up, and is not a "message"', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    const changed = h.setMode('plan');
    await flush();
    expect(h.told).toEqual([]); // a setting is not a held message: no card for it
    h.up();
    await started;
    await expect(changed).resolves.toBe(true);
    expect(h.wire).toEqual(['config:mode=plan']);
  });

  it('a session call does not wait behind a held interjection for a whole turn', async () => {
    const h = harness();
    const started = h.gate.start(h.startRun);
    void h.prompt('first');
    h.interject('second');
    const changed = h.setMode('plan');
    h.up();
    await started;
    await expect(changed).resolves.toBe(true);
    expect(h.wire).toEqual(['prompt:first', 'config:mode=plan']);
  });
});

describe('EngineGate — Retry on a failed /btw fork (lead review item 3)', () => {
  it('refuses Retry when the fork call never returned an id, and says what to do instead', async () => {
    const h = harness();
    const run = vi.fn(h.startRun);
    const started = h.gate.start(run, () => forkRetryRefusal(true, h.client.currentSessionId)).catch(() => {});
    await flush();
    h.down(new Error('ACP connection closed'));
    await started;
    expect(h.told.at(-1)).toMatchObject({
      stage: 'failed',
      reason: 'ACP connection closed · The fork did not open, and a new try could make a second copy. Close this tab and use the Fork button again.',
      held: 0,
      retry: false,
    });
    await h.gate.retry();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('allows Retry once the fork has its id, and the retry reuses it instead of forking again', async () => {
    const unstable_forkSession = vi.fn(async () => ({ sessionId: 'ses_second_copy' }));
    const client = new AcpClient({ onClose: vi.fn(), onError: vi.fn() } as unknown as AcpEventHandlers);
    (client as unknown as { connection: unknown }).connection = { unstable_forkSession };
    (client as unknown as { sessionId: string }).sessionId = 'ses_fork'; // the first attempt's fork returned this
    expect(forkRetryRefusal(true, client.currentSessionId)).toBe('');
    await expect(client.start('C:/ws', undefined, undefined, false, undefined, 'ses_source')).resolves.toBe('ses_fork');
    expect(unstable_forkSession).not.toHaveBeenCalled();
  });

  it('never refuses a chat that is not a fork', () => {
    expect(forkRetryRefusal(false, null)).toBe('');
  });
});
