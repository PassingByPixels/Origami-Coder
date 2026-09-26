// park.ts — t-w2txb2 (epic t-w1r73y, option D3): stop one chat's engine on purpose, and bring it
// back for the same engine session on the next use. The decision WHEN is parkPolicy.ts (pure) and
// the activity tracker; this file is the mechanics. No vscode here: DashboardPanel hands in the chat.
//
// Park:   the gate goes to `parked` first (synchronous, so no new work can reach the engine behind
//         its back), then the engine is asked `_elastic_park` — its own last check, and the peer
//         stand-ins that keep the chat addressable — and only on `parked: true` is its stdin closed.
// Wake:   anything that needs the engine goes through the gate: a prompt, an interjection or a
//         session call starts the restore, and a direct client call runs `client.wake`, which is
//         `gate.whenUp()`. The work then goes in the order it came, as after any start.
// Restore: the SAME engine session id, spawned with the env the chat started with (acpClient.ts
//         records it), opened with `session/resume` (no history replayed: the transcript the chat
//         shows is not doubled), then the settings that live only in engine memory are set again:
//         model / effort / mode where the resumed session disagrees with what the chat had, and the
//         sampling overrides the chat set. MCP is connected before the first request by the engine
//         itself (every request awaits its MCP state; R4, test/elastic/restore-bytes.test.ts).
// Undo (t-wdyi2t): once asked, the engine may have withdrawn its peer entry and written its stand-ins
//         (engine `_elastic_park`). An engine the chat KEEPS after that (work arrived during the ask, or
//         the ask failed or ran out of time) is told `_elastic_unpark` before any work reaches it: it
//         registers again, deletes its stand-ins and delivers the mail that waited. If that fails too, the
//         engine is stopped and the work resumes it, the same as after a park.
// Exits:  the session id is kept through an exit during the ask or the restore (acpClient.ts), so a crash
//         then ends parked (the next use resumes it) or in the reconnect card with Retry: never `ready`
//         with no engine, and never a restore that waits for itself.

/** The slice of AcpClient this needs. */
export interface ParkClient {
  readonly currentSessionId: string | null;
  /** The engine's OS pid; undefined while no engine process runs. */
  readonly pid?: number;
  wake: (() => Promise<void>) | null;
  /** The config values the chat set through this client (AcpClient.sets). */
  readonly sets: ReadonlyMap<string, string>;
  park(): Promise<void>;
  /** false = the engine never stopped and still has the session open (nothing to set again). */
  restore(): Promise<boolean>;
  /** t-x3a89j: stop an engine that did not answer its start in time (the session id stays, as through any exit mid-restore). */
  stopStart(): Promise<void>;
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  setConfigOption(configId: string, value: string): Promise<void>;
  getModelOption(): { current: string } | null;
  getEffortOption(): { current: string } | null;
  getModeOption(): { current: string } | null;
}

/** The slice of EngineGate this needs. */
export interface ParkGate {
  readonly current: string;
  park(restore: () => Promise<void>): boolean;
  unpark(): void;
  whenUp(): Promise<boolean>;
}

export interface ParkChat {
  client: ParkClient;
  gate: ParkGate;
}

export interface ParkOptions {
  hostPid?: number;
  /** Idle-report reasons that do not block this park (engine `_elastic_park` accepts `warm-pending` only). */
  allow?: readonly string[];
  /** The longest wait for the engine's answer to `_elastic_park` or `_elastic_unpark`. */
  limitMs?: number;
  /** A restore finished: the activity tracker reads the new process's class. */
  restored?: () => void;
  /** t-x3a89j: the longest wait for the restored engine to answer (spawn, initialize, session/resume). */
  startLimitMs?: number;
  /** t-xoenz1: which chat this is, with its kind and pid (elastic/engineLabel.ts engineWho), for the parked and
   *  restored lines. Read when the line is written: the pid of the process that stopped, or of the new one. */
  who?: () => string;
  /** t-z6ytkw: the engine is stopped; its `_elastic_park` answer (with any `warms` it handed over, warmWake.ts). */
  parked?: (answer: Record<string, unknown>) => void;
}

