// engineGate.ts — one chat's engine state, and the work that waits for it (t-v5qn37).
//
// Since lazy restore (0.4.173) a chat pane is on screen before its engine is up. Anything the
// user did in that window went straight to the AcpClient, which threw "... called before
// start()", and the pane showed it as a red Error card. Now every such path waits here first,
// in ONE queue, so the work reaches the engine in the order the user did it:
//   hold()   — a prompt (send, slash command, /compact, a /loop run). It returns a TurnSlot;
//              the caller calls done() when the turn has ended.
//   follow() — an interjection typed while a prompt waits. It goes after the turns ahead of
//              it have ENDED: sent next to a prompt the engine has not yet started, the engine
//              would take it as a turn of its own and write it BEFORE that prompt.
//   whenUp() — a session call that is not a turn (mode, effort, model, rename, rewind ...).
// If the start fails the queue is kept; the pane shows the reason with Retry, and retry() runs
// the same start again. The pane draws these states with the reconnect card (SystemAlertRow),
// never the red Error card (webview/dashboard/panes/engineNotice.ts).

/** MIRROR of webview/dashboard/panes/engineNotice.ts EngineStage — engineNotice.test.ts reads
 *  both files. `stopped` = the engine was up and has exited; nothing here starts it again. */
export type EngineStage = 'starting' | 'ready' | 'failed' | 'stopped';
/** `parked` (t-w2txb2) = the engine was stopped ON PURPOSE after a long idle (elastic/park.ts); the next
 *  held work starts it again with the restore park() was given. The pane is never told it (t-wdyi2t):
 *  a parked chat shows nothing, and its next message opens the ordinary "Starting" card. t-wypna7: a chat reopened
 *  at a window reload while not on screen is `parked` too, before its first start (defer()). */
export type GateStage = EngineStage | 'parked';

/** What the pane is told. `held` = the messages (prompts and interjections) waiting now.
 *  `retry` = the card may offer Retry: a failed start that is safe to run again.
 *  t-x3a89j: `at` = when the start failed or the engine stopped (ms since epoch); `details` = the text the
 *  card's Copy details puts on the clipboard. Both only on `failed` and `stopped`. */
export interface EngineStatePost {
  stage: EngineStage;
  reason: string;
  held: number;
  retry: boolean;
  at?: number;
  details?: string;
}

/** t-x3a89j: what the gate reports a failure to, beyond the pane. */
export interface GateOptions {
  /** One line per failed start or restore, and per stop ("Origami Elastic"). */
  log?(line: string): void;
  /** Lines for Copy details that name the chat (its number, its engine session). */
  describe?(): string[];
}

/** hold()'s answer for a prompt that will not be sent: the stop reason for its `turnDone`. */
export type NotSent = 'cancelled' | 'error';

/** A released prompt's place in the order. `done()` = its turn has ended (safe to call twice). */
export interface TurnSlot {
  done(): void;
}

type Kind = 'prompt' | 'follow' | 'call';
interface Waiter {
  kind: Kind;
  settle: (go: boolean, why: NotSent) => void;
}

/** A fork (the Fork button, or a typed /btw) whose fork call never returned an id may still exist on the engine, so a
 *  second attempt could make a second copy. One that did return its id is reused by
 *  AcpClient.start() (it returns the id it already holds), so Retry is safe there. */
export function forkRetryRefusal(forking: boolean, engineSessionId: string | null | undefined): string {
  return forking && !engineSessionId
    ? 'The fork did not open, and a new try could make a second copy. Close this tab and use the Fork button again.'
    : '';
}

/** The turn messages (turnMessages.ts): an interjection takes its place in the gate's order;
 *  stopping a background shell or a sub-agent goes at once — it only means anything mid-turn. */
export function routeTurnMessage(gate: EngineGate | undefined, m: { type?: string }, deliver: () => void): void {
  if (m.type !== 'interject' || !gate) {
    deliver();
    return;
  }
  void gate.follow().then((go) => { if (go) deliver(); });
}

export class EngineGate {
  private stage: GateStage = 'starting';
  private reason = '';
  private retryable = true;
  private run: (() => Promise<void>) | null = null;
  private refusal: () => string = () => '';
  private queue: Waiter[] = [];
  /** Released prompts whose turn has not ended. A queued interjection waits for zero. */
  private inTurn = 0;
  /** Errors and exits the engine reported while it was starting: part of the failure reason. */
  private startNotes: string[] = [];
  /** The pane has an open card for this start, so every later state goes to it. */
  private shown = false;
  /** t-x3a89j: when the start failed or the engine stopped; the run that failed was a restore of a parked chat. */
  private at = 0;
  private restoring = false;
  /** t-xoenz1: the chat was closed. Its engine's exit is the one the close asked for, not a loss. */
  private closed = false;
  /** t-xoenz1: `describe()` as it read when the engine stopped. The client drops its engine session id as the exit
   *  lands, so the Copy details asked for later still name the session that stopped. */
  private stoppedAs: string[] | null = null;

