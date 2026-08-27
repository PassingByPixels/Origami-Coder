// What this WINDOW is called to the other agent sessions on this machine
// (t-kgu05m). Its own module rather than more engineEnv.ts: that file is the
// experimental-TOGGLE overlay, mirrored key-for-key against the engine's
// runtime-flags.ts, and this is an identity string read somewhere else
// entirely — engine src/origami/agent-broker.ts. Folding the two together
// would have put a value with a different reader, a different guard and a
// different lifetime behind the same "flags" contract.

import * as vscode from 'vscode';

/** The `origami.*` setting id the user sets, per workspace. */
export const AGENT_NAME_SETTING = 'agentName';

/**
 * The env var the engine's broker reads the name from.
 *
 * An env var rather than an origami.json key because the value has to be PER
 * WINDOW: a global origami.json is shared by every window on the machine and a
 * project one by every window on the same repo, so a name set in either would
 * make the peers indistinguishable — the one thing discovery cannot tolerate.
 * The spawn env is already the per-window channel, so this needs no
 * config-schema change at all.
 *
 * A drift guard in engineEnv.test.ts reads the broker file: renamed there and
 * unguarded here, every window would quietly fall back to basename(cwd) and the
 * setting would do nothing, with the whole suite still green.
 */
export const AGENT_NAME_VAR = 'ORIGAMI_AGENT_NAME';

/**
 * The env var that says whether a HUMAN can see this engine's transcript.
 *
 * The engine cannot answer that itself: it reads ORIGAMI_CLIENT='acp' and
 * concludes somebody is watching, but this shell spawns one engine per LOCAL
 * SESSION, so 'acp' is as true of an Agent Manager run or a headless loop as of
 * a chat tab. Only the panel knows which sessions have a chat. One that has
 * none declares itself background and falls under the opt-in gate that already
 * keeps unwatched engines out of discovery. Drift-guarded with AGENT_NAME_VAR.
 */
export const AGENT_KIND_VAR = 'ORIGAMI_AGENT_KIND';
/** What a session with no chat of its own declares itself to be. */
export const BACKGROUND_KIND = 'background';

/** The setting, read at spawn. Blank (or no settings store) writes nothing and
 *  leaves the engine's basename(cwd) fallback in charge — which is a better
 *  default than publishing a nameless agent. */
export function agentNameSetting(): string {
  try {
    const value = vscode.workspace.getConfiguration('origami').get<string>(AGENT_NAME_SETTING);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}
