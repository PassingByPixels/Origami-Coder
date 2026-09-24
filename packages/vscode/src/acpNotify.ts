// acpNotify.ts — the `origami/*` notification payloads: wire frame in, handler
// args out. Extracted from acpClient.ts's `extNotification` switch; nothing here
// reads the client's mutable state.
//
// Two obligations: the engine's payloads are snake_case (`winner_index`,
// `sub_tasks`) while the handlers are camelCase, so the rename happens once; and a
// malformed payload must not poison the webview, so every field is coerced and
// every open-ended string the UI BRANCHES on is narrowed to a renderable value.

import type { TodoRow } from './acpTodoWrite';

/** A raw `origami/*` notification body — every field still unknown. */
export type NotifyParams = Record<string, unknown>;

/** `origami/planCandidates` — one best-of-N critic round. A null `score` means
 *  the critic response for that candidate was unparseable. */
export interface PlanCandidates {
  winnerIndex: number;
  fallback: boolean;
  rationale: string;
  alternatives: Array<{
    index: number;
    title: string;
    planId: string;
    textPreview: string;
    score: {
      feasibility: number;
      specificity: number;
      riskCoverage: number;
      total: number;
      notes: string;
    } | null;
  }>;
}

export function planCandidatesFrom(p: NotifyParams): PlanCandidates {
  const alts = Array.isArray(p.alternatives) ? p.alternatives : [];
  return {
    winnerIndex: Number(p.winner_index ?? 0),
    fallback: Boolean(p.fallback),
    rationale: String(p.rationale ?? ''),
    alternatives: alts.map((a: any) => ({
      index: Number(a.index ?? 0),
      title: String(a.title ?? ''),
      planId: String(a.plan_id ?? ''),
      textPreview: String(a.text_preview ?? ''),
      score: a.score
        ? {
            feasibility: Number(a.score.feasibility ?? 0),
            specificity: Number(a.score.specificity ?? 0),
            riskCoverage: Number(a.score.risk_coverage ?? 0),
            total: Number(a.score.total ?? 0),
            notes: String(a.score.notes ?? ''),
          }
        : null,
    })),
  };
}

/** `origami/taskShape` — the decomposition behind the checklist. `source` and a
 *  sub-task `status` stay open strings: the card only LABELS them, so narrowing
 *  would drop a value the engine may legitimately add. */
export interface TaskShape {
  source: string;
  truncatedExtra: number;
  subTasks: Array<{
    id: number;
    description: string;
    status: string;
  }>;
}

export function taskShapeFrom(p: NotifyParams): TaskShape {
  const subs = Array.isArray(p.sub_tasks) ? p.sub_tasks : [];
  return {
    source: String(p.source ?? 'heuristic'),
    truncatedExtra: Number(p.truncated_extra ?? 0),
    subTasks: subs.map((s: any) => ({
      id: Number(s.id ?? 0),
      description: String(s.description ?? ''),
      status: String(s.status ?? 'pending'),
    })),
  };
}

/** `origami/todoSnapshot` — the harness-owned TODO tracker (SPEC §7.2). The row
 *  shape is acpTodoWrite.ts's `TodoRow` rather than a copy of it: the SAME strip
 *  is also fed from the todowrite tool frames, and two declarations of one
 *  strip's row is exactly how the two feeds would drift apart. */
export interface TodoSnapshot {
  source: 'model_write' | 'auto_seed' | 'session_restore';
  todos: TodoRow[];
}

export function todoSnapshotFrom(p: NotifyParams): TodoSnapshot {
  // Same defensive coercion as before: a malformed payload
  // must not poison the webview.
  const todos = Array.isArray(p.todos) ? p.todos : [];
  const rawSource = String(p.source ?? 'model_write');
  const source =
    rawSource === 'auto_seed' || rawSource === 'session_restore'
      ? rawSource
      : 'model_write';
  return {
    source,
    todos: todos.map((t: any) => {
      const rawStatus = String(t.status ?? 'pending');
      const status =
        rawStatus === 'in_progress' || rawStatus === 'completed'
          ? rawStatus
          : 'pending';
      // Same rule as the todowrite feed (acpTodoWrite.ts): a depth that is not
      // a real number reads as flat, never as a dropped row.
      const rawDepth = t.depth;
      return {
        id: Number(t.id ?? 0),
        content: String(t.content ?? ''),
        activeForm: String(t.activeForm ?? ''),
        status,
        depth: typeof rawDepth === 'number' && Number.isFinite(rawDepth) ? rawDepth : 0,
      };
    }),
  };
}

/** `origami/arbiterDecision` — the ONE per-turn verdict. An unrecognised label
 *  reads as `continue`, never as `done`: a turn must not be shown finished on a
 *  word the dashboard cannot map. */
export interface ArbiterDecision {
  decision: 'done' | 'continue' | 'ask_user';
  reason: string;
}

export function arbiterDecisionFrom(p: NotifyParams): ArbiterDecision {
  const rawDecision = String(p.decision ?? '');
  const decision =
    rawDecision === 'done' || rawDecision === 'continue' || rawDecision === 'ask_user'
      ? rawDecision
      : 'continue';
  return {
    decision,
    reason: String(p.reason ?? ''),
  };
}

/** `origami/flockMailbox` — the Front Desk mailbox, pushed because `flock.json`
 *  moved on disk. THE SAME SHAPE `flock_mailbox` RETURNS, so the panel posts the
 *  pane the message its poll already posts. Rows are passed through UNREAD: they
 *  are the store's own `Thread` objects and the pane owns what they mean. The
 *  COUNTS are coerced, because the badge does arithmetic with them. */
export interface FlockMailboxPush {
  threads: unknown[];
  waiting: number;
  unread: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function flockMailboxFrom(p: NotifyParams): FlockMailboxPush {
  return {
    threads: Array.isArray(p.threads) ? p.threads : [],
    waiting: count(p.waiting),
    unread: count(p.unread),
  };
}

/** `origami/cacheState` — is this session's prompt prefix still in the provider's
 *  cache (engine `session/cache-state.ts`). `unmeasured` is NOT a polite `cold`: the
 *  provider reports no cache tokens, so nothing is known. `until`/`ttlSeconds` are
 *  OMITTED, never zeroed, when the provider publishes no window — a zero would read
 *  as a countdown that already ran out, which is why only a POSITIVE number survives
 *  the decode, and why the type is read off the decoder rather than declared twice. */
export type CacheStatePush = ReturnType<typeof cacheStateFrom>;

export function cacheStateFrom(p: NotifyParams) {
  const state = String(p.state ?? '');
  const win = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    sessionId: String(p.sessionId ?? ''),
    state: state === 'warm' || state === 'cold' ? state : ('unmeasured' as const),
    ...(win(p.until) === undefined ? {} : { until: win(p.until) }),
    ...(win(p.ttlSeconds) === undefined ? {} : { ttlSeconds: win(p.ttlSeconds) }),
    source: String(p.source ?? 'request'),
  };
}