  constructor(private readonly tell: (post: EngineStatePost) => void, private readonly opts: GateOptions = {}) {}

  get current(): GateStage {
    return this.stage;
  }

  /** Run the engine start. On failure the pane is told and the error is re-thrown.
   *  `refusal` names why Retry would be unsafe after a failure ('' = safe). */
  async start(run: () => Promise<void>, refusal?: () => string): Promise<void> {
    this.run = run;
    if (refusal) this.refusal = refusal;
    this.stage = 'starting';
    this.reason = '';
    this.retryable = true;
    this.startNotes = [];
    this.notify();
    try {
      await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const why = this.refusal();
      this.stage = 'failed';
      this.retryable = !why;
      this.reason = [this.startNotes.length > 0 ? `${msg} (${this.startNotes.join('; ')})` : msg, why].filter(Boolean).join(' · ');
      this.failed();
      throw e;
    }
    this.stage = 'ready';
    this.restoring = false;
    this.notify();
    this.pump();
  }

  /** t-w2txb2: the engine is about to be stopped on purpose. Only an engine that is up with no
   *  turn in it and nothing waiting can be parked (false = it was not). From now on the next
   *  hold(), follow() or whenUp() runs `restore` as a start, and the work waits for it in order. */
  park(restore: () => Promise<void>): boolean {
    if (this.stage !== 'ready' || this.inTurn > 0 || this.queue.length > 0) return false;
    this.stage = 'parked';
    this.run = restore;
    this.shown = false;
    this.restoring = true;
    return true;
  }

  /** t-wypna7: a chat reopened at a window reload while it is not on screen. Its first start is kept, not run:
   *  the gate is `parked`, and the first hold(), follow() or whenUp() runs it (elastic/reloadDefer.ts). `after`
   *  runs once, when that first start has ended (resolved or failed). Only a gate that never started can defer. */
  defer(run: () => Promise<void>, refusal?: () => string, after?: () => void): Promise<void> {
    if (this.stage !== 'starting' || this.run) return this.start(run, refusal).finally(() => after?.());
    let first = true;
    this.run = async () => {
      try {
        await run();
      } finally {
        if (first) { first = false; after?.(); }
      }
    };
    if (refusal) this.refusal = refusal;
    this.stage = 'parked';
    return Promise.resolve();
  }

  /** The park did not go ahead (the engine refused it): back to ready, unless work already
   *  started the restore, which ends in ready by itself. */
  unpark(): void {
    if (this.stage !== 'parked') return;
    this.stage = 'ready';
    this.pump();
  }

  /** Retry: run the last start again. Only after a failure that is safe to repeat, so a
   *  second click, or a click on a refused fork, starts nothing. */
  retry(): Promise<void> {
    if (this.stage !== 'failed' || !this.run || !this.retryable) return Promise.resolve();
    return this.start(this.run).catch(() => { /* start() told the pane */ });
  }

  /** A prompt. Resolves with its slot when it may be sent, or with why it will not be. */
  hold(): Promise<TurnSlot | NotSent> {
    return new Promise((resolve) => this.enqueue('prompt', (go, why) => resolve(go ? this.slot() : why)));
  }

  /** hold() and the turn itself: `send` runs once the prompt may go, and its end frees the
   *  slot. A throw from `send` passes through, so the caller's own catch still reports it. */
  async turn<T>(send: () => Promise<T>): Promise<{ sent: true; value: T } | { sent: false; why: NotSent }> {
    const slot = await this.hold();
    if (typeof slot === 'string') return { sent: false, why: slot };
    try {
      return { sent: true, value: await send() };
    } finally {
      slot.done();
    }
  }

  /** An interjection. True when it may be delivered; false when it will not be. */
  follow(): Promise<boolean> {
    return new Promise((resolve) => this.enqueue('follow', (go) => resolve(go)));
  }

  /** A session call that is not a turn. True when the engine is up; false when it will not be. */
  whenUp(): Promise<boolean> {
    return new Promise((resolve) => this.enqueue('call', (go) => resolve(go)));
  }

  /** t-xoenz1: the chat is closing (DashboardPanel.closeSession, or the window). Everything held is released, one line
   *  says it was closed (with the engine it had), and the engine exit that follows is not logged as a loss. */
  close(why = ''): void {
    if (this.closed) return;
    this.opts.log?.(`[engine] ${this.who()}: ${this.stage === 'parked' ? 'closed while parked' : 'closed'}${why ? ` (${why})` : ''}`);
    this.closed = true;
    this.drop(true);
  }

  /** Stop: every waiting message is released unsent. `all` (the chat closed) releases the
   *  session calls too — this chat's engine will never answer them. */
  drop(all = false): void {
    const keep = this.queue.filter((w) => !all && w.kind === 'call');
    const release = this.queue.filter((w) => all || w.kind !== 'call');
    if (release.length === 0) return;
    this.queue = keep;
    for (const w of release) w.settle(false, 'cancelled');
    this.notify();
  }

