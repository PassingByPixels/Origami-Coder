// pickFlockClient — which session's engine actually answers a Flock call. A workspace runs one
// engine per chat; flock-owner.json names, by pid, which one holds the relay sockets. The pane
// always reads through the active chat's engine, which may not be the holder. When the holder's pid
// belongs to one of this window's OTHER open chats, routing to the active engine is wrong: a read
// shows a false "running in another window" banner, and a write silently does nothing, since the
// transport is only set on the engine that won the lease. "Not ours" and "ours but gone" both fall
// back to today's behaviour — nothing else in this window can reach the real holder.

/** One session this window could route a Flock call through. */
export interface FlockRouteCandidate<TClient> {
  readonly pid?: number;
  readonly client: TClient;
}

/**
 * The client to use for one Flock call, or `undefined` when the holder is not
 * one of ours (route to the active client instead, as today).
 */
export function pickFlockClient<TClient>(
  sessions: readonly FlockRouteCandidate<TClient>[],
  holderPid: number | undefined,
): TClient | undefined {
  if (holderPid === undefined) return undefined;
  return sessions.find((s) => s.pid === holderPid)?.client;
}

/** The shape `sessions()`/`chat()` need for {@link pickFlockClient} to have
 *  something to search — shared by flockPane.ts and flockMailbox.ts so the
 *  two host interfaces do not each invent their own pid plumbing. */
export interface FlockRouteHost<TClient> {
  sessions?(): { id: string; pid?: number }[];
  chat?(localId: string): { client?: TClient; pid?: number } | undefined;
  /** The window's HOST engine (hostEngine.ts), when it runs. It has no chat, so it is not in
   *  `sessions()`, but it is this window's engine and can hold the lease (t-vbj03h). */
  hostEngine?(): { client?: TClient; pid?: number } | undefined;
}

/** Every session THIS window has open, as `pid` + its live client — the list
 *  {@link pickFlockClient} searches. A chat with no live client (still
 *  starting, or gone) contributes nothing rather than a candidate nobody could
 *  route to. */
export function flockRouteCandidates<TClient>(host: FlockRouteHost<TClient>): FlockRouteCandidate<TClient>[] {
  const out: FlockRouteCandidate<TClient>[] = [];
  for (const session of host.sessions?.() ?? []) {
    const chat = host.chat?.(session.id);
    if (chat?.client) out.push({ pid: chat.pid ?? session.pid, client: chat.client });
  }
  const own = host.hostEngine?.();
  if (own?.client) out.push({ pid: own.pid, client: own.client });
  return out;
}

/** `process.kill(pid, 0)`: does the pid exist. EPERM = it exists, owned by somebody else. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `flock_state`'s `holder.pid`, read off the untyped ACP response both panes
 *  already pass around as `Record<string, unknown>`. */
export function holderPidOf(state: Record<string, unknown>): number | undefined {
  const holder = state['holder'] as { pid?: unknown } | undefined;
  return typeof holder?.pid === 'number' ? holder.pid : undefined;
}

// THE SHARED CACHE. flock_state is the only call that learns the holder pid; flock_mailbox (polled
// every 30s) and every mailbox write need it too, but must not drag a state read behind them to get
// it. So the pid is learned once here, whenever anything reads flock_state, and every other caller
// reads the cache.
let holderPid: number | undefined;
export function getHolderPid(): number | undefined {
  return holderPid;
}

/** For a test only — this module is a singleton across every test in a file. */
export function resetHolderPidForTest(): void {
  holderPid = undefined;
}

/**
 * Read flock_state from the active client. If the flock is elsewhere and the holder is one of THIS
 *  window's own sessions, re-read through that session's client instead and present the result as
 *  `relay` — fixing the false "running in another window" banner for a sibling chat. Caches the
 *  holder pid for flock_mailbox and mailbox writes to route off.
 */
export async function readFlockState<TClient extends { extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }>(
  client: TClient,
  host: FlockRouteHost<TClient>,
  alive: (pid: number) => boolean = pidAlive,
): Promise<Record<string, unknown>> {
  const state = await client.extMethod('flock_state', {});
  holderPid = holderPidOf(state);
  if (state['transport'] !== 'other-engine') return state;
  const routed = pickFlockClient(flockRouteCandidates(host), holderPid);
  if (routed) return { ...(await routed.extMethod('flock_state', {})), transport: 'relay' };
  // A dead holder is no other window: this engine claims the lease on its next beat (5 s).
  if (holderPid !== undefined && !alive(holderPid)) return { ...state, transport: 'none' };
  return state;
}
