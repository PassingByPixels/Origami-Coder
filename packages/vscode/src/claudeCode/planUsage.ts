// planUsage.ts — the plan-headroom badge without waiting for a rate_limit_event warning.
// Reads the same OAuth credential the CLI itself reads, for one GET, since `claude-code` is offered
// but not configured and has no engine-side credential.
// The token never leaves this file: read from disk, put on one outbound Authorization header, and
// dropped. It is never logged, never posted to the webview, never written anywhere.
// Lazy, never polled — callers ask only on events they already redraw for.

import type { RateLimitPill } from './usagePill';
import { planPillOf, planWindowsOf, rec, type PlanWindow } from './planUsageParse';

// Re-exported so callers and tests keep one import path for the feature.
export { planPillOf, planWindowsOf, resetsAtMs } from './planUsageParse';
export type { PlanWindow } from './planUsageParse';

/** Where the CLI keeps its OAuth credential on win32/linux. macOS may use the
 *  keychain instead, in which case the file is absent and there is no pill —
 *  which is the correct degradation, not an error. */
export const CREDENTIALS_RELATIVE = ['.claude', '.credentials.json'] as const;

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The CLI's own UA. The endpoint is the CLI's; presenting as it is what makes
 *  the read the same read, rather than a new client of an unpublished API. */
export const USAGE_USER_AGENT = 'claude-code/2.1.198';

/** How long one reading is reused. Three lazy triggers can land in the same
 *  second (a bind that immediately prompts); one call answers all of them. */
export const USAGE_TTL_MS = 60_000;

/** The IO this module needs, injected so a test never reads a real credential
 *  and never opens a socket. */
export interface PlanUsageDeps {
  homedir(): string;
  readFile(path: string): string | undefined;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now(): number;
  log?(line: string): void;
}

/** The bearer, and when it stops being one. Returned as a value nobody stores:
 *  the only caller puts it straight on a header. */
function credential(deps: PlanUsageDeps): { token: string; expiresAt: number } | null {
  const path = [deps.homedir(), ...CREDENTIALS_RELATIVE].join('/');
  const raw = deps.readFile(path);
  if (!raw) return null;
  try {
    const oauth = rec(rec(JSON.parse(raw) as unknown)?.claudeAiOauth);
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token) return null;
    const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

// ACCOUNT-WIDE, so module-level is the right scope and NOT the per-cell leak
// class: every bound cell in every window is asking about the same plan, and a
// per-cell copy would mean N calls for one answer. Cleared by the test seam.
let cached: { pill: RateLimitPill | null; windows: PlanWindow[]; at: number } | undefined;

/**
 * One reading, read two ways: the pill and the glide path want different slices of the same
 *  response body, and both are asked for on the same events, so deriving both from one call keeps
 *  it at one request rather than two.
 *
 * Every failure is an empty reading and a log line with no detail that could identify the
 *  credential.
 */
async function readPlan(deps: PlanUsageDeps): Promise<{ pill: RateLimitPill | null; windows: PlanWindow[] }> {
  const now = deps.now();
  if (cached && now - cached.at < USAGE_TTL_MS) return { pill: cached.pill, windows: cached.windows };
  const cred = credential(deps);
  // An expired token would come back 401. Not calling is the same answer,
  // one round trip cheaper, and it keeps a dead credential off the wire.
  if (!cred || (cred.expiresAt > 0 && cred.expiresAt <= now)) {
    cached = { pill: null, windows: [], at: now };
    return { pill: null, windows: [] };
  }
  let pill: RateLimitPill | null = null;
  let windows: PlanWindow[] = [];
  try {
    const res = await deps.fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${cred.token}`,
        'user-agent': USAGE_USER_AGENT,
        accept: 'application/json',
      },
    });
    if (res.ok) {
      const body = await res.json();
      pill = planPillOf(body, now);
      windows = planWindowsOf(body, now);
    } else deps.log?.(`[claude-code] plan usage unavailable (HTTP ${res.status})`);
  } catch (e) {
    // The MESSAGE only. A thrown fetch error can carry the request in its
    // `cause`, and the request carries the header.
    deps.log?.(`[claude-code] plan usage read failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  cached = { pill, windows, at: now };
  return { pill, windows };
}

/** The account's plan headroom as ONE pill — the tightest lane. */
export async function readPlanUsage(deps: PlanUsageDeps): Promise<RateLimitPill | null> {
  return (await readPlan(deps)).pill;
}

/** The same reading as EVERY lane, for the glide path. Empty on every failure. */
export async function readPlanWindows(deps: PlanUsageDeps): Promise<PlanWindow[]> {
  return (await readPlan(deps)).windows;
}

/** Test seam — the cache above is module state by design (see its comment). */
export function __resetPlanUsageForTests(): void {
  cached = undefined;
}

/** The real IO. Kept at the bottom behind the seam, the same shape driver.ts
 *  keeps its `defaultSpawn` in, so nothing above needs a process or a socket. */
export function nodePlanUsageDeps(log?: (line: string) => void): PlanUsageDeps {
  // Required lazily so the pure top of this module stays importable in a DOM
  // test environment.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require('node:os') as typeof import('node:os');
  return {
    homedir: () => os.homedir(),
    readFile: (path) => {
      try { return fs.readFileSync(path, 'utf8'); } catch { return undefined; }
    },
    fetch: (url, init) => (globalThis.fetch as typeof fetch)(url, { method: 'GET', headers: init.headers }),
    now: () => Date.now(),
    ...(log ? { log } : {}),
  };
}
