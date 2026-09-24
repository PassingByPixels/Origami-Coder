// nestReplies.ts — t-selspn: the nest/chunk replies this desk waits for, per
// peer and chat. SEVERAL waiters per key: since L6 the mother base's tail and
// a click (or a release's pull) can ask one desk for one chat at the same
// time. The first chunk answers all of them (a re-import is harmless, and a
// chunk past `have + 1` is a `gap` the pull asks again for); a later duplicate
// finds no waiter and is dropped. One waiter per key hung the other one.

export interface ReplyTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class NestReplies<T> {
  private readonly waiting = new Map<string, Set<(value: T) => void>>();

  constructor(private readonly timers: ReplyTimers) {}

  /** Resolves with the next answer for `key`, or rejects after `ms`. */
  public wait(key: string, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const set = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, set);
      const drop = () => { set.delete(done); if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key); };
      const timer = this.timers.setTimer(() => { drop(); reject(new Error('The other desk did not answer.')); }, ms);
      const done = (value: T) => { this.timers.clearTimer(timer); drop(); resolve(value); };
      set.add(done);
    });
  }

  /** Answer every waiter for `key`; with none, the value is dropped. */
  public answer(key: string, value: T): void {
    for (const done of [...(this.waiting.get(key) ?? [])]) done(value);
  }
}
