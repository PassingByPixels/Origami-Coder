// t-wusuep — the defect: ONE `modelOpInFlight` boolean for the whole panel. A
// brand-new chat with zero turns answered its first model pick with "A model
// operation is already running - ignored." because some OTHER chat's
// `setModel` was still inside an unbounded engine refresh. Three things were
// wrong and each gets a test here: the lock was global, it had no deadline, and
// the sentence named nothing.
//
// These drive ModelOpGuard directly rather than the panel: the three call sites
// live inside a VS Code message handler with no seam a unit test can reach, so
// the DECISION lives in the leaf and the wiring is source-guarded at the bottom
// (the pattern approveModeUnknownSession.test.ts uses).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelOpGuard, formatOpAge, withDeadline, MODEL_SWITCH_DEADLINE_MS } from '../../../src/dashboard/modelOps';

afterEach(() => { vi.useRealTimers(); });

describe('ModelOpGuard — one chat never blocks another', () => {
  it('session B switches while session A is still inside a setModel that never resolves', async () => {
    const guard = new ModelOpGuard();
    const order: string[] = [];

    // Chat A asks the engine to switch and the engine never answers.
    const a = guard.begin('ses-a', 'switching Alpha to gpt-5.6-luna');
    expect(a).toBeDefined();
    const hung = new Promise<string>(() => { /* never resolves — the defect's engine call */ });
    void hung.then(() => order.push('A finished'));

    // Chat B, created seconds later, must still be able to switch AND finish.
    const b = guard.begin('ses-b', 'switching Bravo to qwen3-coder');
    expect(b).toBeDefined();
    await Promise.resolve('bravo/qwen3-coder');
    b!.release();
    order.push('B finished');

    expect(order).toEqual(['B finished']);
    // A is still out, so a SECOND pick in chat A is the one that gets dropped.
    expect(guard.begin('ses-a', 'switching Alpha to something-else')).toBeUndefined();
    // ...and chat B, now free, can go again.
    expect(guard.begin('ses-b', 'switching Bravo again')).toBeDefined();
  });

  it('a release frees only the chat it belongs to', () => {
    const guard = new ModelOpGuard();
    const a = guard.begin('ses-a', 'ejecting all models in Alpha')!;
    guard.begin('ses-b', 'loading qwen in Bravo');
    a.release();

    expect(guard.begin('ses-a', 'second op in Alpha')).toBeDefined();
    expect(guard.begin('ses-b', 'second op in Bravo')).toBeUndefined();
  });
});

describe('withDeadline — a hung ACP setModel frees the lock and says it is still waiting', () => {
  it('posts the named still-waiting line and releases the chat when the call outruns the deadline', async () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    const settled: string[] = [];
    const guard = new ModelOpGuard();
    const op = guard.begin('ses-a', 'switching Alpha to gpt-5.6-luna')!;

    // The engine call the ticket names: setModel -> config.refresh -> provider
    // snapshot rebuild, with no ceiling of its own.
    void withDeadline(new Promise<string>(() => { }), MODEL_SWITCH_DEADLINE_MS, () => {
      op.release();
      posted.push(`Model switch to gpt-5.6-luna is taking longer than ${MODEL_SWITCH_DEADLINE_MS / 1000} s (engine refresh); still waiting`);
    }).then(() => settled.push('resolved'));

    await vi.advanceTimersByTimeAsync(MODEL_SWITCH_DEADLINE_MS - 1);
    expect(posted).toEqual([]);
    expect(guard.begin('ses-a', 'too soon')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(posted).toEqual([
      'Model switch to gpt-5.6-luna is taking longer than 30 s (engine refresh); still waiting',
    ]);
    // The lock is GONE — the whole point. The user can pick again in THIS chat.
    expect(guard.begin('ses-a', 'switching Alpha to qwen3-coder')).toBeDefined();
    // ...and the hung call's own `finally` must not free the newer op.
    op.release();
    expect(guard.begin('ses-a', 'a third pick')).toBeUndefined();
    // The deadline is not a cancellation: nothing was resolved or rejected.
    expect(settled).toEqual([]);
  });

  it('hands back the resolved value and never fires the deadline when the engine answers in time', async () => {
    vi.useFakeTimers();
    const posted: string[] = [];

    const value = await withDeadline(Promise.resolve('openrouter/gpt-5.6-luna'), 30_000, () => posted.push('deadline'));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(value).toBe('openrouter/gpt-5.6-luna');
    expect(posted).toEqual([]);
  });

  it('clears its timer on a REJECTED call too, so a failed switch posts nothing later', async () => {
    vi.useFakeTimers();
    const posted: string[] = [];

    await expect(
      withDeadline(Promise.reject(new Error('engine died')), 30_000, () => posted.push('deadline')),
    ).rejects.toThrow('engine died');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(posted).toEqual([]);
  });
});