/** The same limit the activity tracker gives its own calls. */
export const PARK_CALL_LIMIT_MS = 30_000;
/** t-x3a89j: an engine start or restore with no answer by then has failed (the card offers Retry). A restore takes
 *  1.4 s to `session/resume` from the binary and 4-12 s from source under load (soak_elastic.md, t-w2txb2). */
export const START_LIMIT_MS = 60_000;

/** t-x3a89j: `call` (a start or a restore) with a time limit. On time-out the engine is stopped first (`stop`), so
 *  Retry starts a fresh one instead of asking the hung one again, then the start fails with a reason that says so. */
export async function startWithin<T>(call: Promise<T>, stop: () => Promise<void>, ms = START_LIMIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol('late');
  const limit = new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), ms); });
  try {
    const first = await Promise.race([call, limit]);
    if (first !== late) return first as T;
  } finally {
    clearTimeout(timer);
  }
  call.catch(() => undefined); // the stopped engine's call fails later: nobody waits for it
  await stop();
  throw new Error(`the engine did not answer in ${ms / 1000} s; it was stopped`);
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** JSON-RPC -32601: an engine that predates the method. */
export function isMissingMethod(e: unknown): boolean {
  return /-32601|method not found/i.test(`${(e as { code?: unknown })?.code ?? ''} ${text(e)}`);
}

/** An engine call with a time limit. */
export function limited<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); });
  return Promise.race([call, limit]).finally(() => clearTimeout(timer));
}

/** The engine-memory settings a restore sets again, in this order: a model change resets the
 *  effort to the model's default, so effort is compared after it. */
const SELECTS = ['model', 'effort', 'mode'] as const;
/** Sampling overrides live only in engine memory and are not in `configOptions` at all. */
const SAMPLING = ['temperature', 'topP'] as const;

type Snapshot = Partial<Record<(typeof SELECTS)[number] | (typeof SAMPLING)[number], string>>;

function current(client: ParkClient, id: (typeof SELECTS)[number]): string | undefined {
  const opt = id === 'model' ? client.getModelOption() : id === 'effort' ? client.getEffortOption() : client.getModeOption();
  return opt?.current || undefined;
}

/** What the chat has now, to be true again after a restore. */
export function snapshot(client: ParkClient): Snapshot {
  const out: Snapshot = {};
  for (const id of SELECTS) {
    const v = current(client, id);
    if (v) out[id] = v;
  }
  for (const id of SAMPLING) {
    const v = client.sets.get(id);
    if (v !== undefined) out[id] = v;
  }
  return out;
}

/** Start the engine again for the kept session and make its settings what they were. */
export async function restoreChat(client: ParkClient, snap: Snapshot, log: (line: string) => void, limitMs = START_LIMIT_MS, who?: () => string): Promise<void> {
  const t0 = Date.now();
  if (!(await startWithin(client.restore(), () => client.stopStart(), limitMs))) { client.wake = null; return; } // the engine never stopped: it has every setting
  for (const id of SELECTS) {
    const want = snap[id];
    if (want && current(client, id) !== want) await client.setConfigOption(id, want);
  }
  for (const id of SAMPLING) {
    const want = snap[id];
    if (want !== undefined) await client.setConfigOption(id, want);
  }
  // An engine that exited meanwhile is not "ready": the start fails and the card offers Retry (review #6).
  if (client.pid === undefined) throw new Error('the engine stopped while it was starting again');
  client.wake = null;
  log(`[elastic] restored engine session ${client.currentSessionId} in ${Date.now() - t0} ms${who ? ` · ${who()}` : ''}`);
}

/** Tell a kept engine to undo its park. false = no answer: the caller treats it as crashed. */
async function unpark(client: ParkClient, log: (line: string) => void, ms: number): Promise<boolean> {
  try {
    const answer = await limited(client.extMethod('_elastic_unpark', {}), ms);
    log(`[elastic] kept engine session ${client.currentSessionId}: unparked, ${String(answer['delivered'] ?? 0)} waiting message(s) delivered`);
    return true;
  } catch (e) {
    log(`[elastic] kept engine session ${client.currentSessionId}: unpark failed (${text(e)}); it is stopped and the next use starts it again`);
    return false;
  }
}

