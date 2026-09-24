// childFailure.ts — PURE. What to SAY when a passthrough child dies, stalls, or is refused by the
// plan, and whether a dead child is worth resuming.
//
// Extracted from driver.ts/claudeCodeCell.ts rather than grown inside them: none of this needs a
// process, and every shape below was read out of the installed CLI (2.1.198,
// C:\Users\dev\.local\bin\claude.exe) rather than assumed —
//   `rate_limit_event.rate_limit_info.status`  ∈ allowed | allowed_warning | rejected
//   `result` success carries `api_error_status: number|null`
//   `result` error subtypes ∈ error_during_execution | error_max_turns | error_max_budget_usd |
//                            error_max_structured_output_retries, and carry `errors: string[]`
//                            (there is NO `result` string on that half of the union).
// The last line matters: fromResult used to read `ev.result` alone, so an errored turn's only
// explanation was dropped on the floor.

import type { ClaudeEvent } from './protocol';

/** How many stderr lines a crash card quotes. Enough to carry a node stack's first frames; short
 *  enough that a chat row stays readable. */
export const STDERR_TAIL = 6;

/** The last few lines the child wrote to stderr. A ring, because a crashing CLI can write
 *  megabytes and only the tail explains anything. */
export class StderrTail {
  private lines: string[] = [];
  push(chunk: string): string[] {
    const fresh = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    this.lines = [...this.lines, ...fresh].slice(-STDERR_TAIL);
    return fresh;
  }
  tail(): readonly string[] { return this.lines; }
  clear(): void { this.lines = []; }
}

/** A refusal that spending more turns cannot fix. `resetsAt` is epoch ms, 0 when unreported. */
export interface PlanLimitNotice {
  /** The limit's own name, as the CLI labels the window ("7d", "5h", ""). */
  window: string;
  resetsAt: number;
  /** Whole percent of the window spent, or -1. */
  pct: number;
}

// The CLI's own vocabulary for a refusal, on the two surfaces a driver can see it: the API error
// envelope it prints (`rate_limit_error`, HTTP 429) and the prose it writes for a human.
const LIMIT_TEXT = /rate[_ -]?limit|429\b|usage limit|usage credits|out of (?:usage|credits)|quota exceeded/i;

/** Did this line of stderr / result prose say the plan is what stopped us? */
export function looksPlanLimited(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

/**
 * The plan refusal carried by a `rate_limit_event`, or null.
 *
 * Only `rejected` qualifies: `allowed_warning` is the pill's job (usagePill.ts) and turning a
 *  warning into a blocking card would cry wolf on every turn of a busy week.
 */
export function planLimitOf(ev: ClaudeEvent): PlanLimitNotice | null {
  if (ev.type !== 'rate_limit_event') return null;
  const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
  if (info.status !== 'rejected') return null;
  return {
    window: typeof info.rateLimitType === 'string' ? info.rateLimitType : '',
    resetsAt: typeof info.resetsAt === 'number' && info.resetsAt > 0 ? info.resetsAt * 1000 : 0,
    pct: typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : -1,
  };
}

/** Every explanation an errored `result` carries. The error half of the union writes `errors[]`;
 *  the success half writes `result`. Both are read, so neither shape is silently dropped. */
export function resultErrorText(ev: ClaudeEvent): string {
  const errors = Array.isArray(ev.errors) ? ev.errors.filter((e): e is string => typeof e === 'string') : [];
  const result = typeof ev.result === 'string' ? ev.result : '';
  return [...errors, result].filter(Boolean).join(' · ');
}

/** Is this errored `result` a plan/rate refusal rather than an ordinary failure? `api_error_status`
 *  is the CLI's own field and is checked first — it is the only unambiguous signal. */
export function resultPlanLimited(ev: ClaudeEvent): boolean {
  if (ev.api_error_status === 429) return true;
  return looksPlanLimited(resultErrorText(ev));
}

/** "resets Tue 16 Sep 2026, 09:00" — empty when the CLI did not say. Built against the caller's
 *  clock-free `Date`, so the card reads in the user's own locale. */
export function resetClause(resetsAt: number): string {
  return resetsAt ? ` It resets ${new Date(resetsAt).toLocaleString()}.` : '';
}

/** The distinct card a plan refusal earns — never the generic "Claude Code ended the turn". */
export function planLimitMessage(limit: PlanLimitNotice): string {
  const used = limit.pct >= 0 ? ` (${limit.pct}% used)` : '';
  const win = limit.window ? ` ${limit.window.replace(/_/g, ' ')}` : '';
  return `Claude Code is out of plan headroom: your${win} limit${used} is spent, so this turn was refused.${resetClause(limit.resetsAt)} Nothing here is broken — the chat works again once the window rolls over.`;
}

/** Why a child stopped, as the driver measured it. */
export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stderr: readonly string[];
  /** Ask ids the child was still blocked on when it went. */
  pendingAsks: readonly string[];
  /** The refusal seen on the wire or in stderr, when the death looks plan-shaped. */
  planLimit?: PlanLimitNotice;
  /** What the driver did about it. `resumed` means a child is already back up with `--resume` and
   *  the turn's own prompt re-sent; every other value is a reason it did not try. */
  recovery: 'resumed' | 'plan-limit' | 'already-tried' | 'no-session' | 'one-shot' | 'idle' | 'spawn-failed';
}

