// subagentLimitPane.ts — the two messages behind the Insights pane's sub-agent
// time-limit control: read the setting, write the setting.
//
// Its own module rather than two more cases in DashboardPanel.ts, on the
// precedent remotePane.ts set: a pane that reads SETTINGS and never the engine
// needs nothing from the panel but `post`, so the panel spends one routing line
// on it instead of a handler it would then own.
//
// The value is read by the engine at SPAWN (subagentLimit.ts), so a write here
// changes nothing until the window reloads. The reply says so rather than
// leaving the pane to claim an effect it cannot deliver.

import {
  SUBAGENT_LIMIT_DEFAULT_HOURS,
  SUBAGENT_LIMIT_MIN_HOURS,
  setSubagentLimitHours,
  subagentLimitHours,
} from '../subagentLimit';

// The READ takes the house `request*` prefix (requestSubagentTranscript,
// requestRunSteps): Origami Remote's allowlist treats that prefix as a read a
// phone may make. The WRITE is refused by name there — see remoteVerbsTable.ts.
export const SUBAGENT_LIMIT_MESSAGE_TYPES = new Set(['requestSubagentLimit', 'subagentLimitSet']);

export interface SubagentLimitHost {
  post(message: Record<string, unknown>): void;
}

/** The pane's state: the stored value, or the default when nothing is stored.
 *  The bounds ride along so the input's `min` and the pane's help text cannot
 *  drift from what `subagentMaxMs` will actually accept. */
function state(error?: string): Record<string, unknown> {
  return {
    type: 'subagentLimitData',
    hours: subagentLimitHours() ?? SUBAGENT_LIMIT_DEFAULT_HOURS,
    stored: subagentLimitHours() !== undefined,
    min: SUBAGENT_LIMIT_MIN_HOURS,
    default: SUBAGENT_LIMIT_DEFAULT_HOURS,
    ...(error ? { error } : {}),
  };
}

export async function handleSubagentLimitMessage(
  host: SubagentLimitHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'requestSubagentLimit') {
    host.post(state());
    return;
  }
  if (m.type !== 'subagentLimitSet') return;
  const hours = typeof m['hours'] === 'number' ? m['hours'] : Number.NaN;
  // Refused here as well as in the input's `min`: a webview is not a trusted
  // validator, and a stored value under the minimum is one `subagentMaxMs`
  // silently discards — the setting would read as set and do nothing.
  if (!Number.isFinite(hours) || hours < SUBAGENT_LIMIT_MIN_HOURS) {
    host.post(state(`A sub-agent limit must be at least ${SUBAGENT_LIMIT_MIN_HOURS} hours.`));
    return;
  }
  host.post(state(await setSubagentLimitHours(hours)));
}
