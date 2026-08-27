// Collabs in the Labyrinth: which listed sessions are ONE collab, and which
// swimlane each step of a merged collab map sits on. Pure, so both answers are
// testable without a DOM. A row with no collabId is an ordinary run and passes
// through untouched, so a board with no collabs on it is unchanged.
//
// LANE DERIVATION IS DELIBERATELY NOT branchModel's, and that is a MEASUREMENT,
// not a preference: that ledger frees a column at a branch's mergeAt, and a
// member's head step is not a `subagent`, so mergeAt is its own last step and
// the next member RECYCLES the column - three interleaved members were measured
// landing on column 0, one lane, whatever their parentOrdinal. Collab members
// are ROOT sessions running in parallel, the one shape that ledger cannot
// express, so a member's lane comes from its own `agent` against the roster.

/** A historyList row; the collab trio is absent on an ordinary run. */
export interface CollabRow { sessionId: string; title: string; folder: string; cwd?: string; updatedAt: string; collabId?: string; collabTitle?: string; agentSlug?: string }

/** One entry in the run index: a plain run, or a collab and its members. */
export interface IndexGroup {
  /** What a pick hands the pane: a sessionId, or `collab:<id>` for a header. */
  pickId: string;
  /** `N agents` on a collab header; empty on a plain run. */
  subtitle: string;
  /** The member rows under a header, in listed order; empty on a plain run. */
  members: CollabRow[];
  title: string; collab: boolean; folder: string; updatedAt: string;
}

/** An index row's timestamp, local. Unparseable prints NOTHING, never "Invalid Date". */
export function whenLabel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
}
export const COLLAB_PREFIX = 'collab:';
/** Lanes drawn before the rest fold onto the last; mirrors the host's cap. */
export const MAX_MEMBER_LANES = 8;

/** The collab id inside a header's pick id; null for an ordinary session id. */
export function collabIdOf(pickId: string): string | null {
  return pickId.startsWith(COLLAB_PREFIX) ? pickId.slice(COLLAB_PREFIX.length) || null : null;
}

const newer = (a: string, b: string): boolean => {
  const ta = Date.parse(a); const tb = Date.parse(b);
  return Number.isFinite(ta) && (!Number.isFinite(tb) || ta > tb);
};

/**
 * Rows sharing a collabId collapse under ONE header, placed where the FIRST of
 * them was listed so the index keeps the host's ordering. The header carries the
 * collab's LATEST activity, so grouping never makes one look staler than a
 * member row it swallowed.
 */
export function collabIndex(rows: readonly CollabRow[]): IndexGroup[] {
  const out: IndexGroup[] = [];
  const seen = new Map<string, IndexGroup>();
  for (const row of rows) {
    const id = row.collabId;
    if (!id) {
      out.push({ pickId: row.sessionId, title: row.title, subtitle: '', collab: false, folder: row.folder, updatedAt: row.updatedAt, members: [] });
      continue;
    }
    let group = seen.get(id);
    if (!group) {
      group = { pickId: COLLAB_PREFIX + id, title: row.collabTitle || row.title, subtitle: '', collab: true, folder: row.folder, updatedAt: row.updatedAt, members: [] };
      seen.set(id, group);
      out.push(group);
    }
    group.members.push(row);
    if (newer(row.updatedAt, group.updatedAt)) group.updatedAt = row.updatedAt;
    group.subtitle = `${group.members.length} agent${group.members.length === 1 ? '' : 's'}`;
  }
  return out;
}

/** The cwd to ask a collab's steps under: the first member that recorded one. */
export function collabCwd(rows: readonly CollabRow[], collabId: string): string {
  return rows.find((r) => r.collabId === collabId && r.cwd)?.cwd ?? '';
}

/** The part of a step the lane rules read. `LayoutStep` satisfies it. */
export interface MemberStep { agent?: string }

/**
 * The lane each step sits on, and the roster those lanes are labelled from.
 * `members` is authoritative when the host sent it: a participant that never
 * started contributes no steps but KEEPS its slot, so labels stay aligned with
 * the lanes under them. With no roster the slugs the steps carry are used, in
 * first-seen order - observed, never invented. A step naming no member of the
 * roster gets -1 and keeps the strip's ordinary geometry rather than being
 * parked on a lane it does not own - UNLESS the roster is full, which is how a
 * folded one looks: past the cap the host keeps the real slug on the step but
 * labels the last slot `+N more`, so an unknown agent there is a folded member
 * and belongs on that last lane, not off the roster entirely.
 */
export function memberLanes(steps: readonly MemberStep[], members?: readonly string[]): { lane: number[]; names: string[] } {
  const names = members?.length ? [...members] : [];
  if (!names.length) {
    for (const s of steps) if (s.agent && !names.includes(s.agent)) names.push(s.agent);
  }
  const last = Math.min(names.length, MAX_MEMBER_LANES) - 1;
  const folded = names.length >= MAX_MEMBER_LANES;
  const slot = new Map(names.map((n, i) => [n, Math.min(i, last)]));
  return { lane: steps.map((s) => (!s.agent ? -1 : slot.get(s.agent) ?? (folded ? last : -1))), names };
}
