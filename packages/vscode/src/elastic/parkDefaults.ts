// parkDefaults.ts — t-ze0hwh: the park defaults went from 60 min (timed) and 120 min (untimed) to 20 min.
// A user who never chose a value gets 20 from package.json. A user whose settings file holds the OLD default
// (the Settings › Engines pane writes the value it shows, so an old default can be stored without a choice)
// is moved to 20 ONCE, at every scope where that value is set. Any other stored value is the user's and
// stays. Once per install (globalState marker, the same pattern as the claude-subscription clean-up in
// firstFold.ts): after the pass, a stored 60 is a value the user chose again.

import * as vscode from 'vscode';
import { ELASTIC_SECTION } from './elasticWindow';

export const PARK_DEFAULTS_MARKER = 'origami.migrate.parkDefaults20.v1';
export const PARK_DEFAULT_MINUTES = 20;
/** Each park key and the default it had before t-ze0hwh. */
const OLD_DEFAULTS: ReadonlyArray<readonly [string, number]> = [['parkAfterMinutes', 60], ['parkUntimedAfterMinutes', 120]];

/** One place a setting value can be stored: the user settings, the workspace, or one workspace folder. */
export interface ParkScope {
  label: string;
  value(key: string): unknown;
  write(key: string, value: number): PromiseLike<void>;
}

export interface OnceMarker {
  get(): boolean | undefined;
  set(v: boolean): void;
}

/** Move each stored old default to 20. Never throws. The marker is set only when every write went through,
 *  so a failed write (a read-only settings file) is tried again on the next start. Returns the moves made,
 *  or null when the marker already says done. */
export async function migrateParkDefaults(marker: OnceMarker, scopes: ReadonlyArray<ParkScope>, log: (line: string) => void): Promise<string[] | null> {
  if (marker.get()) return null;
  const moved: string[] = [];
  let failed = false;
  for (const scope of scopes) {
    for (const [key, old] of OLD_DEFAULTS) {
      try {
        if (scope.value(key) !== old) continue;
        await scope.write(key, PARK_DEFAULT_MINUTES);
        moved.push(`${key} ${old} -> ${PARK_DEFAULT_MINUTES} (${scope.label})`);
      } catch (e) {
        failed = true;
        log(`park defaults: ${key} (${scope.label}) not moved: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (moved.length > 0) log(`park defaults (t-ze0hwh): ${moved.join(', ')}`);
  if (!failed) marker.set(true);
  return moved;
}

type Stored = 'globalValue' | 'workspaceValue';

/** The scopes VS Code holds: user settings and the workspace. Not a workspace folder: the park keys are
 *  window-scoped (no `scope` in package.json), so VS Code ignores a folder value for them, and an update to
 *  ConfigurationTarget.WorkspaceFolder throws ("window configuration to workspace folder", vscode.d.ts). */
export function vscodeParkScopes(): ParkScope[] {
  const scope = (label: string, cfg: vscode.WorkspaceConfiguration, field: Stored, target: vscode.ConfigurationTarget): ParkScope => ({
    label,
    value: (key) => cfg.inspect<number>(key)?.[field],
    write: (key, value) => cfg.update(key, value, target),
  });
  const root = vscode.workspace.getConfiguration(ELASTIC_SECTION);
  return [
    scope('user', root, 'globalValue', vscode.ConfigurationTarget.Global),
    scope('workspace', root, 'workspaceValue', vscode.ConfigurationTarget.Workspace),
  ];
}
