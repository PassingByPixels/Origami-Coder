// liveness.ts — the liveness row a Claude (subscription) chat's status line reads (t-xu5oty).
//
// A chat's status line (DashboardPanel.sessionModelStatus) reads a remote provider's liveness from
// providerStatusCache. broadcastProviderStatus fills that cache by probing each origami.json block,
// but it skips the `claude-subscription` block on purpose: the connection draws its own tile
// (t-ty02bb). So nothing ever wrote a row for it, and a chat on it said "Checking provider…"
// forever. Its liveness is the engine's own Gate B answer (engineStatus.ts), read with the same
// bound every provider probe gets. No credential is read on this path.

import { readinessFixLine, type ClaudeSubscriptionReadiness } from './readiness';

/** What the status line names this connection: the picker's words (models.ts). */
export const CLAUDE_SUBSCRIPTION_LABEL = 'Claude (Sub)';

/** The reason when the status read does not settle inside the bound, or fails. */
export const NO_ANSWER = 'Claude (subscription) did not answer its status check. Press Refresh in Connections.';

/** Ask once, never longer than `timeoutMs`. No answer in time, or a throw, is `unready` with
 *  NO_ANSWER: never a wait with no end, never a guess of `ready`. */
export async function boundedReadiness(
  read: () => Promise<ClaudeSubscriptionReadiness>,
  timeoutMs: number,
): Promise<ClaudeSubscriptionReadiness> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      read(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return answer ?? { state: 'unready', reason: NO_ANSWER };
  } catch {
    return { state: 'unready', reason: NO_ANSWER };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The providerStatusCache row: ready = live; any other state = not live, with its fix line. */
export function livenessOf(readiness: ClaudeSubscriptionReadiness, at: number): { live: boolean; reason?: string; at: number } {
  if (readiness.state === 'ready') return { live: true, at };
  return { live: false, reason: readinessFixLine(readiness) || NO_ANSWER, at };
}
