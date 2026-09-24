// claudeSubscriptionFlag.ts — the experimental Claude-subscription route's
// opt-in setting, and the ENGINE_FLAGS env var it rides to the engine
// (t-tijdof). Default OFF: the engine family `claude-subscription` (built by
// t-tija5f) also defaults off, and the two halves must agree.
//
// Registered in engineEnv.ts's ENGINE_FLAGS table as `claudeSubscription`
// (t-tjt9wd), same as codeMode / sideQuests / subagentMaxMs: the engine half
// (t-tija5f) has landed in this checkout's packages/engine, so the drift-guard
// test (engineEnv.test.ts, "every name in ENGINE_FLAGS still exists in the
// engine's runtime-flags.ts") now has something to check it against. The
// overlay is still its own function here, spread into engineSpawnEnv by
// engineEnv.ts — the same tri-state shape sideQuestsFlag.ts and
// cacheWarming.ts use, so "off" writes nothing rather than an explicit false.
import * as vscode from 'vscode';

/** The `origami.*` setting id the settings UI, the disclosure and the picker
 *  wiring all use. */
export const CLAUDE_SUBSCRIPTION_SETTING = 'experimentalClaudeSubscription';

/** The full setting id, for code that has to name it to `getConfiguration`/`affectsConfiguration`. */
export const CLAUDE_SUBSCRIPTION_SETTING_ID = `origami.${CLAUDE_SUBSCRIPTION_SETTING}`;

/** The env var this shell writes when the setting is on. MUST match the name
 *  the engine's `claude-subscription` family reads (t-tija5f, native-route.ts)
 *  — stated in the t-tijdof report so the two lanes agree on the spelling. */
export const CLAUDE_SUBSCRIPTION_FLAG = 'ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION';

/** Is the setting on? A host with no settings store, or an absent key, both
 *  read as OFF — the safe default this experimental route ships with. */
export function claudeSubscriptionEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('origami').get<boolean>(CLAUDE_SUBSCRIPTION_SETTING) === true;
  } catch {
    return false;
  }
}

/** The env overlay one spawn adds: nothing while the setting is off, so an
 *  ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION=true set outside VS Code (a dev
 *  override) is never overwritten by a shell with nothing to say — the same
 *  tri-state rule codeMode's overlay follows. */
export function claudeSubscriptionSpawnEnv(): Record<string, string> {
  return claudeSubscriptionEnabled() ? { [CLAUDE_SUBSCRIPTION_FLAG]: 'true' } : {};
}
