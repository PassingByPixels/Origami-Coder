// Folds board — the PURE bucket + cluster logic behind the seven-column kanban
// (contract §6). No DOM, no vscode API: which column a card lands in, and how
// race siblings cluster, are decidable from data alone, so they are unit-tested
// directly instead of through a rendered pane. (The repo-pill badge counts lived
// here too until repo CARDS replaced the pills — the counts duplicated the In
// progress and Blocked columns, so they went with them.)
//
// The TICKET is the entity; the FOLD is provisioned when work starts. That gives
// the board two card kinds — a TicketCard (a markdown file in .origami/tickets)
// and the fold AgentCard — and one rule that stops a launched ticket drawing both.

/** A fold row (ext contract §5: AgentRow + ticketId / ticketTitle / activity). */
export interface Row {
  id: string; name: string; branch: string; path: string; orphan: boolean;
  state: 'provisioning' | 'working' | 'idle' | 'error' | 'detached' | 'queued';
  agentName: string; model: string; stopReason: string; errorDetail: string; setupNote: string;
  startedAt: number; hasSession: boolean; ahead: number; adds: number; dels: number; queuedPrompt: string;
  mergedAt: number; groupId: string;
  /** The ticket this fold was launched from ('' = a plain fold). */
  ticketId: string;
  /** That ticket's title, so the card can headline the WORK, not the branch slug. */
  ticketTitle: string;
  /** One live line of what the agent is doing right now ('' = nothing to say). */
  activity: string;
  needsYou: { kind: string; preview: string } | null;
}

/** A ticket file's head (ext contract §5). */
export interface TicketRow {
  id: string; title: string; status: string; priority: string;
  labels: string[]; assignee: string;
  acceptance: { done: number; total: number };
  updatedAt: number; fold: string; branch: string; malformed?: boolean;
  /**
   * A spec chat is open for this ticket right now (contract §11.3). ABSENT on an
   * older host, so every reader must treat undefined as "no spec session" — a
   * card that assumed the field would never render its way out of "speccing…".
   */
  spec?: boolean;
}

/** S15 cartographer: the repo's architecture-map status, rides amState per repo. */
export interface RepoMapState {
  status: 'none' | 'ready' | 'building' | 'failed';
  sha?: string; branch?: string; builtAt?: number; behind?: number;
  errors?: string[]; name?: string;
}

export interface RepoBoard {
  root: string; name: string; workspace: boolean; missing: boolean;
  defaultModel: string; rows: Row[]; map: RepoMapState; tickets: TicketRow[];
  /** The checkout that owns this repository's tickets, folds and apply-to-main.
   *  Equal to `root` unless someone set a primary. ABSENT on an older host, so a
   *  reader must treat undefined as "the root itself". */
  primary?: string;
  /** Repo cards: entries sharing a git common dir are ONE repository and draw one
   *  card. '' / absent = git has not been asked yet; the entry stands alone. */
  groupId?: string;
  /** The primary checkout's current branch ('' = detached, or not resolved yet). */
  branch?: string;
}

export type ColumnId = 'triage' | 'todo' | 'pending' | 'doing' | 'blocked' | 'done' | 'merged';

export interface ColumnDef { id: ColumnId; label: string; subtitle: string }

// Column ORDER is the ticket's own lifecycle, left to right. The subtitle says
// what the column is FOR in one line — a head reading "Pending" alone leaves the
// reader guessing which of queued-fold and unspec'd-idea it means.
export const COLUMNS: ColumnDef[] = [
  { id: 'triage', label: 'Triage', subtitle: 'raw ideas — spec them before launch' },
  { id: 'todo', label: 'Todo', subtitle: "spec'd with acceptance — ready to launch" },
  { id: 'pending', label: 'Pending', subtitle: 'worktree ready, task not started' },
  { id: 'doing', label: 'In progress', subtitle: 'an agent is working in its worktree' },
  { id: 'blocked', label: 'Blocked', subtitle: 'needs you — a question or a failed run' },
  { id: 'done', label: 'Done', subtitle: 'finished, not applied to main yet' },
  { id: 'merged', label: 'Merged', subtitle: 'applied to main — retired' },
];

