// The COLLAB map's step source: N member sessions read as ONE run.
//
// A Collab owns no session of its own (collab/runner.ts creates every member
// session as a ROOT, with no parentID), so `run_steps` has nothing to project
// and the history index holds nothing that means "this collab". This module
// builds the run the engine does not store: it asks the collab who its members
// are, reads each member's OWN session through the same boardData leaf the
// single-run map uses (the ext call plumbing is NOT duplicated here), and
// merges the results into one time-ordered, per-member-lane-stamped list.
//
// Nothing invents a step, rewrites a `kind`, or drops a member: one that never
// took a turn keeps its lane slot, and one whose fetch fails is NAMED in
// `error` while the rest still render. No `vscode` import, so every rule below
// is exercised against a fake client.
import type { RunStep, RunStepsResult } from '../acpExtTypes';
import { runStepsPayload } from './boardData';
import { collabList, collabState, type CollabSource } from './collabData';

/** A merged step. Both flags are ADDITIVE optionals the webview's LayoutStep
 *  mirrors; ABSENT means "not a collab tool" / "not a baton", never unknown. */
export interface CollabStep extends RunStep {
  collabTool?: true;
  baton?: true;
}

/** What a history row learns about its collab. A non-collab row gets none of
 *  these keys and stays byte-identical to today. */
export interface CollabMark {
  collabId: string;
  collabTitle: string;
  agentSlug: string;
}

export interface CollabStepsPayload {
  /** `collab:<id>` - the pane's selection echo key, NOT an engine session id. */
  sessionId: string;
  steps: CollabStep[];
  truncated: boolean;
  total: number;
  /** One agentSlug per rendered LANE, in lane order. A long roster folds. */
  members: string[];
  collabTitle?: string;
  error?: string;
}

/** Both wires: the generic ext seam (collabData) + typed run_steps (boardData). */
export interface CollabStepsSource extends CollabSource {
  getRunSteps(sessionId: string, cwd?: string): Promise<RunStepsResult>;
}

/** The flock protocol tools - a COLLAB move, not ordinary work. */
const COLLAB_TOOLS = new Set(['ask', 'handoff', 'done',
  'task_add', 'task_claim', 'task_done', 'task_accept', 'task_reopen']);
/** Lanes rendered before the roster's tail folds into the last one. */
const MAX_LANES = 8;

/** The runner's envelope: machine traffic. Rendering it as a human turn would
 *  put words in the user's mouth. */
const isBaton = (s: RunStep): boolean =>
  [s.title, s.preview].some((t) => (t ?? '').trimStart().startsWith('[Collab:'));

const stamp = (s: RunStep, lane: number, agentSlug: string): CollabStep => ({
  ...s,
  // depth 1 keeps a member OFF the main spine; the negative parent is unique
  // per lane and cannot collide with a real branch (no ordinal is negative).
  depth: 1,
  parentOrdinal: -(lane + 1),
  // FORCED, not defaulted: usage buckets partition by `agent`, so a member step
  // still carrying the sub-agent name it ran under would bill the wrong lane.
  agent: agentSlug,
  ...(s.tool && COLLAB_TOOLS.has(s.tool) ? { collabTool: true as const } : {}),
  // `kind` is never rewritten - only a PROMPT can be a baton, so a tool step
  // whose title happens to open with the envelope is left alone.
  ...(s.kind === 'prompt' && isBaton(s) ? { baton: true as const } : {}),
});

/** One label per rendered lane. A roster past MAX_LANES keeps its first seven
 *  names and folds the rest into a COUNTED last lane - never a name it lacks. */
const laneLabels = (parts: Array<{ agentSlug: string }>): string[] =>
  parts.length <= MAX_LANES
    ? parts.map((p) => p.agentSlug)
    : [...parts.slice(0, MAX_LANES - 1).map((p) => p.agentSlug), `+${parts.length - MAX_LANES + 1} more`];

/** `sessionId -> mark` for every member session in this workspace, so the
 *  history index can say which run belongs to which collab. A collab read that
 *  fails yields an EMPTY map and exactly ONE warning: the index must still list
 *  every run. An undecorated row lost a label; a throw would lose the index. */
export async function collabSessionMarks(
  client: CollabSource | null | undefined,
  cwd?: string,
): Promise<Map<string, CollabMark>> {
  const marks = new Map<string, CollabMark>();
  if (!client) return marks;
  const list = await collabList(client, cwd);
  const problems: string[] = list.error ? [list.error] : [];
  const states = await Promise.all(list.collabs.map((c) => collabState(client, c.id, 0, cwd)));
  states.forEach((state, i) => {
    const c = list.collabs[i]!;
    // One collab that cannot be read must not cost the others their labels.
    if (state.error) { problems.push(`${c.id}: ${state.error}`); return; }
    for (const p of state.participants) {
      if (p.sessionId) marks.set(p.sessionId, { collabId: c.id, collabTitle: c.title, agentSlug: p.agentSlug });
    }
  });
  if (problems.length) console.warn(`[origami] history rows left undecorated: ${problems.join('; ')}`);
  return marks;
}

/** One collab's members merged into a single map-ready run. Order is by
 *  `startedAt` across ALL members, so the map reads as the collab actually
 *  unfolded; a step the engine gave no clock keeps its member-local position
 *  and lands after every timed step rather than being guessed into the
 *  timeline. `ordinal` is re-stamped over the merged list, because the incoming
 *  ordinals are per-member and would otherwise repeat. */
export async function collabStepsPayload(
  client: CollabStepsSource | null | undefined,
  collabId: string,
  cwd = '',
): Promise<CollabStepsPayload> {
  const state = await collabState(client, collabId, 0, cwd);
  const title = state.collab?.title;
  const head = { sessionId: `collab:${collabId}`, ...(title ? { collabTitle: title } : {}) };
  if (state.error) return { ...head, steps: [], truncated: false, total: 0, members: [], error: state.error };

  const parts = state.participants;
  const fetched = await Promise.all(parts.map((p) => (p.sessionId ? runStepsPayload(client, p.sessionId, cwd) : null)));
  const errors: string[] = [];
  let truncated = false;
  let total = 0;
  const byMember = fetched.map((res, i) => {
    const p = parts[i]!;
    // No session = never took a turn. Zero steps, but the lane slot survives.
    if (!res) return [];
    if (res.error) { errors.push(`member ${p.agentSlug} unreadable: ${res.error}`); return []; }
    truncated = truncated || res.truncated;
    total += res.total;
    return res.steps.map((s) => stamp(s, Math.min(i, MAX_LANES - 1), p.agentSlug));
  });

  // Stable sort (V8 guarantees it), so two steps sharing a clock keep roster
  // order instead of swapping between two reads of the same collab.
  const merged = byMember.flat();
  const timed = merged.filter((s) => typeof s.startedAt === 'number');
  timed.sort((a, b) => a.startedAt! - b.startedAt!);
  const steps = [...timed, ...merged.filter((s) => typeof s.startedAt !== 'number')]
    .map((step, i) => ({ ...step, ordinal: i }));

  return { ...head, steps, truncated, total, members: laneLabels(parts), ...(errors.length ? { error: errors.join('; ') } : {}) };
}
