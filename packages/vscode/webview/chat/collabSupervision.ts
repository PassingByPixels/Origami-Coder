// W3 wave 3 (report 2.4 / F13) — what the human's SUPERVISION surface may say
// about one agent, and about one finished task. A PURE leaf.
//
// Wave 1 gave the engine four per-member methods (`collab_stop_agent`,
// `collab_redirect`, `collab_review`, `collab_preview`) where the only interrupt
// used to be room-wide. Each of them needs a judgement made BEFORE the call —
// which agents may be stopped, which rows may take a verdict — and one made
// after it, about an answer that is deliberately not a bare ok. Making those in
// the components would spread the same three rules over CollabRoster,
// CollabRosterChip and CollabStream; they live here instead, testable with no
// DOM, mirroring collabKinds.ts's split out of the same stream.
//
// The shapes MIRROR src/acpExtTypes.ts rather than importing it —
// tsconfig.webview.json pins rootDir to `webview/`, so a webview .ts cannot
// reach into src/. Same convention collabKinds.ts and collabWaiting.ts follow.

/** Mirrors `CollabAgentActivity`, plus the ring state F13 asks for. */
export type RingState = 'idle' | 'queued' | 'running' | 'error';

/** The part of a `CollabAgentStatus` this leaf reads. */
export interface SupervisedAgent {
  slug: string;
  state: 'idle' | 'queued' | 'running';
  lastError?: string;
}

/**
 * The ring one chip draws.
 *
 * WHAT IT IS DOING NOW BEATS WHAT IT LAST DID. The runner carries `lastError`
 * forward across a re-queue (`lastErrorOf` on every queued/settled transition
 * in collab/runner.ts), so an agent can be genuinely running with a failure
 * still attached. Painting that as `error` would say the room is broken while
 * it works. The failure keeps its own row in the stream instead.
 *
 * An ABSENT status is idle: a participant that has never taken a turn has no
 * status entry at all, and that is the ordinary early state of every collab.
 */
export function ringState(agent: SupervisedAgent | undefined): RingState {
  if (!agent) return 'idle';
  if (agent.state !== 'idle') return agent.state;
  return agent.lastError ? 'error' : 'idle';
}

/** Whether `collab_stop_agent` has anything to end. An idle agent has neither a
 *  turn in flight nor a place in the queue, so the call could only answer
 *  "nothing happened" — and a control that always refuses is not one. */
export const canStopAgent = (state: SupervisedAgent['state']): boolean => state !== 'idle';

/** Mirrors `CollabRunner.StopAgentResult`, plus the extension's own refusal
 *  field: a stop that never reached the engine has no outcome to report. */
export interface StopOutcome {
  interrupted: boolean;
  dequeued: boolean;
  error?: string;
}

/**
 * What a per-agent stop actually did, said honestly.
 *
 * The engine answers `{interrupted, dequeued}` and NEVER a bare ok, precisely
 * because the two halves are separately true: a turn in flight is interrupted,
 * a turn waiting behind it is dequeued, and an agent can have one, both or
 * neither. NEITHER is a real answer — an idle agent has nothing to stop, and an
 * agent running NESTED inside another's ask has no turn of its own to interrupt
 * (runner.ts: stopAgent). Reporting either as "Stopped." would be a lie the
 * user cannot check.
 */
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

/**
 * The per-chip supervision pair, or null where there is nothing to supervise.
 *
 * THREE WAYS TO GET NULL, and they are different facts: an archived room takes
 * no posts at all (a redirect is a post), a removed participant has left the
 * roster, and a caller that wired neither callback is a surface with no
 * supervision — an older shell, or the read-only views. Null in every case,
 * because "offered but dead" is the disabled-button lie the M3 create bug was.
 */
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

/**
 * Every agent carrying a failure, in roster order.
 *
 * F13: a failed turn appends NOTHING to the stream by design — "a stack trace
 * in the log would be a message every other agent then reads and reacts to"
 * (runner.ts's drain) — so the only trace was a 14px badge on a chip. This is
 * how the room says it out loud without putting it in the transcript the agents
 * read.
 */
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

/**
 * The task a `task_done` row may take a verdict on, or null.
 *
 * `collab_review` accepts a COMPLETED task and refuses everything else, so a
 * button offered on any other state is a control that can only ever error. The
 * row's own kind is not enough: the board moves on, and a task accepted an hour
 * ago still has its `task_done` row sitting in the transcript.
 *
 * ABSENT `tasks` means the engine sent no board at all, never "no tasks".
 */
export function reviewableTaskId(
  msg: { kind?: string; taskId?: string | null },
  tasks: readonly ReviewableTask[] | undefined,
): string | null {
  if (msg.kind !== 'task_done' || !msg.taskId || !tasks) return null;
  return tasks.find((t) => t.id === msg.taskId)?.state === 'done' ? msg.taskId : null;
}
