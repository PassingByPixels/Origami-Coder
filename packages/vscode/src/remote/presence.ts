// Origami Remote — IS ANYONE LISTENING, and WHAT DO WE SAY WHEN THE PHONE HAS
// FORGOTTEN ITSELF.
//
// PRESENCE. The relay sends a TEXT control frame to the other role when a
// socket opens or closes ("peer:present" / "peer:absent"). Clients never send
// text — the relay closes 4004 — so a relay->client text frame is unambiguous,
// and it carries no rid and no payload. A desktop told "absent" stops posting
// the fan-out into a socket the relay can only drop.
//
// UNKNOWN IS NOT ABSENT: a relay that predates the control frame says nothing,
// so the state starts UNKNOWN and only an explicit "absent" pauses anything.
// RE-PAIRING: a phone that lost its seq marks starts at 1, so its hello is
// rejected as a replay. The guard stays; the desktop answers once per socket
// with its own hello carrying `reset: true` and says so on the pane.

export const PEER_PRESENT = 'peer:present';
export const PEER_ABSENT = 'peer:absent';

/** What the pane prints when a phone cannot get past the replay guard. It is
 *  the controller's status line, which the pane renders verbatim. */
export const NEEDS_REPAIRING = 'remote: phone needs re-pairing — show a new code and scan it again';

/** The same replay refusal on a pairing NO phone has confirmed yet: an
 *  impersonator that connects FIRST advances the inbound mark, so the real
 *  phone's seq-1 hello is refused. Only a NEW pairing recovers it. */
export const PAIRING_WEDGED =
  'remote: this pairing cannot be completed; make a new QR';

/** ...and when a `peer:present` threw a verified socket's verdict away. */
export const PEER_REPLACED = "remote: the phone's socket was replaced; waiting for it to prove its key";

export type Presence = 'unknown' | 'present' | 'absent';

/** What a control frame MEANT. See `PeerState.note`. */
export type PeerEdge = 'arrived' | 'replaced' | null;

/** A relay control frame, or null for anything else on the text channel. */
export function readPresence(text: string): Presence | null {
  if (text === PEER_PRESENT) return 'present';
  if (text === PEER_ABSENT) return 'absent';
  return null;
}

/** True when `msg` is the phone's hello. Used ONLY to describe a dropped frame. */
export function isHello(msg: unknown): boolean {
  return (msg as { type?: unknown } | null)?.type === 'remote/hello';
}

/** The peer's presence on one pairing, plus the re-pair notice latch. */
export class PeerState {
  private state: Presence = 'unknown';
  private announced = false;

  /** Nothing is sent while the relay says the phone is gone. Unknown sends. */
  public get paused(): boolean {
    return this.state === 'absent';
  }

  public get presence(): Presence {
    return this.state;
  }

  /** Apply a control frame, and say which EDGE it is.
   *
   *  `arrived` is a transition into present: the phone missed whatever was held
   *  back, so the desktop greets and hydrates it.
   *
   *  `replaced` is a `peer:present` while the relay had ALREADY said present. The
   *  frame never says WHOSE socket attached, so it is either a duplicate for the
   *  same phone or a different client — reported separately because a replacement
   *  must prove the device key again, while re-hydrating on every duplicate would
   *  push a whole transcript up the relay. */
  public note(text: string): PeerEdge {
    const next = readPresence(text);
    if (next === null) return null;
    const was = this.state;
    this.state = next;
    if (next !== 'present') return null;
    // A phone that comes back may have re-loaded, so the hello latch opens with it.
    this.announced = false;
    return was === 'present' ? 'replaced' : 'arrived';
  }

  /** A fresh socket: presence is stated again and the re-pair notice re-armed. */
  public reset(): void {
    this.state = 'unknown';
    this.announced = false;
  }

  /** True the FIRST time a replayed hello is seen on this socket — the phone
   *  re-sends its hello on every reconnect, so an unlatched answer is a storm. */
  public claimRepairNotice(): boolean {
    if (this.announced) return false;
    this.announced = true;
    return true;
  }
}
