// subagentLimit.ts — the SUB-AGENT time limit as this shell sees it: one
// setting, its bounds, and the number the engine wants.
//
// EXTRACTED from engineEnv.ts, which was AT its 75-line cap when this landed.
// The split is the one flockEnabled.ts already made for Flock's kill switch:
// engineEnv.ts owns the TABLE of variable names and the one spawn overlay that
// assembles them; a feature that has its own setting, its own bounds and its
// own unit conversion owns those itself. The variable NAME stays in
// ENGINE_FLAGS, so the drift guard that reads the engine's runtime-flags.ts
// keeps covering it with no second mechanism.
//
// Everything here is read at SPAWN, once. A change mid-session does nothing
// until the window reloads — which is what the setting description has to say.
import * as vscode from 'vscode';

/** The `origami.*` setting id the Insights pane writes and this module reads. */
export const SUBAGENT_LIMIT_SETTING = 'subagentTimeLimitHours';

/** Hours, when nothing usable is set. The ENGINE's own default for a missing
 *  variable is the same four hours (tool/task.ts); this side states it too so
 *  the pane can show a number instead of a blank. */
export const SUBAGENT_LIMIT_DEFAULT_HOURS = 4;

/** The shortest cap worth setting. Below this the limit is a foot-gun: a
 *  sub-agent that is genuinely working gets killed mid-edit. */
export const SUBAGENT_LIMIT_MIN_HOURS = 0.5;

const MS_PER_HOUR = 3_600_000;

/**
 * The env value for a limit in HOURS, or undefined for "write nothing".
 *
 * ROUNDED TO A WHOLE MILLISECOND on purpose. The engine reads this with
 * `positiveInteger` (effect/runtime-flags.ts): a non-integer is not clamped, it
 * is DISCARDED, and the flag falls back to four hours. `2.5` hours happens to
 * be a whole number of ms, but nothing guarantees the next value a user types
 * is — and that failure would look exactly like the setting doing nothing.
 *
 * A value below the minimum writes NOTHING rather than being clamped up:
 * silently running a different cap from the one in settings.json is worse than
 * running the engine's own default.
 */
export function subagentMaxMs(hours: number | undefined): string | undefined {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < SUBAGENT_LIMIT_MIN_HOURS) return undefined;
  return String(Math.round(hours * MS_PER_HOUR));
}

/** The setting's value in hours, or undefined when nothing usable is stored. A
 *  host with no settings store reads as unset, like every other reader here. */
export function subagentLimitHours(): number | undefined {
  try {
    const raw = vscode.workspace.getConfiguration('origami').get<number>(SUBAGENT_LIMIT_SETTING);
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= SUBAGENT_LIMIT_MIN_HOURS ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Write the setting GLOBAL (mirrors flockEnabled.ts's `setFlockEnabled`); the
 *  error, or undefined. */
export async function setSubagentLimitHours(hours: number): Promise<string | undefined> {
  try {
    await vscode.workspace
      .getConfiguration('origami')
      .update(SUBAGENT_LIMIT_SETTING, hours, vscode.ConfigurationTarget.Global);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}
