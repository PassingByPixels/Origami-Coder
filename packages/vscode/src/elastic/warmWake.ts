// warmWake.ts — t-z6ytkw: a cache warm across a park. A chat parks at the user's Park-after time also while
// its engine has a cache warm armed (parkPolicy.ts). The engine hands the warm over in its `_elastic_park`
// answer (`warms: [{sessionId, dueAt}]`, engine elastic/park-warm.ts). This sets a timer; shortly before the
// warm is due it starts the chat's engine in the background (through its gate: the same restore a message
// starts; the chat stays hidden, so the tracker classes it background, never active), asks `_elastic_warm`
// (the engine sends the warm the live engine would have sent), and parks the chat again at once.
//
// One warm per handed-over schedule, as the live engine sends one per real request. Nothing is woken when
// the chat was closed, when the cache-warming setting is off at that time, or when the chat is no longer
// parked (someone uses it: its own engine arms its own warm). No vscode here.

/** Wake this long before the warm is due: a restore takes 1.4 s (binary) to 12 s (source, under load). */
export const WAKE_LEAD_MS = 60_000;

export interface WarmWakeChat {
  client: { readonly currentSessionId: string | null; extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> };
  gate: { readonly current: string; whenUp(): Promise<boolean> };
}

export interface WarmWakeDeps {
  /** The chat with this local id, or undefined once it is closed. */
  find(localId: string): WarmWakeChat | undefined;
  /** Park the chat again; null = parked, else why not. */
  park(localId: string): Promise<string | null>;
  /** The cache-warming setting, read when the timer fires. */
  warming(): boolean;
  log(line: string): void;
  /** A name for the log lines. */
  who?(localId: string): string;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

/** The warm the engine handed over for `sessionId`, from its `_elastic_park` answer. */
export function handedWarm(answer: Record<string, unknown> | undefined, sessionId: string): number | null {
  const warms = Array.isArray(answer?.['warms']) ? (answer!['warms'] as unknown[]) : [];
  for (const w of warms) {
    const r = w as Record<string, unknown> | null;
    if (r?.['sessionId'] === sessionId && typeof r['dueAt'] === 'number' && Number.isFinite(r['dueAt'])) return r['dueAt'];
  }
  return null;
}

export class WarmWake {
  private readonly timers = new Map<string, unknown>();

  constructor(private readonly deps: WarmWakeDeps) {}

  /** A chat parked: arm its wake if the engine handed a warm over (and forget an older one). */
  parked(localId: string, sessionId: string | null, answer: Record<string, unknown> | undefined): void {
    this.cancel(localId);
    if (!sessionId) return;
    const dueAt = handedWarm(answer, sessionId);
    if (dueAt === null || !this.deps.warming()) return;
    const now = (this.deps.now ?? Date.now)();
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timers.set(localId, set(() => { this.timers.delete(localId); void this.fire(localId, sessionId); }, Math.max(dueAt - WAKE_LEAD_MS - now, 0)));
  }

  /** The chat closed, or is in use again. */
  cancel(localId: string): void {
    const t = this.timers.get(localId);
    if (t === undefined) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(t);
    this.timers.delete(localId);
  }

  /** Armed wakes, for tests and the log. */
  get armed(): number { return this.timers.size; }

  dispose(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  private async fire(localId: string, sessionId: string): Promise<void> {
    const chat = this.deps.find(localId);
    if (!chat || chat.client.currentSessionId !== sessionId) return; // closed
    const name = `[elastic] ${this.deps.who?.(localId) ?? `engine session ${sessionId}`}`;
    if (!this.deps.warming()) { this.deps.log(`${name}: not woken to warm (cache warming is off)`); return; }
    if (chat.gate.current !== 'parked') return; // in use: its own engine warms
    this.deps.log(`${name}: woken to warm`);
    if (!(await chat.gate.whenUp().catch(() => false))) { this.deps.log(`${name}: not warmed (the engine did not start)`); return; }
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await chat.client.extMethod('_elastic_warm', { sessionId });
    } catch (e) {
      answer = { warmed: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (answer?.['warmed'] === true) {
      const read = typeof answer['cacheRead'] === 'number' ? `, cache read ${answer['cacheRead']} tokens` : '';
      this.deps.log(`${name}: warmed${read}`);
    } else {
      this.deps.log(`${name}: not warmed (${String(answer?.['reason'] ?? 'no answer')})`);
    }
    const why = await this.deps.park(localId).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    this.deps.log(why === null ? `${name}: parked again` : `${name}: not parked again (${why})`);
  }
}