describe('ModelOpGuard — the dropped-click sentence names the op, the chat and its age', () => {
  it('names the running operation and how old it is', () => {
    let clock = 1_000_000;
    const guard = new ModelOpGuard(() => { }, () => clock);
    guard.begin('ses-a', 'switching Cortex-0396 to gpt-5.6-luna');
    clock += 14_000;

    expect(guard.describe('ses-a')).toBe('switching Cortex-0396 to gpt-5.6-luna, started 14 s ago');
    expect(guard.busyMessage('ses-a')).toBe(
      'A model operation is already running in this chat — switching Cortex-0396 to gpt-5.6-luna, started 14 s ago. Ignored.',
    );
  });

  it('ages past a minute read in minutes and seconds', () => {
    expect(formatOpAge(0)).toBe('0 s ago');
    expect(formatOpAge(59_400)).toBe('59 s ago');
    expect(formatOpAge(63_000)).toBe('1 min 3 s ago');
    expect(formatOpAge(-5)).toBe('0 s ago');
  });

  it('falls back to the old wording only when nothing is actually running', () => {
    expect(new ModelOpGuard().busyMessage('ses-a')).toBe('A model operation is already running — ignored.');
  });
});

describe('ModelOpGuard — the output channel names every op', () => {
  it('writes a start line and an end line carrying the elapsed ms', () => {
    let clock = 0;
    const lines: string[] = [];
    const guard = new ModelOpGuard((line) => lines.push(line), () => clock);
    const op = guard.begin('ses-a', 'switching Alpha to gpt-5.6-luna')!;
    clock = 2500;
    op.release();
    op.release(); // idempotent: no second end line

    expect(lines).toEqual([
      'model op switching Alpha to gpt-5.6-luna start',
      'model op switching Alpha to gpt-5.6-luna end (2500 ms)',
    ]);
  });
});

describe('DashboardPanel wires the guard per chat at all three model sites', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'),
    'utf-8',
  );

  it('carries no panel-wide boolean any more', () => {
    expect(src).not.toContain('modelOpInFlight');
  });

  it('begins the lock with the POSTING chat session id at each of the three sites', () => {
    expect([...src.matchAll(/this\.modelOps\.begin\(sid, /g)]).toHaveLength(3);
  });

  it('answers a dropped click with the naming sentence, not a fixed string', () => {
    const drop = /if \(!op\) \{ this\.post\(\{ type: 'system', text: this\.modelOps\.busyMessage\(sid\), sessionId: sid \}\); break; \}/g;
    expect([...src.matchAll(drop)]).toHaveLength(3);
  });

  it('releases the lock in the finally of all three cases', () => {
    expect([...src.matchAll(/\n\s*op\.release\(\);\r?\n/g)]).toHaveLength(3);
  });

  // The deadline wraps ONLY the ACP call. Wrapping the whole case would free the
  // lock in the middle of a legitimate `lms load` of a 30B model — the load storm
  // the lock exists to stop — and would blame "engine refresh" for it.
  it('bounds the ACP setModel await, and only that await', () => {
    expect(src).toContain('await withDeadline(session.client.setModel(modelId), MODEL_SWITCH_DEADLINE_MS,');
    expect([...src.matchAll(/withDeadline\(/g)]).toHaveLength(1);
    expect(src).toMatch(/Model switch to \$\{bareId\} is taking longer than \$\{Math\.round\(MODEL_SWITCH_DEADLINE_MS \/ 1000\)\} s \(engine refresh\); still waiting/);
  });

  it('frees the lock from the deadline callback, so the chat is pickable again', () => {
    expect(src).toMatch(/MODEL_SWITCH_DEADLINE_MS, \(\) => \{ op\.release\(\);/);
  });

  // Optional-chained on purpose: harnesses that build a panel with
  // Object.create(DashboardPanel.prototype) never run the field initialiser, and the
  // boolean this replaced read `undefined` there without throwing. Same falsy answer.
  it('keeps the remote-adopt sweep off ANY in-flight op, as the boolean used to', () => {
    expect(src).toContain('if (this.syncingRemoteModel || this.modelOps?.anyInFlight() || !current) return;');
  });
});
