// Agent Manager - board.ts (Folds board, repo cards): the amState BROADCAST -
// the one place a RepoBoard is built - extracted from manager.ts at its line cap
// when every projection had to start resolving the repo's PRIMARY checkout.
//
// Two things live here and nothing else: the roster pre-fill that must run
// before a board is sent, and the projection itself. Both are driven through a
// narrow BoardCtx the fleet owner builds, so the owner keeps only routing, the
// worktree lifecycle and the poller.
//
// The PRIMARY rule: a registered entry is a place on disk; the work - its
// tickets, its fold worktrees, its state file, its apply target - belongs to
// that repository's PRIMARY checkout. `primaryOf` resolves it (absent = the
// root itself, which is why a user who never sets one sees no change at all).

import { loadState } from './state';
import { boardTickets, ticketTitles, type TicketRow } from './tickets';
import { isSpecActive } from './specRun';
import { buildRows, type AgentRow } from './rows';
import { mergeAgentTypes } from './agentTypes';
import type { RepoEntry } from './registry';
import type { RepoIdent } from './repoCards';
import type { RepoMapState } from './mapRun';
import type { ManagerHost, Runtime } from './manager';

/** One board column: a repo and every one of its agent rows (missing repo -> []). */
export interface RepoBoard {
  root: string;
  name: string;
  workspace: boolean;
  missing: boolean;
  defaultModel: string;
  rows: AgentRow[];
  /** S15: the repo's architecture-map status (none/ready/building/failed + staleness). */
  map: RepoMapState;
  tickets: TicketRow[]; // Folds board: every ticket of the repo (Triage/Todo columns; a launched one carries its fold)
  /** The checkout that owns this repository's tickets, folds and apply. Equal to
   *  `root` unless someone set a primary, so the default reads as it always did. */
  primary: string;
  /** Repo cards: entries sharing a git COMMON dir are ONE repository, so they draw
   *  one card. '' only when git could not be asked yet (the card stands alone). */
  groupId: string;
  /** The primary checkout's current branch ('' = detached or not resolved yet). */
  branch: string;
}

export interface BoardCtx {
  host: ManagerHost;
  runtime: Map<string, Runtime>;
  composed(): RepoEntry[];
  primaryOf(root: string): string;
  mapState(root: string): RepoMapState;
  /** root -> {groupId, branch}, filled asynchronously by repoCards.refreshIdents
   *  (git is a subprocess; this projection is synchronous). Missing = not asked yet. */
  idents: ReadonlyMap<string, RepoIdent>;
}

/** S6c roster pre-fill: a fresh window's persisted roster is empty or only the
 *  engine-default entry, so a new user opening the board sees Tsuru and nothing
 *  else. Seed it from ANY live session the panel already has (the user's open
 *  chat qualifies) via the same mapping as agentModes. mergeAgentTypes is a
 *  UNION, so this never shrinks a richer persisted roster - and the guard below
 *  skips entirely once the roster has any real (non-default) option. Called from
 *  the broadcast so it rides every amState, and is a no-op when no live session
 *  knows its modes yet. */
function prefillRoster(host: ManagerHost): void {
  const roster = host.agentTypes();
  if (roster.some((t) => !t.default)) return; // already has a pickable option - leave it
  const harvested = host.harvestAnySessionModes();
  if (!harvested || harvested.length === 0) return; // nothing live yet: degrade unchanged
  const merged = mergeAgentTypes(roster, harvested);
  if (merged) host.saveAgentTypes(merged);
}

/** The one broadcast shape: every composed repo, every time. A missing repo
 *  carries no rows. Any state change anywhere posts a full board. */
export function broadcastBoard(ctx: BoardCtx): void {
  prefillRoster(ctx.host); // S6c: seed an empty roster from a live session before we send it
  const list = ctx.composed();
  const repos: RepoBoard[] = list.map((e) => {
    // Everything below reads the PRIMARY, not the entry root: two registered
    // checkouts of one repository must show the same tickets and the same folds.
    const work = e.missing ? e.root : ctx.primaryOf(e.root);
    const ident = ctx.idents.get(work);
    return {
      root: e.root, name: e.name, workspace: e.workspace, missing: e.missing,
      defaultModel: e.missing ? '' : (loadState(work).defaultModel ?? ''),
      rows: e.missing ? [] : buildRows(work, ctx.runtime, ctx.host, ticketTitles(work)),
      map: ctx.mapState(work),
      tickets: e.missing ? [] : boardTickets(work, (id) => isSpecActive(work, id)),
      primary: work,
      groupId: ident?.groupId ?? '',
      branch: ident?.branch ?? '',
    };
  });
  ctx.host.post({ type: 'amState', repos, noRepo: list.length === 0, autoApprove: ctx.host.autoApprove(), agentTypes: ctx.host.agentTypes(), displayNames: ctx.host.repoDisplayNames() });
}
