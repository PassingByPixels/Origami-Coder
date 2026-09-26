// cacheWarming.ts — the ONE place this shell decides whether prompt-cache
// warming is on (t-ntmmvh).
//
// The engine keeps a long session's cached prefix alive by re-reading it at 80%
// of the cache TTL (engine `src/session/cache-warm.ts`). That is ON by default,
// because a cold read of a full context costs far more than the handful of
// input tokens a warm spends. The switch exists because a warm is still spend,
// and the Insights pane is where this window's spend is answered.
//
// The switch is written INVERTED, the shape flockEnabled.ts uses: only OFF is
// spoken aloud, so a dev who set the engine's own variable outside VS Code is
// not overwritten by a shell that had nothing to say.
//
// Read at SPAWN, once — a change mid-session does nothing until the window
// reloads, which is what the card has to say.
import * as vscode from 'vscode';

/** The setting, in the two halves `getConfiguration` wants. */
export const CACHE_WARMING_SECTION = 'origamicoder.cacheWarming';
export const CACHE_WARMING_ENABLED_KEY = 'enabled';
/** The whole id, for a message that has to name it. */
export const CACHE_WARMING_SETTING = `${CACHE_WARMING_SECTION}.${CACHE_WARMING_ENABLED_KEY}`;

/** The engine's kill switch. MIRRORS `SessionCacheWarm.DISABLE_ENV` across a
 *  process boundary; cacheWarming.test.ts reads the engine file and fails if
 *  the two names drift. */
export const CACHE_WARMING_DISABLE_VAR = 'ORIGAMI_DISABLE_CACHE_WARM';

/** Is warming on? DEFAULT FALSE since 0.4.184 (owner, 2026-09-26): before 0.4.183
 *  no warm was ever sent, so a warm is a new token cost a user must choose. Only an
 *  explicit `true` turns it on; no settings store reads as OFF. The engine still
 *  defaults ON when run on its own, so the spawn env below sets its kill switch
 *  for every chat whose user has not chosen warming. */
export function cacheWarmingEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(CACHE_WARMING_SECTION).get<boolean>(CACHE_WARMING_ENABLED_KEY) === true;
  } catch {
    return false;
  }
}

/** The env overlay one spawn adds: nothing at all while warming is on. */
export function cacheWarmingSpawnEnv(): Record<string, string> {
  return cacheWarmingEnabled() ? {} : { [CACHE_WARMING_DISABLE_VAR]: '1' };
}

/** Writes the setting GLOBAL (mirrors flockEnabled.ts); the error, or undefined. */
export async function setCacheWarmingEnabled(enabled: boolean): Promise<string | undefined> {
  try {
    await vscode.workspace
      .getConfiguration(CACHE_WARMING_SECTION)
      .update(CACHE_WARMING_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}
