// flockEnabled.ts — the ONE place this shell decides whether Flock is on.
// Three surfaces read the same answer and must never disagree:
//  - the ENGINE SPAWN. Off writes `ORIGAMI_DISABLE_FLOCK=1` into the child's env:
//    no relay socket, no owner lease, no question from a contact.
//  - the BOARD. Off drops the sidebar's Front Desk section; the rail row stays,
//    because that is where the switch lives.
//  - the setting's own default, which is FALSE — Flock opens a relay connection and
//    takes an owner lease.
// The env var name is a MIRROR across a process boundary, guarded by a test that
// reads the engine's own file. The value is read at SPAWN, once, so a change
// mid-session does nothing until a window reload.
import * as vscode from 'vscode';

/** The setting, in the two halves `getConfiguration` wants. */
export const FLOCK_SECTION = 'origamicoder.flock';
export const FLOCK_ENABLED_KEY = 'enabled';
/** The whole id, for a message that has to name it to the owner. */
export const FLOCK_ENABLED_SETTING = `${FLOCK_SECTION}.${FLOCK_ENABLED_KEY}`;

/** The engine's kill switch. Mirrors `FlockService.DISABLE_ENV`. */
export const FLOCK_DISABLE_VAR = 'ORIGAMI_DISABLE_FLOCK';

/** Is Flock on? DEFAULT FALSE, and an exact `true` is the only thing that turns it
 *  on: a host with no settings store, an older settings.json with no such key and a
 *  value of some other type all read as OFF — a feature that opens a relay
 *  connection and takes a lease must never enable itself. */
export function flockEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(FLOCK_SECTION).get<boolean>(FLOCK_ENABLED_KEY) === true;
  } catch {
    return false;
  }
}

/** The env overlay one spawn adds for Flock: nothing at all while it is on. */
export function flockSpawnEnv(): Record<string, string> {
  return flockEnabled() ? {} : { [FLOCK_DISABLE_VAR]: '1' };
}

/** Writes the setting GLOBAL (mirrors remotePane.ts's `update`); the error, or undefined. */
export async function setFlockEnabled(enabled: boolean): Promise<string | undefined> {
  try {
    await vscode.workspace.getConfiguration(FLOCK_SECTION).update(FLOCK_ENABLED_KEY, enabled, vscode.ConfigurationTarget.Global);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}
