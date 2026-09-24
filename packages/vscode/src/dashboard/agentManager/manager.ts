// The fleet owner behind the kanban board. Each agent is an ordinary engine session whose
// cwd is an isolated git worktree; the manager owns the worktree lifecycle + registry,
// drives the initial prompt, and broadcasts row state. The board shows every registered
// repo's rows at once, split not-started/in-progress/done; a task can pin a model
// per-session (never the chat picker's global-default machinery, which would evict the
// user's live chat).

import * as fs from 'node:fs';
import { listWorktrees, removeWorktree } from './worktrees';
import { loadState, saveState, reconcile, type WorktreeRecord } from './state';
import { readWorktreeStats, statsKey, POLL_VISIBLE_MS, POLL_HIDDEN_MS, type WorktreeGitStats } from './pollers';
import { composeRepoList, findEntry, repoKey, type RepoEntry } from './registry';
import { runCreate, runStart, startAllQueued, openChat, type RunContext } from './run';
import { runFanout } from './fanout';
import { ApplyController } from './apply';
import { setRepoDefault, setRepoDisplayName, updateQueued, onAddRepo, onRemoveRepo, type RepoOpsContext, type RepoRegistryContext } from './repoOps';
import { handleRaceFileDiffs, handleCrossDiff, type RaceCompareContext } from './raceCompare';
import { ensureArchetypes } from './archetypes';
import { runMap, cancelMap, refreshAllMapStatus, boardMapState, type MapRun, type MapCtx, type RepoMapState } from './mapRun';
import { handleTicketMessage, stampActivity, ticketsChanged, unlinkTicket } from './tickets';
import { reconcileMergedTickets } from './ticketMerges';
import { runSpec } from './specRun';
import { broadcastBoard, type BoardCtx } from './board';
import { adoptForeign, handleRepoCardMessage, refreshIdents, type RepoCardCtx, type RepoIdent } from './repoCards';
import { primaryFor, registeredName } from './repoFile';
import { onRepointRepo } from './repoRepoint';
import type { ManagerHost } from './host';

// The run lifecycle lives in run.ts; re-exported here so long-standing importers keep
// working unchanged.
export { findSetupScript } from './setupScript';
export type { ManagerHost } from './host';
export type { AgentRow } from './rows';
// The amState projection moved to board.ts (repo cards) when every field had to
// start resolving the repo's PRIMARY checkout; re-exported for its importers.
export type { RepoBoard } from './board';

export type AgentRunState = 'provisioning' | 'working' | 'idle' | 'error' | 'detached' | 'queued';

export interface Runtime {
  state: AgentRunState;
  sessionId?: string;
  agentName?: string;
  model?: string;
  stopReason?: string;
  errorDetail?: string;
  setupNote?: string;
  startedAt?: number;
  stats?: WorktreeGitStats;
  statsKey?: string;
  /** An engine QUESTION is pending with no mounted view; rides the broadcast as a "needs you"
   *  chip. */
  needsYou?: { kind: 'question'; preview: string };
  activity?: string; // Folds board: this fold's live one-line "doing now" (ACP events; rows.ts shows it on working rows only)
}

export class AgentManager {
  private readonly host: ManagerHost;
  private readonly runtime = new Map<string, Runtime>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollInFlight = false;
  private boardVisible = false;
  private readonly reconciled = new Set<string>(); // roots boot-reconciled, per repo
  /** Repos already broadcast as missing (folder vanished) - so the poll flips a
   *  column to missing exactly once instead of re-broadcasting every tick. */
  private readonly missingSeen = new Set<string>();
  private disposed = false;
  /** Records with a create/delete in flight - remove() refuses re-entry and
   *  a second delete click is a quiet no-op instead of a spurious error. */
  private readonly busy = new Set<string>();
  /** Cancel-during-provisioning: create() checks this between its awaits
   *  (the session doesn't exist yet, so there is nothing to cancel() on). */
  private readonly cancelRequested = new Set<string>();
  /** Cards mid-reopen (Chat on a dead session) - a double-click reopens once. */
  private readonly reopening = new Set<string>();
  /** S15 cartographer: in-flight map runs + cached on-disk map status, per repoKey. */
  private readonly mapRuns = new Map<string, MapRun>();
  private readonly mapStatus = new Map<string, RepoMapState>();
  /** Repo cards: primary-checkout path -> which repository/branch, refreshed on the
   *  map-status beat and read synchronously by the broadcast. */
  private readonly idents = new Map<string, RepoIdent>();
  /** Diff-view + apply-to-main flow (S4). Validates root/id via actionRoot and
   *  refuses while the record is busy/reopening; no state writes of its own. */
  private readonly apply: ApplyController;

