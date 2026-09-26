// hostPark.ts — t-wdyi2t (epic t-w1r73y, review_extension-lifecycle.md #5, lead decision 2026-09-25): the
// window's host engine (dashboard/hostEngine.ts) is stopped after HOST_PARK_AFTER_MS with no host call and no
// work, and the next host read starts it again (HostEngine.ensure / ensureOwn spawn lazily). The activity
// tracker decides WHEN: the host engine's view carries this as its park hook, with this delay, so the same
// rules hold as for a chat (idle class, a FRESH idle report that says parkable, the provider cache cold).
// This file is the stop. No vscode here.
//
// The engine's own `_elastic_park` is its atomic last check (the flock lease, a collab run, a job). A host
// engine has no chat to restore, so the stand-ins it writes are removed at once: a stopped host engine is
// not addressable, as after a window close. A host call made during the ask keeps the engine: it is told
// `_elastic_unpark` (fallback: stopped, and the next read starts a fresh one).

import { PARK_CALL_LIMIT_MS, isMissingMethod, limited } from './park';
import { removeStandIn as removeStandInFile } from './parkedMail';

/** Lead decision 2026-09-25. Applies only while parking is on (`parkAfterMinutes` > 0). */
export const HOST_PARK_AFTER_MS = 10 * 60_000;

export interface HostParkClient {
  /** When the host last asked this engine something (AcpClient.lastExtAt; `_elastic_*` calls do not count). */
  lastExtAt?: number;
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The slice of HostEngine this needs. */
export interface HostParkEngine<C extends HostParkClient> {
  ownClient(): C | undefined;
  stopOwn(client: C): void;
}

export interface HostParkDeps {
  log(line: string): void;
  removeStandIn?: (sessionId: string) => void;
  hostPid?: number;
  limitMs?: number;
}

/** Stop the host engine. null = stopped, else why not. */
export async function parkHostEngine<C extends HostParkClient>(engine: HostParkEngine<C>, deps: HostParkDeps): Promise<string | null> {
  const client = engine.ownClient();
  if (!client) return 'no host engine';
  const ms = deps.limitMs ?? PARK_CALL_LIMIT_MS;
  const askedAt = Date.now();
  let answer: Record<string, unknown> | undefined;
  let why: string | null = null;
  try {
    answer = await limited(client.extMethod('_elastic_park', { hostPid: deps.hostPid ?? process.pid }), ms);
  } catch (e) {
    if (!isMissingMethod(e)) why = `the host engine did not answer the park: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (answer?.['parked'] === false) {
    const reasons = Array.isArray(answer['reasons']) ? answer['reasons'].join(', ') : '';
    return `the host engine refused: ${reasons || 'busy'}`;
  }
  if (why === null && (engine.ownClient() !== client || (client.lastExtAt ?? 0) >= askedAt)) why = 'the host engine was used during the park';
  if (why !== null) {
    // Keep it, and undo what the engine may have done for the park.
    try {
      await limited(client.extMethod('_elastic_unpark', {}), ms);
      deps.log(`[elastic] host engine kept (${why})`);
      return why;
    } catch (e) {
      deps.log(`[elastic] host engine: unpark failed (${e instanceof Error ? e.message : String(e)}); it is stopped, the next host read starts it again`);
    }
  }
  engine.stopOwn(client);
  const ids = Array.isArray(answer?.['sessionIds']) ? (answer['sessionIds'] as unknown[]).map(String) : [];
  for (const sid of ids) (deps.removeStandIn ?? removeStandInFile)(sid);
  deps.log('[elastic] host engine stopped (idle); the next host read starts it again');
  return null;
}
