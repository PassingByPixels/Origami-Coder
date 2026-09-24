// Loops pane data leaf: live /loop schedules as LoopsPane wire shapes; see loopAttention.ts.

import { formatInterval } from './chatCommands';

export { toNeedsAttentionLoops, type NeedsAttentionLoop } from './loopAttention';

export type LoopOutcome = 'ok' | 'failed';

export interface LoopScheduleInfo {
  sessionId: string;
  number: number;
  agentName: string;
  title?: string;
  intervalLabel: string;
  prompt: string;
  runs: number;
  /** Opted out of dying with its chat (loopPersistence.ts). */
  persistent: boolean;
  /** True when this loop has NO chat of its own — pulled back up on a headless
   *  session after its chat closed. "Still scheduled, no chat open" is a
   *  different state from a loop you can see, and the pane must say which. */
  headless: boolean;
  /**
   * When the ARMED timer will fire, epoch ms — read off the installed timer, never computed from
   *  createdAt + interval*runs (which drifts by however long every run took). NULL is a real
   *  answer: between a tick starting and its next timer being armed there is no scheduled instant.
   */
  nextRunAt: number | null;
  /** When the last run finished, epoch ms; null when it has not completed one
   *  in THIS window (live-only — a reload does not restore it, and inventing
   *  one from the persisted `runs` count would be a fabrication). */
  lastRunAt: number | null;
  /** How that run ended; null whenever `lastRunAt` is. */
  lastOutcome: LoopOutcome | null;
}

/** The slice of a Session this leaf needs — kept structural (not imported from
 *  DashboardPanel.ts) so this module has no dependency on the host's private
 *  Session type. */
interface LoopScheduleSource {
  number: number;
  agentName: string;
  title?: string;
  /** 'agent' == headless: no chat tab of its own. A recalled persistent loop
   *  lives on one of these. */
  kind?: 'chat' | 'agent';
  loopSchedule?: {
    intervalMs: number; prompt: string; runs: number; stopped: boolean; persistent?: boolean;
    nextRunAt?: number; lastRunAt?: number; lastOutcome?: LoopOutcome;
  };
}

/** Every session running an active /loop schedule, in session-map insertion order. A session's
 *  loopSchedule is always cleared synchronously when stopped, so no `stopped` field ever survives
 *  into this map. */
export function collectLoopSchedules(sessions: Map<string, LoopScheduleSource>): LoopScheduleInfo[] {
  const out: LoopScheduleInfo[] = [];
  for (const [sessionId, session] of sessions) {
    const sched = session.loopSchedule;
    if (!sched || sched.stopped) continue;
    out.push({
      sessionId,
      number: session.number,
      agentName: session.agentName,
      title: session.title,
      intervalLabel: formatInterval(sched.intervalMs),
      prompt: sched.prompt,
      runs: sched.runs,
      persistent: sched.persistent === true,
      headless: session.kind === 'agent',
      nextRunAt: sched.nextRunAt ?? null,
      lastRunAt: sched.lastRunAt ?? null,
      // Paired with lastRunAt on purpose: an outcome with no time is not a
      // last run, it is half a record, and the pane would render it as one.
      lastOutcome: sched.lastRunAt !== undefined ? sched.lastOutcome ?? null : null,
    });
  }
  return out;
}
