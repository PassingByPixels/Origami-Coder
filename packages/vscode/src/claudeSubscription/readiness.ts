// readiness.ts — the ONE shape the "Claude (subscription, experimental)"
// picker group renders from (t-tijdof acceptance: "Readiness states in the
// UI: CLI missing / not logged in / version too old, each with the fix in one
// line").
//
// t-tjt9wd: the engine's own Gate B (provider/claude-subscription.ts `probe`,
// read through native-runtime.ts statusWithFetch) is now the source, reached
// through one host call (`claudeSubscription/engineStatus.ts`,
// `claude_subscription_status` ext method) that answers all four states,
// including `not-logged-in`. `readinessFromCli` below is kept ONLY as the
// fallback for when no engine session is running yet to ask (DashboardPanel
// has no active session) — it derives what this extension can see locally
// from the passthrough's own CLI discovery, and still cannot answer
// `not-logged-in` for the same reason as before: no local `claude auth
// status` probe.
import { meetsFloor } from '../claudeCode/discovery';

export type ClaudeSubscriptionReadiness =
  // `path` (and `version` when ready): the binary the route uses (t-vd9s7z).
  // Absent from an older engine's reply.
  | { state: 'ready'; version?: string; path?: string }
  | { state: 'cli-missing' }
  | { state: 'not-logged-in' }
  | { state: 'version-too-old'; found: string; floor: string; path?: string }
  // A Gate B reason none of the four names (env conflicts, no version at
  // all) — carries the engine's own text verbatim rather than guessing.
  | { state: 'unready'; reason: string };

/** The version floor this route is qualified against. The Hermes-route study
 *  (claude_subscription_hermes_2026-09-23, section 1.3) needed 2.1.263 for the
 *  `shouldQuery:false` history-replay protocol the L1 transport design reuses;
 *  below it the wire is not proven to match. */
export const CLAUDE_SUBSCRIPTION_VERSION_FLOOR = '2.1.263';

/** The short status word for a readiness state — the Connections card's
 *  status line (t-tsw90t). One word each, ASD-STE100. */
export function readinessLabel(r: ClaudeSubscriptionReadiness): string {
  switch (r.state) {
    case 'ready':
      return 'Ready';
    case 'cli-missing':
      return 'CLI missing';
    case 'not-logged-in':
      return 'Not signed in';
    case 'version-too-old':
      return 'Version too old';
    case 'unready':
      return 'Not ready';
  }
}

/** One line telling the user how to fix a non-ready state. '' when ready —
 *  callers never show a fix line beside a ready row. */
export function readinessFixLine(r: ClaudeSubscriptionReadiness): string {
  switch (r.state) {
    case 'ready':
      return '';
    case 'cli-missing':
      return 'Claude Code CLI not found. Install it, then reopen this panel.';
    case 'not-logged-in':
      return 'Not logged in. Run "claude" in a terminal and sign in, then reopen this panel.';
    case 'version-too-old':
      return r.path
        ? `Claude Code ${r.found} at ${r.path} is older than ${r.floor}. ${updateStep(r.path)}, then reopen this panel.`
        : `Claude Code ${r.found} is older than ${r.floor}. Update it, then reopen this panel.`;
    case 'unready':
      return r.reason;
  }
}

/** How to update the binary at `path`. The VS Code Claude Code extension
 *  bundles its own copy, and `claude update` does not change that copy. */
function updateStep(path: string): string {
  return /anthropic\.claude-code-/i.test(path)
    ? 'Update the Claude Code extension in VS Code'
    : 'Run "claude update" in a terminal';
}

/** The card line that names the binary a READY route uses; '' otherwise (the
 *  version-too-old fix line names it already). */
export function readinessCliLine(r: ClaudeSubscriptionReadiness): string {
  if (r.state !== 'ready' || !r.path) return '';
  return `Uses Claude Code ${r.version ? `${r.version} ` : ''}at ${r.path}.`;
}

/** What this extension can tell locally from the passthrough's own CLI
 *  discovery result. Optimistic on sign-in (see file header): a present,
 *  floor-meeting CLI reads as `ready` here even though nobody checked that the
 *  user is signed in — the engine's own status replaces this once it exists. */
export function readinessFromCli(cli: { version?: string; binary?: string } | null | undefined): ClaudeSubscriptionReadiness {
  if (!cli) return { state: 'cli-missing' };
  const version = cli.version ?? '';
  const path = cli.binary ? { path: cli.binary } : {};
  if (version && !meetsFloor(version, CLAUDE_SUBSCRIPTION_VERSION_FLOOR)) {
    return { state: 'version-too-old', found: version, floor: CLAUDE_SUBSCRIPTION_VERSION_FLOOR, ...path };
  }
  return cli.binary ? { state: 'ready', version, path: cli.binary } : { state: 'ready' };
}
