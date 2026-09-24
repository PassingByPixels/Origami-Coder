// subagentSettle.ts: t-v5qi8q. The ONE host path that ends a sub-agent's row.
//
// Two callers: the engine's terminal marker (DashboardPanel onSubagentDone) and
// the reply to the drawer's Stop (turnMessages.ts). Both must write the same
// three records, or a reload and the live pane disagree on whether the child
// is out: the message log a reopened chat is rebuilt from, the sidebar ring's
// running set, and the roster row for a child above the loaded page.

import type { TaskTokens } from '../acpTaskTokens';
import { noteRosterChild, type HostHistory } from './historyHost';
import { logSubagentDone } from './sessionLogSubagent';
import type { SessionMessage } from './sessionLog';

/** The parts of DashboardPanel's Session this writes. */
export interface SettleSession {
  messageLog: SessionMessage[];
  runningChildren: Set<string>;
  history?: HostHistory;
}

export interface SubagentSettled {
  taskSessionId: string;
  state: 'completed' | 'error';
  endedAt?: number;
  /** The FINAL spend, when the settling frame carried one; absent keeps the last live figure. */
  tokens?: TaskTokens;
}

export function settleSubagent(
  session: SettleSession | undefined,
  post: (msg: Record<string, unknown>) => void,
  sessionId: string | undefined,
  done: SubagentSettled,
): void {
  const { taskSessionId, state, endedAt, tokens } = done;
  if (session) {
    logSubagentDone(session.messageLog, taskSessionId, state, endedAt, tokens);
    session.runningChildren.delete(taskSessionId); // ring's 4th state, see runningChildren.ts
    noteRosterChild(session.history, taskSessionId, true, tokens); // a child above the loaded page has no card to stamp
  }
  post({ type: 'subagentDone', taskSessionId, state, endedAt, sessionId });
}