  constructor(host: ManagerHost) {
    this.host = host;
    // S9: seed the Folds archetypes into the global agent dir before any session.
    ensureArchetypes({ marker: host.archetypeMarker() });
    this.apply = new ApplyController({
      host,
      validateRoot: (raw) => this.actionRoot(raw),
      record: (root, id) => this.record(root, id),
      busy: (id) => this.busy.has(id) || this.reopening.has(id), broadcast: () => this.broadcast(),
      promotable: (id) => { const rt = this.runtime.get(id) ?? { state: 'detached' as AgentRunState }; const s = rt.state; return s === 'idle' || s === 'error' || s === 'detached' || (s === 'working' && (!rt.sessionId || !this.host.sessionAlive(rt.sessionId))); },
    });
  }

  /** Stop the poll loop permanently; an in-flight pollOnce checks `disposed` before re-arming,
   *  so the loop can't resurrect itself. */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Route an `am*` webview message. Fire-and-forget from the panel switch. */
  async handle(m: { type?: string; [k: string]: unknown }): Promise<void> {
    const rootOf = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
    switch (m.type) {
      case 'amRequestState': await this.onRequestState(); return;
      case 'amAddRepo': await onAddRepo(this.repoRegistryCtx()); return;
      case 'amRemoveRepo': onRemoveRepo(this.repoRegistryCtx(), rootOf(m.root)); return;
      case 'amRepointRepo': await onRepointRepo(this.repoRegistryCtx(), rootOf(m.root)); return;
      case 'amSetRepoDefault': setRepoDefault(this.repoOpsCtx(), rootOf(m.root), String(m.model ?? '')); return;
      case 'amRenameRepo': setRepoDisplayName(this.repoOpsCtx(), rootOf(m.root), String(m.displayName ?? '')); return;
      case 'amSetAutoApprove': this.host.setAutoApprove(m.on === true); this.broadcast(); return;
      case 'amDiffFiles': case 'amOpenFileDiff': case 'amApply': await this.apply.handle(m); return;
      case 'amRaceFileDiffs': await handleRaceFileDiffs(this.raceCtx(), m); return;
      case 'amCrossDiff': handleCrossDiff(this.raceCtx(), m); return;
      case 'amVisible': this.boardVisible = m.visible === true; this.schedulePoll(this.boardVisible ? 0 : POLL_HIDDEN_MS); return;
      case 'amCreate': {
        const root = this.actionRoot(m.root);
        if (!root) return;
        const start = m.start !== false; // start missing/true = run now; false = queue
        // A non-empty variants array = a multi-model race (S5): fan the ONE task
        // across sibling agents. Else today's single create-and-run / queue path.
        if (Array.isArray(m.variants) && m.variants.length > 0) {
          const variants = (m.variants as Array<Record<string, unknown>>).map((v) => ({ agentName: String(v.agentName ?? ''), model: String(v.model ?? '') }));
          await runFanout(this.runCtx(), root, String(m.name ?? ''), String(m.prompt ?? ''), variants, start);
        } else {
          await runCreate(this.runCtx(), root, String(m.name ?? ''), String(m.agentName ?? ''), String(m.prompt ?? ''), String(m.model ?? ''), start);
        }
        return;
      }
      case 'amStart': {
        const root = this.actionRoot(m.root);
        if (root) await runStart(this.runCtx(), root, String(m.id));
        return;
      }
      case 'amStartAll': {
        const root = this.actionRoot(m.root);
        if (root) startAllQueued(this.runCtx(), root);
        return;
      }
      case 'amUpdateQueued': {
        const root = this.actionRoot(m.root);
        if (root) updateQueued(this.repoOpsCtx(), root, String(m.id), m);
        return;
      }
      case 'amCancel': {
        const root = this.actionRoot(m.root);
        if (!root) return;
        const id = String(m.id);
        const rt = this.runtime.get(id);
        // Provisioning (including the model-pin RPC window): flag the in-flight create to tear down
        // at its next checkpoint, since a one-shot cancelSession() here would be dropped.
        if (rt?.state === 'provisioning') { this.cancelRequested.add(id); this.broadcast(); }
        else if (rt?.sessionId) {
          await this.host.cancelSession(rt.sessionId);
        }
        return; // state settles when the in-flight prompt/create resolves
      }
      case 'amOpenChat': {
        const root = this.actionRoot(m.root);
        if (root) await openChat(this.runCtx(), root, String(m.id));
        return;
      }
      case 'amOpenTerminal': {
        const root = this.actionRoot(m.root);
        const rec = root ? this.record(root, String(m.id)) : undefined;
        if (rec) this.host.openTerminal(rec.path, `Agent: ${rec.name}`);
        return;
      }
      case 'amDelete': {
        const root = this.actionRoot(m.root);
        if (root) await this.remove(root, String(m.id), m.deleteBranch === true);
        return;
      }
      case 'amTicketQuickAdd': case 'amTicketOpen': case 'amTicketLaunch': case 'amTicketClose': case 'amTicketSpec': await handleTicketMessage({ run: this.runCtx(), validateRoot: (r) => this.actionRoot(r), broadcast: () => this.broadcast(), create: runCreate, fanout: runFanout, spec: runSpec, repoName: (r) => { const e = findEntry(this.composed(), String(r ?? '')); return e ? registeredName(e.root) ?? e.name : ''; } }, m); return;
      case 'amMapRepo': { const root = this.actionRoot(m.root); if (root) await runMap(this.mapCtx(), root); return; }
      case 'amCancelMap': { const root = this.actionRoot(m.root); if (root) cancelMap(this.mapCtx(), root); return; }
      case 'amRepoWorktrees': case 'amMakePrimary': case 'amWorktreeTerminal': case 'amWorktreeChat':
        await handleRepoCardMessage({ host: this.host, validateRoot: (r) => this.actionRoot(r), broadcast: () => this.broadcast() } satisfies RepoCardCtx, m); return;
    }
  }

