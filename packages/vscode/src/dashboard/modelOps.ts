/**
 * PER-CHAT model-operation guard. A single slow engine call used to hold ONE workspace-wide
 *  boolean, so a brand-new chat's first model pick could be refused as "already running" for an
 *  unrelated chat's switch.
 * Three fixes: the lock is keyed by session id; a DEADLINE bounds only the ACP setModel await (not
 *  the whole switch, since a local model load legitimately runs long) and the caller releases the
 *  lock from its callback; and `busyMessage` names the running operation and its age.
 */

/**
 * Deadline on the ACP setModel await: long enough an ordinary catalog rebuild finishes inside it,
 *  short enough a hung one does not outlive the user's patience with the lock held.
 */
export const MODEL_SWITCH_DEADLINE_MS = 30_000;

/** Handle returned by a SUCCESSFUL `begin`. `release` is idempotent. */
export interface ModelOpHandle {
  release(): void;
}

interface ModelOp {
  label: string;
  startedAt: number;
}

/** "14 s ago" / "2 min 3 s ago" — the age a user can compare with their click. */
export function formatOpAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s ago`;
}

/**
 * Run `onDeadline` if `promise` has not settled within `ms`, and hand back the promise unchanged.
 *  Does NOT cancel or reject — the request may still be answered — it only stops a silent wait so
 *  the caller can free its lock and say "still waiting".
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, onDeadline: () => void): Promise<T> {
  const timer = setTimeout(onDeadline, ms);
  return promise.finally(() => clearTimeout(timer));
}

export class ModelOpGuard {
  private readonly ops = new Map<string, ModelOp>();

  constructor(
    /** One line per start/end into the activity log (DashboardPanel.appendActivityLine, kind model_op). */
    private readonly log: (line: string) => void = () => { },
    /** Injectable clock so a test can age an operation without waiting. */
    private readonly now: () => number = () => Date.now(),
  ) { }

  /**
   * Claim the lock for ONE chat. Returns a handle, or undefined when that same chat already has an
   *  operation out — never because a different chat does.
   */
  begin(sessionId: string, label: string): ModelOpHandle | undefined {
    if (this.ops.has(sessionId)) return undefined;
    const op: ModelOp = { label, startedAt: this.now() };
    this.ops.set(sessionId, op);
    this.log(`model op ${label} start`);
    // Identity-checked: after an early release the SAME chat may already own a
    // newer operation, and the late `finally` must not free that one.
    return {
      release: () => {
        if (this.ops.get(sessionId) !== op) return;
        this.ops.delete(sessionId);
        this.log(`model op ${label} end (${this.now() - op.startedAt} ms)`);
      },
    };
  }

  /** "switching Cortex-0396 to gpt-5.6-luna, started 14 s ago", or undefined. */
  describe(sessionId: string): string | undefined {
    const op = this.ops.get(sessionId);
    if (!op) return undefined;
    return `${op.label}, started ${formatOpAge(this.now() - op.startedAt)}`;
  }

  /** The line posted to a chat whose model action was dropped. */
  busyMessage(sessionId: string): string {
    const running = this.describe(sessionId);
    return running
      ? `A model operation is already running in this chat — ${running}. Ignored.`
      : 'A model operation is already running — ignored.';
  }

  /** TRUE while ANY chat holds the lock — the remote-adopt sweep's old guard. */
  anyInFlight(): boolean {
    return this.ops.size > 0;
  }
}
