// The mailbox read, and the one webview message shape both routes to the pane produce — split from
// flockMailbox.ts once it grew past its cap. Keeping the shape here stops the poll and the engine's
// push from spelling `flockMailbox` two ways.

import type { MailboxHost } from './flockMailbox';
import { flockRouteCandidates, getHolderPid, pickFlockClient } from './flockRoute';

/** One sentence for both files: the read prints it, the writes toast it. */
export const NO_SESSION = 'Open a chat first — your mailbox is read from a live engine connection.';

/** The mailbox, and the chats a row could be delivered into, as one post pair. */
export async function mailboxPayload(host: MailboxHost): Promise<Record<string, unknown>> {
  if (!host.client) return { type: 'flockMailbox', threads: [], error: NO_SESSION };
  // Routes off the CACHED holder pid — a mailbox poll must never itself call flock_state to learn
  // it — falling back to the active client when unset or not one of ours.
  const client = pickFlockClient(flockRouteCandidates(host), getHolderPid()) ?? host.client;
  try {
    const result = await client.extMethod('flock_mailbox', {});
    return { type: 'flockMailbox', threads: Array.isArray(result?.['threads']) ? result['threads'] : [] };
  } catch (e) {
    // An EMPTY mailbox with the reason, never the last one left on screen: a
    // row whose buttons no longer work is worse than no row, because the owner
    // would think they had answered somebody.
    return { type: 'flockMailbox', threads: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The pushed mailbox, as the webview message the poll already posts. The engine watches flock.json
 *  and pushes this when it moves, ending the thirty-second wait for a reply written by another
 *  window's engine. Kept beside the poll that produces the identical shape, so the two cannot
 *  drift.
 */
export function flockMailboxPush(input: { threads: unknown[] }): Record<string, unknown> {
  return { type: 'flockMailbox', threads: input.threads };
}