  /** The engine process exited or errored. While no engine is up this belongs to the start's
   *  failure reason, and true tells the caller to post nothing. After the engine was up it is
   *  a real loss: waiting work is refused, and false leaves the report to the caller. */
  exited(reason: string): boolean {
    if (this.closed) return true; // t-xoenz1: the close asked for this exit
    if (this.stage === 'starting') {
      this.startNotes.push(reason);
      return true;
    }
    if (this.stage === 'failed') {
      // t-x3a89j: the connection can close (and the start fail) before the exit event arrives. The exit code
      // still belongs to that failure, so the card and the log get it.
      if (!this.reason.includes(reason)) {
        this.reason = `${this.reason} (${reason})`;
        this.opts.log?.(`[engine] ${this.who()}: ${reason}`);
        this.notify(true);
      }
      return true;
    }
    if (this.stage === 'parked') return true; // parked: the exit was asked for
    if (this.stage === 'ready') {
      this.stoppedAs = this.opts.describe?.() ?? null;
      this.stage = 'stopped';
      this.reason = reason;
      this.at = Date.now();
      this.opts.log?.(`[engine] ${this.who()}: the engine stopped: ${reason}`);
      const release = this.queue;
      this.queue = [];
      for (const w of release) w.settle(false, 'error');
    }
    return false;
  }

  private enqueue(kind: Kind, settle: Waiter['settle']): void {
    if (this.stage === 'stopped') {
      this.notify(true); // the refusal is a card under what the user just did
      settle(false, 'error');
      return;
    }
    // t-w2txb2: parked — this work is what starts the engine again. It waits in the queue like
    // work sent before a first start, and start() releases it in order.
    if (this.stage === 'parked' && this.run) {
      this.queue.push({ kind, settle });
      void this.start(this.run).catch(() => { /* start() told the pane; Retry runs it again */ });
      return;
    }
    // Nothing ahead of it: go now. This is the ordinary case, and it keeps an interjection into
    // a turn that is already running exactly what it was.
    if (this.stage === 'ready' && (kind === 'call' || this.queue.length === 0)) {
      if (kind === 'prompt') this.inTurn++;
      settle(true, 'cancelled');
      return;
    }
    this.queue.push({ kind, settle });
    if (this.stage === 'ready') this.pump();
    else if (kind !== 'call') this.notify(true);
  }

  /** Release the queue while the engine is up. Messages keep their order: a prompt goes at
   *  once and counts as a turn; an interjection waits until every turn ahead of it has ended,
   *  and every message after it waits with it. A session call is not a message and goes at
   *  once — a rewind or a history page must not wait for a whole turn. */
  private pump(): void {
    if (this.stage !== 'ready') return;
    let blocked = false;
    const waiting: Waiter[] = [];
    for (const w of this.queue.splice(0)) {
      if (w.kind === 'call') w.settle(true, 'cancelled');
      else if (!blocked && (w.kind === 'prompt' || this.inTurn === 0)) {
        if (w.kind === 'prompt') this.inTurn++;
        w.settle(true, 'cancelled');
      } else {
        blocked = true;
        waiting.push(w);
      }
    }
    this.queue = waiting;
  }

  private slot(): TurnSlot {
    let open = true;
    return {
      done: () => {
        if (!open) return;
        open = false;
        this.inTurn--;
        this.pump();
      },
    };
  }

  private held(): number {
    return this.queue.filter((w) => w.kind !== 'call').length;
  }

  /** t-x3a89j: a failed start: stamp the time, log it, tell the pane. */
  private failed(): void {
    this.at = Date.now();
    this.opts.log?.(`[engine] ${this.who()}: the engine did not start${this.restoring ? ' again (restore of a stopped chat)' : ''}: ${this.reason}`);
    this.notify();
  }

  private who(): string {
    return this.described()[0] ?? 'chat';
  }

  /** The describe() lines: as they read when the engine stopped, once it has (t-xoenz1). */
  private described(): string[] {
    return (this.stage === 'stopped' ? this.stoppedAs : null) ?? this.opts.describe?.() ?? [];
  }

  /** t-x3a89j: the Copy details text. */
  private details(): string {
    const title = this.stage === 'stopped' ? 'The engine stopped' : this.restoring ? 'The engine did not start again (restore of a stopped chat)' : 'The engine did not start';
    return [`Origami: ${title}`, `When: ${new Date(this.at).toISOString()}`, `Why: ${this.reason}`, ...this.described()].join('\n');
  }

  /** Tell the pane when there is something to show: a failure, a held message, or a card
   *  already open. A start nobody waits on posts nothing. */
  private notify(force = false): void {
    if (this.stage === 'parked' || (!force && !this.shown && this.stage !== 'failed' && this.held() === 0)) return;
    const end = this.stage === 'failed' || this.stage === 'stopped';
    this.tell({ stage: this.stage, reason: this.reason, held: this.held(), retry: this.stage === 'failed' && this.retryable, ...(end ? { at: this.at, details: this.details() } : {}) });
    this.shown = this.stage === 'starting' || this.stage === 'failed';
  }
}