/** Which column a FOLD row belongs to. Blocked is DERIVED here, never stored. */
export function bucketRow(r: Row): ColumnId {
  // Merged (a clean apply-to-main) retires the card REGARDLESS of runtime state;
  // every other bucket excludes a merged row.
  if (r.mergedAt > 0) return 'merged';
  // Blocked before Pending/In progress: a run waiting on an answer, or one that
  // failed, is the thing you must look at — its runtime state is the detail.
  if (r.needsYou || r.state === 'error') return 'blocked';
  if (r.state === 'queued') return 'pending';
  if (r.state === 'provisioning' || r.state === 'working') return 'doing';
  return 'done'; // idle / detached / orphan relics, unmerged
}

/**
 * Which column a TICKET draws in, or null when it draws no card at all.
 * The dedupe rule: a ticket with `fold` set is ABSORBED by its fold row (which
 * carries ticketId/ticketTitle), so a launched ticket is ONE card, never two.
 */
export function bucketTicket(t: TicketRow): ColumnId | null {
  // A file we could not parse is never dropped silently (contract §2) — it
  // surfaces in Triage as a warning row, where the human can open and fix it.
  // Checked FIRST because a malformed file's other fields cannot be trusted.
  if (t.malformed) return 'triage';
  if (t.fold) return null;
  if (t.status === 'triage') return 'triage';
  if (t.status === 'todo') return 'todo';
  // The unlaunched-file case: a ticket marked merged that never got a fold.
  if (t.status === 'merged') return 'merged';
  // pending / in_progress / done are stamped by the fold lifecycle, so without a
  // fold they are a stale hand-edit; `closed` is hidden in v1. Neither draws.
  return null;
}

export interface ColumnContent { rows: Row[]; tickets: TicketRow[] }

/** Bucket one repo's folds + tickets into the seven columns, order preserved. */
export function buildColumns(rows: Row[], tickets: TicketRow[]): Record<ColumnId, ColumnContent> {
  const out = {} as Record<ColumnId, ColumnContent>;
  for (const c of COLUMNS) out[c.id] = { rows: [], tickets: [] };
  for (const r of rows) out[bucketRow(r)].rows.push(r);
  for (const t of tickets) {
    const id = bucketTicket(t);
    if (id) out[id].tickets.push(t);
  }
  return out;
}

/** Card filter over a fold row — its name, branch, task, and its ticket. */
export function rowMatches(r: Row, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return [r.name, r.branch, r.queuedPrompt, r.ticketId, r.ticketTitle]
    .some((v) => (v ?? '').toLowerCase().includes(q));
}

/** Card filter over a ticket — id, title, labels, assignee. */
export function ticketMatches(t: TicketRow, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return [t.id, t.title, t.assignee, ...(t.labels ?? [])]
    .some((v) => (v ?? '').toLowerCase().includes(q));
}

// ---- fan-out clustering: rows of one race group cluster adjacently under a
//      slim group header; the header can Prune the losing siblings once any one
//      of them has been merged (a clean apply-to-main). ----
export type Cluster =
  | { kind: 'single'; row: Row }
  | { kind: 'group'; groupId: string; base: string; rows: Row[]; siblings: Row[] };

export function baseName(name: string): string { return name.replace(/-\d+$/, '') || name; }

export function clusters(colRows: Row[], allRows: Row[]): Cluster[] {
  const out: Cluster[] = [];
  const placed = new Set<string>();
  for (const r of colRows) {
    if (!r.groupId) { out.push({ kind: 'single', row: r }); continue; }
    if (placed.has(r.groupId)) continue;
    const rows = colRows.filter((x) => x.groupId === r.groupId);
    // A lone sibling in THIS column (e.g. a merged winner sitting alone in
    // Merged while its losers wait in Done) is not a cluster here — render it as
    // an ordinary card, no race header and no second "Prune rest".
    if (rows.length < 2) { out.push({ kind: 'single', row: r }); continue; }
    placed.add(r.groupId);
    out.push({ kind: 'group', groupId: r.groupId, base: baseName(rows[0].name), rows, siblings: allRows.filter((x) => x.groupId === r.groupId) });
  }
  return out;
}

/** Compact age since `from` (ms epoch). '' when there is no honest value. */
export function age(from: number, now: number = Date.now()): string {
  if (!from || from <= 0) return '';
  const s = Math.max(0, Math.floor((now - from) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}
