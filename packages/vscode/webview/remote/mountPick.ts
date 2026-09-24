// WHICH CHAT THE PHONE OPENS ON.
//
// The phone runs the chat bundle in SOLO mode: `ChatView.svelte` reads
// `__ORIGAMI_SOLO_SESSION__` once, in onMount, and renders that one session's
// ChatPane. So the shell has exactly one chance to name the right chat, and it
// has to name it from the hydration burst alone.
//
// The burst is `DashboardPanel.replaySessionsTo`, and its ORDER is the whole
// reason this file exists. It walks `this.sessions.values()` — Map insertion
// order, i.e. oldest chat first — posting `sessionCreated` (+ `restoreMessages`
// + `contextUpdate` + the selector seeds) for EVERY open chat, and only at the
// very end posts `restoreActiveSession` naming the one the window is actually
// on. Mounting on the FIRST `sessionCreated` therefore pinned the phone to the
// oldest chat in the window: with two chats open the owner got an empty-state
// crane and a rotating tip while the chat he was watching on the desktop was
// filtered out of `visibleCells` and never appeared.
//
// So: prefer the session the host calls ACTIVE, and fall back to the first one
// announced only when no `restoreActiveSession` follows. The fallback is not
// dead code — a window whose first chat is created live (`sessionCreated` with
// no replay behind it) never sends one.

type Announcement = { type?: unknown; sessionId?: unknown };

function idOf(msg: unknown, type: string): string | undefined {
  const m = msg as Announcement | null;
  if (!m || typeof m !== 'object' || m.type !== type) return undefined;
  return typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : undefined;
}

/** What a hydration burst has said about which chats exist and which is live. */
export class SessionPick {
  private readonly announced: string[] = [];
  private active: string | null = null;

  /** Feed every inbound message. Only two types carry a verdict. */
  public note(msg: unknown): void {
    const created = idOf(msg, 'sessionCreated');
    if (created && !this.announced.includes(created)) this.announced.push(created);
    const active = idOf(msg, 'restoreActiveSession');
    if (active) this.active = active;
  }

  /** The host's OWN active chat, once it has also been announced. Undefined
   *  until both facts have arrived — pinning an id with no `sessionCreated`
   *  behind it would mount a ChatPane over a session it has no row for. */
  public get chosen(): string | undefined {
    return this.active !== null && this.announced.includes(this.active) ? this.active : undefined;
  }

  /** The oldest announced chat: what to open on when the burst names no
   *  active session at all. */
  public get fallback(): string | undefined {
    return this.announced[0];
  }

  /** Every chat the phone has heard of, oldest first. The session switcher
   *  reads this, so it lists what the window holds rather than what the phone
   *  happens to have mounted. */
  public get all(): readonly string[] {
    return this.announced;
  }
}
