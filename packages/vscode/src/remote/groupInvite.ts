// The invitation window and the join rendezvous link: the state one desk holds
// while it shows a key, or while it waits for the welcome after a paste.
// Extracted from groupController.ts (t-sfyata), which sat at its cap when the
// roster gossip needed room there.

import type { GroupLink } from './groupLink';
import type { TransportDeps } from './transport';

/** How long an invitation stands. Long, because a key is pasted into a chat
 *  window and read on the other machine minutes later — unlike the phone's QR,
 *  which is on screen while somebody points a camera at it. */
export const GROUP_INVITE_WINDOW_MS = 600_000;

export class GroupInvite {
  public link: GroupLink | null = null;
  public key: string | null = null;
  public expiresAt: number | null = null;
  private timer: unknown = null;

  /** `onExpire` runs when the WINDOW closes the invite, not on a close() call. */
  constructor(private readonly deps: TransportDeps, private readonly onExpire?: () => void) {}

  /** Hold `link` (already started). The window closes itself on BOTH sides
   *  (t-sj32zl): an inviter with a key, a joiner waiting with none. */
  public open(link: GroupLink, key: string | null, now: number): void {
    this.close();
    this.link = link;
    this.key = key;
    this.expiresAt = now + GROUP_INVITE_WINDOW_MS;
    this.timer = this.deps.setTimer(() => {
      this.close();
      this.onExpire?.();
    }, GROUP_INVITE_WINDOW_MS);
  }

  public close(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.link?.stop('invitation closed');
    this.link = null;
    this.key = null;
    this.expiresAt = null;
  }
}
