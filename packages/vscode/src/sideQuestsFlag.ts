// The side-quests experimental flag. Read by the SHELL: the drawer, folder
// watcher and popup (via sideQuestsEnabled), and the engine's own
// `side_quest` tool (runtime-flags.ts experimentalSideQuests), which t-ffjau8
// made ON by default in BOTH halves. t-fdv45j gave this a real VS Code setting
// (origami.experimentalSideQuests); the env var is a dev override that wins
// whenever it is set at all. One name for both halves, spelled the engine's way.
import * as vscode from 'vscode';

/** The env var both halves are gated on. */
export const SIDE_QUESTS_FLAG = 'ORIGAMI_EXPERIMENTAL_SIDE_QUESTS';
/** The `origami.*` setting id a VS Code user can actually set. */
export const SIDE_QUESTS_SETTING = 'experimentalSideQuests';

/** t-ffjau8: ON unless the setting is an explicit `false` - which is what an
 *  absent setting and an unreadable settings store both mean too, because the
 *  engine defaults the same way and the two halves must not disagree. */
function settingOn(): boolean {
  try {
    return vscode.workspace.getConfiguration('origami').get<boolean>(SIDE_QUESTS_SETTING) !== false;
  } catch {
    return true;
  }
}

/** Is side quests on? ON is the default (t-ffjau8). The env var wins whenever
 *  set (dev override); otherwise this follows the setting, so the drawer picks
 *  up a change with no reload. `true`/`1` both count. */
export function sideQuestsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[SIDE_QUESTS_FLAG];
  if (raw !== undefined) return raw === 'true' || raw === '1';
  return settingOn();
}

/** Engine spawn overlay, inverted by t-ffjau8: the engine is ON by default, so
 *  only OFF is spoken aloud. Off the DRAWER's answer, env override included
 *  (t-fisfs5 R3): off the setting alone, a dev's `...=true` was overwritten. */
export function sideQuestsSpawnEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return sideQuestsEnabled(env) ? {} : { [SIDE_QUESTS_FLAG]: 'false' };
}
