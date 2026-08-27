// What the VS Code shell adds to the engine child's environment at spawn.
//
// Extracted from acpClient.start() when the code-mode toggle landed: that call
// site was already at its line cap, and the decision is worth testing on its
// own anyway. The env is read ONCE, by the child, at startup — so every value
// here is a restart-scoped choice, and a setting changed mid-session does
// nothing until the window reloads. Callers say so in the setting description.
//
// The flag names are the engine's, from packages/engine/src/effect/
// runtime-flags.ts. They are a MIRROR across a process boundary, which is why
// they live in one exported table with a drift-guard test reading both files:
// a renamed flag would otherwise leave the toggle silently doing nothing.

import * as vscode from 'vscode';
// The peer-discovery NAME is not a flag — see peerName.ts for why it is its own
// module. Only its var name is needed here, to place it in the overlay.
import { AGENT_KIND_VAR, AGENT_NAME_VAR, BACKGROUND_KIND } from './peerName';

/** The `origami.*` setting id the Tools pane writes and this module reads. */
export const CODE_MODE_SETTING = 'experimentalCodeMode';

/** Engine flags this shell can set. Keys are the env var names the engine reads. */
export const ENGINE_FLAGS = {
  backgroundSubagents: 'ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
  codeMode: 'ORIGAMI_EXPERIMENTAL_CODE_MODE',
} as const;

export interface EngineEnvSettings {
  /** `origami.experimentalCodeMode` — the confined-JS `execute` tool instead of individual MCP tools. */
  codeMode: boolean;
  /** `origami.agentName` — what other agent sessions see this window called.
   *  Unset leaves the variable off entirely; the engine then falls back to
   *  basename(cwd), which is a better default than an empty name. */
  agentName?: string;
  /** This session runs with NO chat of its own (Agent Manager, a headless
   *  loop). Written so peer discovery can leave it out — see peerName.ts. */
  headless?: boolean;
}

/**
 * The env overlay for one spawn.
 *
 * Background subagents are unconditional for this shell: the model can fire
 * independent work and keep its turn moving, and the task_stop / task_list
 * control tools come with it. Scoped to the shell's engine — the CLI default
 * stays off.
 *
 * Code mode is the user's call and defaults to OFF. It is written only when
 * enabled: the engine treats the var as tri-state (unset means "follow
 * ORIGAMI_EXPERIMENTAL"), and writing 'false' would override an
 * ORIGAMI_EXPERIMENTAL=true the user set deliberately outside VS Code.
 */
export function engineSpawnEnv(settings: EngineEnvSettings): Record<string, string> {
  return {
    [ENGINE_FLAGS.backgroundSubagents]: 'true',
    ...(settings.codeMode ? { [ENGINE_FLAGS.codeMode]: 'true' } : {}),
    ...(settings.agentName?.trim() ? { [AGENT_NAME_VAR]: settings.agentName.trim() } : {}),
    // Only the headless case is written. A chat session says nothing and lets
    // the engine's own ORIGAMI_CLIENT reading stand, which keeps this to the
    // one claim the shell is actually better placed to make.
    ...(settings.headless ? { [AGENT_KIND_VAR]: BACKGROUND_KIND } : {}),
  };
}

/** The setting behind `codeMode`, read at spawn. A host with no settings store
 *  reads as off — the safe default this feature ships with. */
export function codeModeEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('origami').get<boolean>(CODE_MODE_SETTING) === true;
  } catch {
    return false;
  }
}
