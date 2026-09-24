// What the human's supervision surface may say about one agent, and about
// one finished task. A pure leaf.
//
// These rules live here rather than spread across CollabRoster,
// CollabRosterChip and CollabStream, so each judgement is testable with no
// DOM. Shapes mirror src/acpExtTypes.ts rather than importing it, since a
// webview .ts cannot reach into src/ (tsconfig.webview.json).

/** Mirrors `CollabAgentActivity`, plus the ring state F13 asks for. */
export type RingState = 'idle' | 'queued' | 'running' | 'error';

/** The part of a `CollabAgentStatus` this leaf reads. */
export interface SupervisedAgent {
  slug: string;
  state: 'idle' | 'queued' | 'running';
  lastError?: string;
}

/** What it's doing now beats what it last did: `lastError` persists across
 *  a re-queue, so a running agent keeps its own row for the failure instead
 *  of being drawn as `error` while it works. */
export function ringState(agent: SupervisedAgent | undefined): RingState {
  if (!agent) return 'idle';
  if (agent.state !== 'idle') return agent.state;
  return agent.lastError ? 'error' : 'idle';
}

/** Whether `collab_stop_agent` has anything to end: an idle agent has no
 *  turn and no queue slot, so the call could only answer "nothing happened". */
export const canStopAgent = (state: SupervisedAgent['state']): boolean => state !== 'idle';

/** Mirrors `CollabRunner.StopAgentResult`, plus the extension's own refusal
 *  field: a stop that never reached the engine has no outcome to report. */
export interface StopOutcome {
  interrupted: boolean;
  dequeued: boolean;
  error?: string;
}

/** What a stop actually did, said honestly: `interrupted` and `dequeued`
 *  are independently true, so a bare "Stopped." would be an unverifiable lie. */
export function stopOutcomeText(name: string, outcome: StopOutcome): string {
  if (outcome.error) return outcome.error;
  if (outcome.interrupted && outcome.dequeued) return `Stopped ${name} — turn interrupted, queued turn dropped.`;
  if (outcome.interrupted) return `Stopped ${name} — its turn was interrupted.`;
  if (outcome.dequeued) return `Took ${name} out of the queue.`;
  return `${name} was already idle — nothing to stop.`;
}

/** The controls ONE chip draws, already bound to its own agent. */
export interface ChipSupervision {
  canStop: boolean;
  /** What the last stop of THIS agent did, worded. '' for nothing to say. */
  outcome: string;
  onStop: () => void;
  onRedirect: (text: string) => void;
}

/** The per-chip supervision pair, or null where there is nothing to
 *  supervise: archived, a removed participant, or a caller missing a
 *  callback. Always null, never a disabled control offered as if live. */
export function chipSupervision(input: {
  archived: boolean;
  removed: boolean;
  /** The SHORT name, so every label and the outcome sentence name this agent. */
  name: string;
  slug: string;
  state: SupervisedAgent['state'];
  stopOutcome: (StopOutcome & { agentSlug: string }) | null | undefined;
  onStopAgent?: (slug: string) => void;
  onRedirect?: (slug: string, text: string) => void;
}): ChipSupervision | null {
  const { onStopAgent, onRedirect, stopOutcome } = input;
  if (input.archived || input.removed || !onStopAgent || !onRedirect) return null;
  return {
    canStop: canStopAgent(input.state),
    // `post` fans every reply out to every view, so an outcome only belongs on
    // the chip it names — never on whichever chip happens to be rendering.
    outcome: stopOutcome && stopOutcome.agentSlug === input.slug ? stopOutcomeText(input.name, stopOutcome) : '',
    onStop: () => onStopAgent(input.slug),
    onRedirect: (text: string) => onRedirect(input.slug, text),
  };
}

/** One agent's last-turn failure, ready for a stream row. */
export interface AgentFailure {
  slug: string;
  text: string;
}

/** Every agent carrying a failure, in roster order. A failed turn appends
 *  nothing to the stream, so this is how the room surfaces it instead. */
export function agentFailures(agents: readonly SupervisedAgent[] | undefined): AgentFailure[] {
  return (agents ?? [])
    .filter((a): a is SupervisedAgent & { lastError: string } => !!a.lastError)
    .map((a) => ({ slug: a.slug, text: a.lastError }));
}

/** The part of a `TaskEntry` the verdict rule reads. */
export interface ReviewableTask {
  id: string;
  state: 'open' | 'claimed' | 'done' | 'accepted';
}

/** The task a `task_done` row may take a verdict on, or null. `collab_review`
 *  accepts only a completed task, so the row's own kind is not enough — a
 *  task accepted earlier can still show its old `task_done` row. */
export function reviewableTaskId(
  msg: { kind?: string; taskId?: string | null },
  tasks: readonly ReviewableTask[] | undefined,
): string | null {
  if (msg.kind !== 'task_done' || !msg.taskId || !tasks) return null;
  return tasks.find((t) => t.id === msg.taskId)?.state === 'done' ? msg.taskId : null;
}
