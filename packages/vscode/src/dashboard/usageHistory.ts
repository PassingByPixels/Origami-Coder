// The sampling PASS that fills the glide path. providerUsage.ts answers "how much is left NOW" with
// one lazy read; a glide path is a shape over a window and needs a schedule.
// Kept honest, not a poller: 30 minutes between passes, a hard floor of 5 minutes per provider, the
// timer lives only as long as the dashboard, and one provider failing costs only that provider its
// sample.
// No new request code — every read goes through fetchProviderUsage or the Claude passthrough's own
// cached GET. No credential ever reaches here; only a label, a percentage and an epoch cross into
// this module.

import { fetchProviderUsage, type ProviderUsageClient } from './providerUsage';
import {
  applySample,
  readStore,
  type SampledWindow,
  type UsageHistoryStore,
} from './usageHistoryStore';

export const GLIDEPATH_MESSAGE_TYPES = new Set(['glidepathRequest']);

/** Where the history lives. globalState, not workspaceState: a plan is an
 *  ACCOUNT's, and it is spent from every window the user has open. */
export const USAGE_HISTORY_KEY = 'origami.usageHistory';

/** How often a pass runs while the dashboard exists. */
export const SAMPLE_INTERVAL_MS = 30 * 60_000;

/** The shortest gap between two reads of ONE provider, whatever triggered them. */
export const PROVIDER_FLOOR_MS = 5 * 60_000;

/** The Claude Code passthrough. Not an engine connection — it is OFFERED rather
 *  than configured, so it has no provider id on the engine side. */
export const CLAUDE_PLAN_ID = 'claude-code';

export interface UsageHistoryHost {
  /** The engine connection of whichever session has one. Absent = no engine reads. */
  readonly client?: ProviderUsageClient;
  readonly post: (msg: Record<string, unknown>) => void;
  /** The persisted store, raw. */
  readonly read: () => unknown;
  readonly write: (next: UsageHistoryStore) => void;
  readonly now: () => number;
  /** Every connection that can report: engine-side OAuth, key-configured, and
   *  CLAUDE_PLAN_ID when its credential file is present. */
  readonly capableIds: () => Promise<readonly string[]>;
  /** The Claude passthrough's lanes. Empty when there is no credential. */
  readonly planWindows: () => Promise<readonly SampledWindow[]>;
  /** The user's per-provider cadence overrides, read here (host-side) rather than in the webview,
   *  so the view gets values with the readings instead of asking twice. Optional so a test host
   *  needn't stub it. */
  readonly windowLengths?: () => Readonly<Record<string, string | number>>;
  readonly log?: (line: string) => void;
}

/** When each provider was last ASKED, not when it last answered. Module state, like
 *  `stopCollabWatch`, so a second dashboard window doesn't double the traffic to an account-wide
 *  quota. A failure stamps it too, so a refusing provider isn't retried in a tight loop. */
const lastFetch = new Map<string, number>();

function isDue(providerId: string, now: number): boolean {
  const last = lastFetch.get(providerId);
  return last === undefined || now - last >= PROVIDER_FLOOR_MS;
}

/** One provider's windows, or none. Never throws, never rejects. */
async function readOne(
  host: UsageHistoryHost,
  providerId: string,
  now: number,
): Promise<{ providerId: string; windows: readonly SampledWindow[] }> {
  lastFetch.set(providerId, now);
  try {
    if (providerId === CLAUDE_PLAN_ID) {
      return { providerId, windows: await host.planWindows() };
    }
    if (!host.client) return { providerId, windows: [] };
    const result = await fetchProviderUsage(host.client, providerId);
    if (!result?.ok || !Array.isArray(result.windows)) {
      // A refusal is normal — an expired browser session, an unlimited plan, an
      // engine that predates the ext method. It costs this provider one sample.
      if (result?.unavailable) host.log?.(`[glidepath] ${providerId}: ${result.unavailable}`);
      return { providerId, windows: [] };
    }
    return { providerId, windows: result.windows };
  } catch (e) {
    host.log?.(`[glidepath] ${providerId} read failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    return { providerId, windows: [] };
  }
}

/** One pass: read every due provider in parallel (each swallows its own failure, so one hanging
 *  provider can't stop the others), fold the samples sequentially since `applySample` is pure,
 *  persist only if something was recorded. */
export async function sampleUsage(
  host: UsageHistoryHost,
): Promise<{ store: UsageHistoryStore; capable: string[] }> {
  const now = host.now();
  let capable: string[] = [];
  try {
    capable = [...(await host.capableIds())];
  } catch {
    capable = [];
  }
  const reads = await Promise.all(capable.filter((id) => isDue(id, now)).map((id) => readOne(host, id, now)));

  let store = readStore(host.read());
  let changed = false;
  for (const read of reads) {
    for (const window of read.windows) {
      const next = applySample(store, read.providerId, window, now);
      if (next !== store) {
        store = next;
        changed = true;
      }
    }
  }
  if (changed) host.write(store);
  return { store, capable };
}

/** A pass, then the answer to the webview. The pass runs first so the view opens on the freshest
 *  reading allowed; when every provider is inside its floor, the stored history posts unchanged
 *  rather than the view sitting blank. */
export async function sampleAndPost(host: UsageHistoryHost): Promise<void> {
  const { store, capable } = await sampleUsage(host);
  host.post({
    type: 'glidepathData',
    now: host.now(),
    providers: store.providers,
    capable,
    windowLengths: host.windowLengths?.() ?? {},
  });
}

/** The webview asking for the view. One message type, one answer. */
export async function handleGlidepathMessage(
  host: UsageHistoryHost,
  m: Record<string, unknown>,
): Promise<void> {
  if (m.type !== 'glidepathRequest') return;
  await sampleAndPost(host);
}

let timer: ReturnType<typeof setInterval> | undefined;
let owner: symbol | undefined;

/**
 * Start sampling for the life of a dashboard. ONE timer for the whole
 * extension host, held in module state so a second panel can't double the
 * traffic; the newest panel takes it over and an older panel's disposable
 * goes inert. Every pass's result is posted whether or not the Glidepath
 * view is on screen — the view ignores what it didn't ask for.
 */
export function startUsageSampling(host: UsageHistoryHost): { dispose(): void } {
  const token = Symbol('glidepath');
  stopUsageSampling();
  owner = token;
  void sampleAndPost(host);
  timer = setInterval(() => void sampleAndPost(host), SAMPLE_INTERVAL_MS);
  return {
    dispose: () => {
      if (owner === token) stopUsageSampling();
    },
  };
}

export function stopUsageSampling(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  owner = undefined;
}

/** Test seam — the two pieces of module state above are deliberate (see them). */
export function __resetUsageSamplingForTests(): void {
  stopUsageSampling();
  lastFetch.clear();
}
