// The amState broadcast: the one place a RepoBoard is built. Two responsibilities: the
// roster pre-fill that must run before a board is sent, and the projection itself, both
// driven through a narrow BoardCtx. The PRIMARY rule: a registered entry is a place on disk;
// the work (tickets, folds, state, apply target) belongs to that repo's primary checkout.

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

/** Roster pre-fill: a fresh window's persisted roster is often just the default entry, so
 *  seed it from any live session's modes (a union, never shrinking a richer roster). Runs on
 *  every broadcast; a no-op once the roster has a real option. */
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
