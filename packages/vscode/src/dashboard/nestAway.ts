// nestAway.ts — t-t7lfho: the chats this desk gave to another desk.
//
//   set    a release landed (nestHub.onPeer, right after nest_release): the
//          chat, the desk that took it, the time it took it (its clock).
//   clear  this desk took the chat back (nestHub.continueHere, "taken").
//
// The hub posts the list in every origami/nestIndex as `away`. A pane of one of
// these chats shows "Continued on <desk>" with View and Take back here in place
// of the composer (NestReadOnlyGate.svelte), and its transcript shows the same
// block (NestAwayBlock.svelte). The list is in globalState, so a window reload,
// or a chat opened later from History, still shows it.

export interface NestAwayRow {
  id: string;
  /** Device id of the desk that took the chat. The webview shows its roster name. */
  desk: string;
  /** When that desk took it, ms. */
  at: number;
}

export interface NestAwayStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export const NEST_AWAY_KEY = 'origami.nests.away';
/** The oldest records go first past this: one per chat, so it only bounds a long life. */
export const NEST_AWAY_MAX = 200;

function valid(r: unknown): r is NestAwayRow {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o['id'] === 'string' && !!o['id'] && typeof o['desk'] === 'string' && !!o['desk'] && typeof o['at'] === 'number';
}

export class NestAway {
  private store: NestAwayStore | null = null;
  private rows = new Map<string, NestAwayRow>();

  /** globalState at activation. Records made before it (none, in practice) are kept. */
  public attach(store: NestAwayStore | null): void {
    this.store = store;
    const stored = store?.get<unknown[]>(NEST_AWAY_KEY, []) ?? [];
    const now = this.rows;
    this.rows = new Map((Array.isArray(stored) ? stored : []).filter(valid).map((r) => [r.id, { id: r.id, desk: r.desk, at: r.at }]));
    for (const r of now.values()) this.rows.set(r.id, r);
  }

  public list(): NestAwayRow[] {
    return [...this.rows.values()];
  }

  public set(id: string, desk: string, at: number): void {
    this.rows.delete(id);
    this.rows.set(id, { id, desk, at });
    for (const old of this.rows.keys()) {
      if (this.rows.size <= NEST_AWAY_MAX) break;
      this.rows.delete(old);
    }
    this.save();
  }

  public clear(id: string): void {
    if (this.rows.delete(id)) this.save();
  }

  private save(): void {
    void this.store?.update(NEST_AWAY_KEY, this.list());
  }
}