  /** The window the cartographer map lifecycle (mapRun.ts) drives the owner through. */
  private mapCtx(): MapCtx {
    return { host: this.host, mapRuns: this.mapRuns, mapStatus: this.mapStatus, broadcast: () => this.broadcast() };
  }

  private composed(): RepoEntry[] {
    return composeRepoList(this.host.repoRoot(), this.host.knownRepos());
  }

  private repoUnavailable(root: string | undefined): void {
    this.host.post({ type: 'amError', message: `Repository not available: ${root ?? '(none)'}` });
  }

  /** Resolve a scoped action's target repo: the message root must name a composed,
   *  non-missing repo (else amError). Resolves to that repository's PRIMARY checkout so every
   *  scoped action lands where the work lives. */
  private actionRoot(raw: unknown): string | undefined {
    const asked = raw === undefined || raw === null || String(raw) === '' ? undefined : String(raw);
    const entry = asked !== undefined ? findEntry(this.composed(), asked) : undefined;
    if (!entry || entry.missing) { this.repoUnavailable(asked); return undefined; }
    return primaryFor(entry.root);
  }

  /** Every non-missing repo's PRIMARY checkout - the roots the map status, the
   *  reconcile, the poll and the ident cache all work against. */
  private workRoots(): string[] {
    return [...new Set(this.composed().filter((e) => !e.missing).map((e) => primaryFor(e.root)))];
  }

  private async onRequestState(): Promise<void> {
    adoptForeign(this.host); // repos.json entries the engine registered become cards
    for (const root of this.workRoots()) await this.ensureReconciled(root);
    await refreshAllMapStatus(this.mapCtx(), this.workRoots());
    await refreshIdents(this.workRoots(), this.idents);
    this.broadcast();
    this.schedulePoll(0);
  }

  /** The wider context the repo add/remove handlers (moved to repoOps to keep this file under
   *  cap) drive the owner through. */
  private repoRegistryCtx(): RepoRegistryContext {
    return {
      host: this.host,
      runtime: this.runtime,
      busy: this.busy,
      reconciled: this.reconciled,
      missingSeen: this.missingSeen,
      composed: () => this.composed(),
      ensureReconciled: (root) => this.ensureReconciled(root),
      schedulePoll: (d) => this.schedulePoll(d),
      broadcast: () => this.broadcast(),
      mapRunning: (root) => this.mapRuns.has(repoKey(root)),
    };
  }

