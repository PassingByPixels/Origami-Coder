// parkHost.ts — t-w2txb2: DashboardPanel's side of parking. DashboardPanel.ts is at its line cap, so the
// panel only builds one of these and calls it: park a chat (the activity tracker, or a finished Folds
// agent), start a parked chat again when a peer message lands for it, and clean up when a parked chat
// is closed. The mechanics are park.ts; the mailbox is parkedMail.ts. No vscode here.

import { writeStandIn } from './parkedMail'; // t-wypna7 (its own line: lane C edits the import below)
import { parkChat, type ParkChat } from './park';
import { hasMail, removeStandIn, watchMail } from './parkedMail';
import { engineWho, type LabelSession } from './engineLabel';
import { WARM_PENDING } from './parkPolicy';
import { WarmWake } from './warmWake';

export interface ParkHostSession extends ParkChat, Omit<LabelSession, 'client'> {
  id: string;
  /** The host awaits a prompt on this chat (DashboardPanel `Session.turnBusy`). */
  turnBusy?: boolean;
}

export interface ParkHostDeps {
  sessions(): Iterable<ParkHostSession>;
  log(line: string): void;
  /** Something the activity tracker reads changed: a finished fold waits to park, or a restore ended. */
  changed?(): void;
  /** Test seams; the real ones watch and read ~/.origami/agents. */
  watch?: typeof watchMail;
  mail?: typeof hasMail;
  removeStandIn?: typeof removeStandIn;
  writeStandIn?: typeof writeStandIn;
  /** t-z6ytkw: the cache-warming setting now (cacheWarming.ts). Absent = off: nothing is woken to warm. */
  warming?(): boolean;
  /** Test seams for the warm wake timers (warmWake.ts). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

export class ParkHost {
  private watcher: { dispose(): void } | null = null;
  /** t-wdyi2t: finished Folds chats, parked by the tracker once no view shows them (review #9). */
  private readonly waiting = new Map<string, readonly string[]>();
  /** The park requests that are out, per client: a chat closed meanwhile removes its stand-in again after. */
  private readonly asking = new Map<object, Promise<string | null>>();

  /** t-z6ytkw: wakes a parked chat to send the cache warm its engine handed over, then parks it again. */
  readonly warmWake: WarmWake;

  constructor(private readonly deps: ParkHostDeps) {
    this.warmWake = new WarmWake({
      find: (id) => this.find((s) => s.id === id),
      park: (id) => this.park(id),
      warming: () => deps.warming?.() ?? false,
      log: deps.log,
      who: (id) => { const s = this.find((c) => c.id === id); return s ? engineWho(s) : id; },
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  /** Park one chat. null = parked, else why not. `allow` = idle-report reasons that do not block this
   *  park: a finished Folds agent closes even while a cache warm is armed (owner decision, see run.ts).
   *  t-z6ytkw: every park now waives an armed warm; the engine hands its schedule over (warmWake.ts). */
  async park(localId: string, allow: readonly string[] = this.waiting.get(localId) ?? [WARM_PENDING]): Promise<string | null> {
    const chat = this.find((s) => s.id === localId);
    if (!chat) return 'no such chat';
    // The first park starts the mailbox watch: a window that never parks never watches.
    this.watcher ??= (this.deps.watch ?? watchMail)((sid) => this.mailFor(sid));
    const asking = parkChat(chat, this.deps.log, { hostPid: process.pid, allow, restored: () => this.deps.changed?.(), who: () => engineWho(chat), parked: (answer) => this.warmWake.parked(localId, chat.client.currentSessionId, answer) });
    this.asking.set(chat.client, asking);
    const why = await asking.finally(() => this.asking.delete(chat.client));
    if (why === null) this.waiting.delete(localId);
    // t-xsrtml: the park attempt settled (parked, refused or woken); tell the caller whatever the
    // outcome, the same edge the tracker's own re-classify needs (review #9 above).
    this.deps.changed?.();
    // A message that landed while the engine was stopping (after its last read) is read now.
    const sid = chat.client.currentSessionId;
    if (why === null && sid && (this.deps.mail ?? hasMail)(sid)) this.mailFor(sid);
    return why;
  }

  /** t-wdyi2t (review #9): a finished Folds agent's engine closes, but not while a view shows the chat or the
   *  phone is on it: the activity tracker parks it as soon as it is hidden and holds no work (`parkSoon`). */
  finished(localId: string, allow: readonly string[]): Promise<string | null> {
    this.waiting.set(localId, allow);
    this.deps.changed?.();
    return Promise.resolve(null);
  }

  /** The chat waits to park as soon as it is hidden (sessionSignals.ts reads this for its view). */
  parkSoon(localId: string): boolean {
    if (!this.waiting.has(localId)) return false;
    // The user took the chat up again: from here it is an ordinary chat (a cache warm wins again).
    if (this.find((s) => s.id === localId)?.turnBusy) { this.waiting.delete(localId); return false; }
    return true;
  }

  /** A message waits for engine session `sid`: start its chat if it is parked. The restored engine reads
   *  its mailbox itself (engine agent-mailbox.ts), so nothing is sent from here. */
  mailFor(sid: string): void {
    const chat = this.find((s) => s.client.currentSessionId === sid && s.gate.current === 'parked');
    if (!chat) return;
    this.deps.log(`[elastic] a message for parked engine session ${sid}: starting it again`);
    void chat.gate.whenUp();
  }

  /** t-wypna7: chat `sid` was reopened at a window reload without its engine (elastic/reloadDefer.ts; its gate is
   *  `parked` and its client holds `sid`). It gets a stand-in named `name` (list_agents shows it stopped, send_message
   *  keeps the message in its mailbox), the mailbox watch starts, and mail that waited from before the reload starts it
   *  now. A stand-in that could not be written is logged: the chat still starts on focus, a message or a /loop run. */
  deferred(sid: string, cwd: string, name: string): void {
    this.watcher ??= (this.deps.watch ?? watchMail)((s) => this.mailFor(s));
    if (!(this.deps.writeStandIn ?? writeStandIn)({ name, cwd, kind: 'interactive', sessionId: sid, hostPid: process.pid, parkedAt: Date.now() })) {
      this.deps.log(`[elastic] engine session ${sid}: no stand-in written; peers cannot reach it until it starts`);
    }
    if ((this.deps.mail ?? hasMail)(sid)) this.mailFor(sid);
  }

  /** The chat is closing (before its client is disposed). One the engine was told to park leaves no stand-in
   *  behind: keyed on that (`wake` is set from the ask until a restore ends), not on the gate stage, so a close
   *  during the ask or during a restore is covered too (review #4). */
  closed(chat: ParkChat & { id?: string }): void {
    if (chat.id !== undefined) { this.waiting.delete(chat.id); this.warmWake.cancel(chat.id); }
    const sid = chat.client.currentSessionId;
    if (!sid || !chat.client.wake) return;
    const remove = this.deps.removeStandIn ?? removeStandIn;
    remove(sid);
    // The engine may still write it while the ask is out: remove it again once the ask has settled.
    void this.asking.get(chat.client)?.then(() => remove(sid), () => remove(sid));
  }

  dispose(): void {
    this.warmWake.dispose();
    this.watcher?.dispose();
    this.watcher = null;
  }

  private find(match: (s: ParkHostSession) => boolean): ParkHostSession | undefined {
    for (const s of this.deps.sessions()) if (match(s)) return s;
    return undefined;
  }
}
