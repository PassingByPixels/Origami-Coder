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

/** Is warming on? DEFAULT TRUE, and only an explicit `false` turns it off — a
 *  host with no settings store and an older settings.json with no such key both
 *  read as ON, because the engine defaults the same way and the two halves must
 *  not disagree. */
export function cacheWarmingEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(CACHE_WARMING_SECTION).get<boolean>(CACHE_WARMING_ENABLED_KEY) !== false;
  } catch {
    return true;
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
