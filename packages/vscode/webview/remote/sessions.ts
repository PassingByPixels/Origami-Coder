// WHAT CHATS THE PHONE KNOWS ABOUT.
//
// The list half of the chat strip — `sessionBar.ts` draws it, this file says
// what there is to draw. It is built ENTIRELY from messages the phone already
// receives; the strip adds nothing to the wire, and the reasons for that are
// in sessionBar.ts's header.
//
// Four types carry a verdict here, and the last of them is a RULE rather than
// a fact. `sessionCreated` adds a row (`replaySessionsTo` re-announces every
// open chat on each hydration, so adding one must be idempotent).
// `sessionTitle` renames one — the engine reports a chat's title on its first
// turn, after the chat was announced. `restoreActiveSession` names the chat
// the window is on. And `sessionClosed` removes one WITHOUT naming a
// successor: `DashboardPanel.closeSession` repairs its own `activeSessionId`
// with `liveActiveSessionId` and posts nothing after the broadcast, so every
// view picks the successor itself. `newest` is this view's copy of that rule.

export interface SessionRow {
  id: string;
  number: number;
  label: string;
}

/** The chat list, built from the messages the phone already receives. */
export class SessionList {
  private readonly rows = new Map<string, SessionRow>();
  private active: string | null = null;

  /** Returns true when the strip needs repainting. */
  public note(msg: unknown): boolean {
    const m = msg as { type?: unknown; sessionId?: unknown; sessionNumber?: unknown; agentName?: unknown; title?: unknown } | null;
    if (!m || typeof m !== 'object') return false;
    const id = typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : '';
    if (!id) return false;
    if (m.type === 'sessionCreated') {
      this.rows.set(id, {
        id,
        number: typeof m.sessionNumber === 'number' ? m.sessionNumber : this.rows.size + 1,
        label: label(m.title, m.agentName),
      });
      return true;
    }
    // A chat is named after it is announced (the engine reports the title on
    // the first turn), and a strip that never took the update would show
    // "Agent" beside three identical chips.
    if (m.type === 'sessionTitle') {
      const row = this.rows.get(id);
      if (!row) return false;
      row.label = label(m.title, undefined) || row.label;
      return true;
    }
    if (m.type === 'restoreActiveSession') {
      if (this.active === id) return false;
      this.active = id;
      return true;
    }
    // A chat closed — from this phone, from the desktop, or by a failed engine
    // start. The row goes, and if it was the one we were reading, the active id
    // moves the way the desktop moves it (see `newest`).
    if (m.type === 'sessionClosed') {
      if (!this.rows.delete(id)) return false;
      if (this.active === id) this.active = this.newest;
      return true;
    }
    return false;
  }

  /** The newest chat still open, or null. The desktop's rule after a close,
   *  mirrored: `liveActiveSessionId` takes the LAST key of the session map and
   *  `ChatPane` takes `sessions[sessions.length - 1]` — both mean the most
   *  recently created survivor, which is the highest session number here. */
  private get newest(): string | null {
    const rows = this.all;
    return rows.length > 0 ? rows[rows.length - 1]!.id : null;
  }

  public select(id: string): void {
    this.active = id;
  }

  public get all(): SessionRow[] {
    return [...this.rows.values()].sort((a, b) => a.number - b.number);
  }

  public get activeId(): string | null {
    return this.active;
  }

  public has(id: string): boolean {
    return this.rows.has(id);
  }
}

function label(title: unknown, agentName: unknown): string {
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (typeof agentName === 'string' && agentName.trim()) return agentName.trim();
  return '';
}