  /** The narrow context the repoOps mutations (setRepoDefault / updateQueued,
   *  extracted to keep this file under cap) drive the owner through. */
  private repoOpsCtx(): RepoOpsContext {
    return {
      composed: () => this.composed(),
      repoUnavailable: (r) => this.repoUnavailable(r),
      host: this.host,
      runtime: this.runtime,
      busy: this.busy,
      broadcast: () => this.broadcast(),
    };
  }

  /** The compare handlers' window (S6c): the host, the shared actionRoot
   *  validator, and the record lookup - no state of its own. */
  private raceCtx(): RaceCompareContext {
    return { host: this.host, validateRoot: (raw) => this.actionRoot(raw), record: (root, id) => this.record(root, id) };
  }

  /** Boot reconciliation (once per window per repo): registry vs live worktrees.
   *  Records that survive a reload have no session - they show as detached. */
  private async ensureReconciled(raw: string): Promise<void> {
    // Reconcile the PRIMARY, not the entry root: that's where fold worktrees and the state file
    // live. Keyed by the primary too, so two registered checkouts of one repository reconcile
    // once.
    const root = primaryFor(raw);
    if (this.reconciled.has(repoKey(root))) return;
    this.reconciled.add(repoKey(root));
    // Read state AFTER listWorktrees resolves: a real await during which another window can
    // write. loadState -> reconcile -> saveState is synchronous, so no write can slip between
    // and blind-overwrite a concurrent one.
    const live = await listWorktrees(root);
    const result = reconcile(loadState(root), live, root);
    saveState(root, result.state);
    for (const rec of result.state.worktrees) {
      // A reloaded record seeds by priority: a queued task -> 'queued'; else a completed run ->
      // 'idle' with its stopReason; else a record that ran but has no done marker -> 'error'
      // (engine died mid-run), never a benign 'detached'; else (never ran) 'detached'.
      if (!this.runtime.has(rec.id)) {
        this.runtime.set(rec.id, rec.queuedTask
          ? { state: 'queued', agentName: rec.queuedTask.agentName, model: rec.queuedTask.model }
          : rec.done
            ? { state: 'idle', stopReason: rec.done.stopReason, startedAt: rec.done.at }
            : rec.sessions.length > 0
              ? { state: 'error', errorDetail: 'run never completed (engine gone)' }
              : { state: 'detached' });
      }
    }
  }

  private record(root: string, id: string): WorktreeRecord | undefined {
    return loadState(root).worktrees.find((r) => r.id === id);
  }

  /** The narrow window the run.ts lifecycle drives the owner through; built per call, holds
   *  no state of its own. */
  private runCtx(): RunContext {
    return {
      host: this.host,
      runtime: this.runtime,
      busy: this.busy,
      cancelRequested: this.cancelRequested,
      reopening: this.reopening,
      patch: (id, p) => this.patch(id, p),
      broadcast: () => this.broadcast(),
      record: (root, id) => this.record(root, id),
    };
  }

  private async remove(root: string, id: string, deleteBranch: boolean): Promise<void> {
    // A Chat reopen is spawning an engine child into this worktree; a delete now races the spawn (leaking the new session, then resurrecting a stale runtime row) - retry once it settles.
    if (this.reopening.has(id)) { this.host.post({ type: 'amError', message: 'This agent is reopening its chat — try again in a moment.' }); return; }
    // A create is mid-flight for this record (no session to close yet, and the
    // registry write would race it) - the user's lever is Cancel, not Delete.
    if (this.busy.has(id)) {
      const rt = this.runtime.get(id);
      if (rt?.state === 'provisioning') {
        // A START's provisioning window keeps the pre-existing worktree on Cancel
        // (its record still holds the queuedTask); a CREATE's tears it down.
        const starting = this.record(root, id)?.queuedTask !== undefined;
        this.host.post({ type: 'amError', message: starting
          ? 'This agent is starting — use Cancel; it keeps the worktree and its queued task.'
          : 'This agent is still being created — use Cancel; it tears the worktree down.' });
      }
      return; // a delete already in flight: quiet no-op (double-click)
    }
    const rec = this.record(root, id);
    if (!rec) return;
    this.busy.add(id);
    try {
      await this.removeInner(root, rec, id, deleteBranch);
    } finally {
      this.busy.delete(id);
    }
  }

