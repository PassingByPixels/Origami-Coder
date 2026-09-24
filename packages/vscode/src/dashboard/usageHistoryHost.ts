// The real dependencies behind the glide path's sampling pass. A leaf because DashboardPanel.ts is
// at its architecture cap — the panel keeps three lines (import, message route, one constructor
// line).
// usageHistory.ts is pure of VS Code and the filesystem so its schedule is testable; everything it
// needs from the outside world (globalState, engine connection, credential file, Claude reader) is
// resolved here. No credential is read here — only `existsSync` on the CLI's credential path;
// nothing in this extension ever writes it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// A runtime import, not type-only: the cadence override is a setting and must be read from the live
// API, same as every other host leaf here.
import * as vscode from 'vscode';
import { CREDENTIALS_RELATIVE, nodePlanUsageDeps, readPlanWindows } from '../claudeCode/planUsage';
import { oauthConnectedIds } from './providerAuthPane';
import { OAUTH_USAGE_PROVIDERS, configuredUsageCapableIds } from './usageCapable';
import type { ProviderUsageClient } from './providerUsageFetch';
import { CLAUDE_PLAN_ID, USAGE_HISTORY_KEY, type UsageHistoryHost } from './usageHistory';

/** The panel's one import for the whole feature. */
export { GLIDEPATH_MESSAGE_TYPES, handleGlidepathMessage, startUsageSampling } from './usageHistory';

/** Wire the sampler to this window. `session` is a FUNCTION, not a value: the timer outlives every
 *  chat, and a client resolved once at construction would be undefined for the whole session. */
export function glidepathHost(
  context: vscode.ExtensionContext,
  session: () => { client?: ProviderUsageClient } | undefined,
  post: (msg: Record<string, unknown>) => void,
): UsageHistoryHost {
  const log = (line: string) => console.log(line);
  return {
    get client() { return session()?.client; },
    post,
    read: () => context.globalState.get(USAGE_HISTORY_KEY),
    write: (next) => void context.globalState.update(USAGE_HISTORY_KEY, next),
    now: () => Date.now(),
    capableIds: async () => {
      // Holding a credential isn't enough — asking a provider the engine has no usage source for
      // earns a refusal once per pass for nothing.
      const oauth = await oauthConnectedIds(session()?.client);
      const ids = [...OAUTH_USAGE_PROVIDERS.filter((id) => oauth?.has(id)), ...configuredUsageCapableIds()];
      // The passthrough is OFFERED rather than configured (models.ts), so its
      // only evidence is the CLI's own credential file.
      try {
        if (fs.existsSync(path.join(os.homedir(), ...CREDENTIALS_RELATIVE))) ids.push(CLAUDE_PLAN_ID);
      } catch { /* no home directory readable: no passthrough, not an error */ }
      return ids;
    },
    // The cadence overrides, read fresh on every pass so a setting change takes
    // effect on the next sample rather than on the next window reload.
    windowLengths: () => {
      const raw = vscode.workspace.getConfiguration('origamicoder.usage').get<unknown>('windowLength');
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
      const out: Record<string, string | number> = {};
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number') out[id] = value;
      }
      return out;
    },
    planWindows: async () =>
      (await readPlanWindows(nodePlanUsageDeps(log))).map((w) => ({
        label: w.label,
        usedPercent: w.pct,
        resetsAt: w.resetsAt,
        ...(w.lengthMs !== undefined ? { lengthMs: w.lengthMs } : {}),
      })),
    log,
  };
}