/** Why a park did not happen, or null when the engine is now stopped. */
export async function parkChat(chat: ParkChat, log: (line: string) => void, opts: ParkOptions = {}): Promise<string | null> {
  const { client, gate } = chat;
  const ms = opts.limitMs ?? PARK_CALL_LIMIT_MS;
  const allow = opts.allow ?? [];
  if (!client.currentSessionId) return 'no engine session';
  if (client.wake) return 'already parked';
  const snap = snapshot(client);
  let settled: () => void = () => undefined;
  const asked = new Promise<void>((r) => { settled = r; });
  /** The engine may have parked its peer side and the chat keeps it: unpark it before any work. */
  let undo = false;
  /** The restore runs: a client call it makes (the settings set again) must not wait for itself. */
  let restoring = false;
  /** A park request that ran out of time may still land on the kept engine. */
  let late: Promise<unknown> | null = null;
  let back: Promise<void> = Promise.resolve();
  const bringBack = (): Promise<void> => (back = (async () => {
    await asked; // never before the park request settled: the unpark must not overtake it
    restoring = true;
    try {
      if (undo) {
        undo = false;
        if (!(await unpark(client, log, ms))) await client.park();
      }
      await restoreChat(client, snap, log, opts.startLimitMs, opts.who);
      void late?.then((a) => { if ((a as Record<string, unknown> | undefined)?.['parked'] === true && !client.wake) void client.extMethod('_elastic_unpark', {}).catch(() => undefined); }, () => undefined);
      opts.restored?.();
    } finally {
      restoring = false;
    }
  })());
  if (!gate.park(bringBack)) return `engine ${gate.current}, or work in flight`;
  // From here every client call that needs the engine goes through the gate: during the ask (the
  // engine is up but parking), while stopped, and after a failed restore (the gate holds it for Retry).
  client.wake = async () => {
    if (!restoring) {
      if (!(await gate.whenUp())) throw new Error('the engine did not start again');
    } else if (client.pid === undefined) {
      throw new Error('the engine stopped while it was starting again');
    }
  };
  const call = client.extMethod('_elastic_park', { hostPid: opts.hostPid ?? process.pid, ...(allow.length > 0 ? { allow: [...allow] } : {}) });
  let answer: Record<string, unknown> | undefined;
  let failure = '';
  try {
    answer = await limited(call, ms);
  } catch (e) {
    // An engine that predates the method is parked without peer stand-ins; any other failure keeps it up.
    if (!isMissingMethod(e)) { failure = text(e); late = call; }
  }
  const woken = gate.current !== 'parked';
  undo = failure !== '' || (answer?.['parked'] === true && woken);
  settled();
  if (!client.currentSessionId) return 'the chat closed during the park'; // disposed: start nothing (ParkHost.closed cleans up)
  if (answer?.['parked'] === false) {
    if (!woken) { client.wake = null; gate.unpark(); }
    const reasons = Array.isArray(answer['reasons']) ? answer['reasons'].join(', ') : '';
    return `the engine refused: ${reasons || 'busy'}`;
  }
  // Work that arrived during the ask has started the restore (bringBack): it unparks the engine first.
  if (woken) return 'woken during the park';
  if (failure) {
    if (client.pid === undefined) {
      // It exited during the ask: nothing runs and the session is kept, so the chat IS parked now.
      undo = false;
      log(`[elastic] engine session ${client.currentSessionId} exited during the park (${failure}); the next use starts it again${opts.who ? ` · ${opts.who()}` : ''}`);
      return null;
    }
    void gate.whenUp(); // keep it: the gate runs bringBack, which unparks it (or stops and resumes it)
    await back.catch(() => undefined);
    return `the engine did not answer the park: ${failure}`;
  }
  const who = opts.who?.(); // t-xoenz1: before the stop takes the pid away
  await client.park();
  log(`[elastic] parked engine session ${client.currentSessionId}${who ? ` · ${who}` : ''}`);
  opts.parked?.(answer ?? {});
  return null;
}
