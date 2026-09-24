// Nests (t-s9jr6u) — the one place `origamicoder.nests.enabled` is read and
// written. Default OFF: the relay exception in the features-on-by-default
// rule, because turning it on dials a relay and names this desk to it.
import * as vscode from 'vscode';

export const NESTS_SECTION = 'origamicoder.nests';

/** Only an exact `true` is on. */
export function readNestsEnabled(): boolean {
  return vscode.workspace.getConfiguration(NESTS_SECTION).get<boolean>('enabled', false) === true;
}

/** Written GLOBAL, like remote.enabled: the group is the user's, not a folder's.
 *  The config watcher in activate.ts then constructs or disposes the group. */
export async function writeNestsEnabled(on: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(NESTS_SECTION).update('enabled', on, vscode.ConfigurationTarget.Global);
}

/** The relay Nests shares with Remote. Changed in Remote › Relay. */
export function nestsRelayUrl(): string {
  return vscode.workspace.getConfiguration('origamicoder.remote').get<string>('relayUrl', 'wss://relay.origamilabs.nl');
}