const WHY: Record<ExitInfo['recovery'], string> = {
  resumed: '',
  'plan-limit': 'Not resumed: the plan window is spent, so a retry would be refused too.',
  'already-tried': 'Not resumed: this turn had already been resumed once and died again.',
  'no-session': 'Not resumed: the CLI never reported a session id, so there is nothing to continue.',
  'one-shot': 'Not resumed: this was a one-shot run, not a chat.',
  idle: 'No turn was in flight, so nothing was lost.',
  'spawn-failed': 'The child could not be started.',
};

/**
 * The crash card's text: what died, what it said on the way out, and what was done about it.
 *
 * Deliberately one paragraph rather than a stack dump — the full stderr is already in the output
 * channel, and a chat row that scrolls for a screen is a row nobody reads.
 */
export function exitMessage(info: ExitInfo): string {
  const how = info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`;
  const said = info.stderr.length ? ` Last output: ${info.stderr.join(' / ')}` : '';
  const limit = info.planLimit ? ` ${planLimitMessage(info.planLimit)}` : '';
  const asks = info.pendingAsks.length
    ? ` ${info.pendingAsks.length} permission request${info.pendingAsks.length === 1 ? '' : 's'} died with it and cannot be answered.`
    : '';
  const why = info.recovery === 'resumed'
    ? ' Your session was resumed and the last message re-sent — anything Claude had already finished is still done, so check before repeating it.'
    : ` ${WHY[info.recovery]}`;
  return `Claude Code stopped (${how}).${said}${limit}${asks}${why}`;
}

/**
 * What an unexpected exit was, and whether the child is worth bringing back.
 *
 * The recovery rule: ONE attempt per turn, and only when there is a conversation to continue. The
 * plan-limit clause is the important one - a refusal is not a crash, and respawning into a spent
 * window would spend the user's next allowance on the same refusal.
 */
export function exitInfoOf(o: {
  code: number | null; signal: string | null; stderr: readonly string[]; pendingAsks: readonly string[];
  turnOpen: boolean; sessionId?: string | undefined; tried: boolean; oneShot: boolean;
  planLimit?: PlanLimitNotice | undefined;
}): ExitInfo {
  const recovery: ExitInfo['recovery'] = !o.turnOpen ? 'idle'
    : o.oneShot ? 'one-shot'
      : o.planLimit ? 'plan-limit'
        : o.tried ? 'already-tried'
          : !o.sessionId ? 'no-session' : 'resumed';
  return {
    code: o.code, signal: o.signal, stderr: o.stderr, pendingAsks: o.pendingAsks, recovery,
    ...(o.planLimit ? { planLimit: o.planLimit } : {}),
  };
}
