// Origami Remote — HOW MANY TIMES ONE SOCKET IS HYDRATED.
//
// A hydration is the most expensive thing the desktop says, and three arrived
// per socket (announce, the hello, the `remote/snapshot`). The rule is one
// hydration per SOCKET GENERATION, and the generation moves on only for a new
// socket (`transport` reports `connecting`) or a real return — an `absent` then
// a `present` at least PRESENCE_FLAP_MS apart.
// A FLAP IS NOT A RECONNECT: a backgrounded tab still holds every row and the
// relay ring replays what it missed. But a page RELOAD looks identical from
// here, and only the phone knows — so a flap suppresses the presence edge's
// hydration while an explicit `remote/snapshot` on that flap is served once.

/** How long a phone must be gone for its return to count as a reconnect. */
export const PRESENCE_FLAP_MS = 3_000;

export class HydrateGate {
  private open = false;
  /** When the relay last said the phone was gone, or null if it is not. */
  private absentAt: number | null = null;
  /** A return the flap window suppressed, still owed an answer if it asks. */
  private flapped = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly flapMs: number = PRESENCE_FLAP_MS,
  ) {}

  /** A new socket. Whatever was hydrated on the last one does not count. */
  public socket(): void {
    this.open = true;
    this.absentAt = null;
    this.flapped = false;
  }

  /** `peer:absent` — start the flap clock. */
  public absent(): void {
    this.absentAt = this.now();
  }

  /** `peer:present`. True when this is a real reconnect and the generation moved
   *  on; false for a flap, and false for the first `present` of a socket. */
  public arrived(): boolean {
    const at = this.absentAt;
    this.absentAt = null;
    if (at === null) return false;
    if (this.now() - at < this.flapMs) {
      this.flapped = true;
      return false;
    }
    this.open = true;
    return true;
  }

  /** The phone ASKED (`remote/snapshot`). Served only when the flap window just
   *  refused it one; on any other socket it stays a no-op. */
  public asked(): void {
    if (!this.flapped) return;
    this.flapped = false;
    this.open = true;
  }

  /** True at most once per generation. */
  public take(): boolean {
    const was = this.open;
    this.open = false;
    // A hydration WAS served, so a return the flap window refused owes nothing:
    // otherwise the pairing burst hydrated the keyless page twice after all.
    if (was) this.flapped = false;
    return was;
  }

  /** Diagnostics and tests — never a decision. */
  public get armed(): boolean {
    return this.open;
  }

  /** The pairing went away. Nothing is owed to a socket that no longer exists. */
  public reset(): void {
    this.open = false;
    this.absentAt = null;
    this.flapped = false;
  }
}