  private async removeInner(root: string, rec: WorktreeRecord, id: string, deleteBranch: boolean): Promise<void> {
    const rt = this.runtime.get(id);
    // Kill the engine child FIRST or `git worktree remove` fights its file locks.
    if (rt?.sessionId && this.host.sessionAlive(rt.sessionId)) this.host.closeSession(rt.sessionId);
    const res = await removeWorktree(root, rec.path, { deleteBranch: deleteBranch && rec.branch ? rec.branch : undefined });
    if (!res.ok) {
      this.host.post({ type: 'amError', message: `Delete failed: ${res.detail}` });
      this.broadcast();
      return;
    }
    const state = loadState(root);
    state.worktrees = state.worktrees.filter((r) => r.id !== id);
    saveState(root, state);
    if (!rec.merged && rec.ticketId) unlinkTicket(root, rec.ticketId, 'fold deleted before it was applied'); // un-merged work goes back to Todo
    this.runtime.delete(id);
    this.broadcast();
  }

  private patch(id: string, patch: Partial<Runtime>): void {
    this.runtime.set(id, { ...(this.runtime.get(id) ?? { state: 'detached' }), ...patch });
  }

  /** Set/clear a background agent row's pending-QUESTION flag, keyed by its live session.
   *  Broadcast so the "needs you" chip tracks it; a no-op off a live run. */
  setAgentQuestion(sessionId: string, preview: string | null): void {
    let id: string | undefined;
    for (const [rid, rt] of this.runtime) if (rt.sessionId === sessionId) { id = rid; break; }
    if (!id) return;
    this.patch(id, { needsYou: preview ? { kind: 'question', preview } : undefined });
    this.broadcast();
  }

  /** Folds board: an ACP event -> this fold's live "doing now" line. tickets.ts owns the session reverse-lookup (a session we don't own is a no-op) + the >=2s broadcast throttle. */
  foldActivity(sessionId: string, line: string): void { if (stampActivity(this.runtime, sessionId, line)) this.broadcast(); }

  // ---- board state ----

  /** The amState projection lives in board.ts; this is the window it reads the owner through. */
  private broadcast(): void {
    broadcastBoard({
      host: this.host, runtime: this.runtime, composed: () => this.composed(),
      primaryOf: (root) => primaryFor(root), mapState: (root) => boardMapState(this.mapCtx(), root),
      idents: this.idents,
    } satisfies BoardCtx);
  }

  // ---- git stats poller (5s visible / 60s hidden, change-suppressed) ----

  private schedulePoll(delayMs: number): void {
    if (this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { void this.pollOnce(); }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    // Single-flight: amRequestState + amVisible on board open can both fire a
    // 0ms schedule - the in-flight run owns the re-arm, a second entry drops.
    if (this.disposed || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      let changed = false;
      for (const e of this.composed()) {
        if (this.disposed) return;
        const key = repoKey(e.root);
        if (e.missing) {
          // A repo we HAD shown whose folder/.git vanished: flip its column to
          // missing (rows already gone from composed) exactly once.
          if (this.reconciled.has(key) && !this.missingSeen.has(key)) { this.missingSeen.add(key); changed = true; }
          continue;
        }
        this.missingSeen.delete(key); // came back -> re-arm the one-shot
        const work = primaryFor(e.root); // tickets + records live at the primary
        if (ticketsChanged(work)) changed = true; // a ticket written by an agent, a hand edit, or another window
        if (await reconcileMergedTickets(work)) changed = true; // git says a branch landed: stamp the ticket merged
        for (const rec of loadState(work).worktrees) {
          if (this.disposed) return;
          if (!fs.existsSync(rec.path)) continue;
          const stats = await readWorktreeStats(rec.path, rec.baseSha);
          const skey = statsKey(stats);
          const rt = this.runtime.get(rec.id);
          if (rt?.statsKey !== skey) {
            this.patch(rec.id, { stats, statsKey: skey });
            changed = true;
          }
        }
      }
      // Recompute map staleness (behind N) on the same beat as repo cards — a branch checked out
      // in another window has to reach the card, and git is a subprocess the broadcast can't skip.
      if (!this.disposed && await refreshAllMapStatus(this.mapCtx(), this.workRoots())) changed = true;
      if (!this.disposed && await refreshIdents(this.workRoots(), this.idents)) changed = true;
      if (changed && !this.disposed) this.broadcast();
    } finally {
      this.pollInFlight = false;
    }
    this.schedulePoll(this.boardVisible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  }
}
