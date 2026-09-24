// What the VS Code shell adds to the engine child's environment at spawn.
//
// The env is read ONCE, by the child, at startup, so every value here is a
// restart-scoped choice and a setting changed mid-session does nothing until the
// window reloads. The flag names MIRROR the engine's own runtime-flags.ts across a
// process boundary, so they live in one table with a drift-guard test on both files.

import * as vscode from 'vscode';
// Neither the peer-discovery NAME nor the Flock kill switch is a runtime flag: each owns its own module, and only its overlay is wanted here.
import { AGENT_KIND_VAR, AGENT_NAME_VAR, BACKGROUND_KIND } from './peerName';
import { flockSpawnEnv } from './flockEnabled';
import { subagentMaxMs } from './subagentLimit'; // its own setting, bounds and unit conversion — subagentLimit.ts
import { SIDE_QUESTS_FLAG, sideQuestsSpawnEnv } from './sideQuestsFlag';
import { cacheWarmingSpawnEnv } from './cacheWarming'; // own setting + overlay - cacheWarming.ts // own setting + overlay — sideQuestsFlag.ts
import { CLAUDE_SUBSCRIPTION_FLAG, claudeSubscriptionSpawnEnv } from './claudeSubscriptionFlag'; // own setting + overlay — claudeSubscriptionFlag.ts

/** The `origami.*` setting id the Tools pane writes and this module reads. */
export const CODE_MODE_SETTING = 'experimentalCodeMode';
/** Engine flags this shell can set. Keys are the env var names the engine reads. */
export const ENGINE_FLAGS = {
  backgroundSubagents: 'ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS',
  codeMode: 'ORIGAMI_EXPERIMENTAL_CODE_MODE',
  // Wall-clock ceiling on ONE sub-agent. NOT spelled ORIGAMI_EXPERIMENTAL_*: the
  // neighbouring ORIGAMI_EXPERIMENTAL_BACKGROUND_JOB_MAX_MS caps a background
  // SHELL job, and the two must not read as variants of each other.
  subagentMaxMs: 'ORIGAMI_SUBAGENT_MAX_MS', // bounds + conversion: subagentLimit.ts
  sideQuests: SIDE_QUESTS_FLAG, // setting + overlay: sideQuestsFlag.ts
  claudeSubscription: CLAUDE_SUBSCRIPTION_FLAG, // setting + overlay: claudeSubscriptionFlag.ts (t-tjt9wd)
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
  /** `origami.subagentTimeLimitHours` — bounds and conversion: subagentLimit.ts. */
  subagentLimitHours?: number;
}

/** The env overlay for one spawn.
 *
 *  Background subagents are unconditional for this shell (the CLI default stays
 *  off). Code mode is the user's call and defaults to OFF; it is written only when
 *  enabled, because the engine treats the var as tri-state and writing 'false'
 *  would override an ORIGAMI_EXPERIMENTAL=true set deliberately outside VS Code. */
export function engineSpawnEnv(settings: EngineEnvSettings): Record<string, string> {
  // Undefined = write NOTHING, so the engine's own default stands.
  const subagentMs = subagentMaxMs(settings.subagentLimitHours);
  return {
    [ENGINE_FLAGS.backgroundSubagents]: 'true',
    ...(settings.codeMode ? { [ENGINE_FLAGS.codeMode]: 'true' } : {}),
    ...(settings.agentName?.trim() ? { [AGENT_NAME_VAR]: settings.agentName.trim() } : {}),
    // Only the headless case is written. A chat session says nothing and lets the
    // engine's own ORIGAMI_CLIENT reading stand.
    ...(settings.headless ? { [AGENT_KIND_VAR]: BACKGROUND_KIND } : {}),
    ...(subagentMs ? { [ENGINE_FLAGS.subagentMaxMs]: subagentMs } : {}),
    ...flockSpawnEnv(), // ORIGAMI_DISABLE_FLOCK=1 only while origamicoder.flock.enabled is off
    ...cacheWarmingSpawnEnv(), // ORIGAMI_DISABLE_CACHE_WARM=1 only while origamicoder.cacheWarming.enabled is off - the engine's own default is ON (t-ntmmvh)
    ...sideQuestsSpawnEnv(), // ORIGAMI_EXPERIMENTAL_SIDE_QUESTS=false only while the setting is OFF — the engine's own default is ON (t-ffjau8)
    ...claudeSubscriptionSpawnEnv(), // ENGINE_FLAGS.claudeSubscription=true only while the setting is ON — the engine's own default is OFF (t-tijdof, registered t-tjt9wd)
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
