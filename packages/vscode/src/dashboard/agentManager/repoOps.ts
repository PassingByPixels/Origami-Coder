// Repo-scoped registry mutations extracted from manager.ts: the two small state ops
// (setRepoDefault/updateQueued) plus the hub add/remove-repo handlers.

import { loadState, saveState } from './state';
import { findEntry, isGitRepo, normalizeRepoPath, repoKey, type RepoEntry } from './registry';
import { dropEntry, primaryFor, updateRepoFile } from './repoFile';
import type { ManagerHost, Runtime } from './manager';

export interface RepoOpsContext {
  composed(): RepoEntry[];
  repoUnavailable(root: string | undefined): void;
  host: ManagerHost;
  runtime: Map<string, Runtime>;
  busy: Set<string>;
  broadcast(): void;
}

/** Set (or clear, when model === '') a repo's default model, persisted to its
 *  own state file so a fresh agent with no per-task pick inherits it. */
export function setRepoDefault(ctx: RepoOpsContext, root: string | undefined, model: string): void {
  const entry = findEntry(ctx.composed(), root);
  if (!entry || entry.missing) { ctx.repoUnavailable(root); return; }
  const work = primaryFor(entry.root); // the state file lives with the primary checkout
  const state = loadState(work);
  if (model) state.defaultModel = model; else delete state.defaultModel;
  saveState(work, state);
  ctx.broadcast();
}

/** Edit a queued record's stored task in place. Valid only while it has a queuedTask and
 *  nothing in flight for it (else amError, no side effects); model may be set to '' to
 *  resolve the repo default at start time. */
export function updateQueued(ctx: RepoOpsContext, root: string, id: string, m: { [k: string]: unknown }): void {
  const state = loadState(root);
  const rec = state.worktrees.find((r) => r.id === id);
  if (!rec?.queuedTask || ctx.busy.has(id)) {
    ctx.host.post({ type: 'amError', message: 'This agent has no queued task to edit.' });
    return;
  }
  if (m.prompt !== undefined) rec.queuedTask.prompt = String(m.prompt);
  if (m.agentName !== undefined) rec.queuedTask.agentName = String(m.agentName);
  if (m.model !== undefined) rec.queuedTask.model = String(m.model);
  saveState(root, state);
  // Reflect the edited agent/model on the runtime so the queued card re-reads
  // the same values (the row's queuedPrompt comes straight from the record).
  const rt = ctx.runtime.get(id);
  if (rt) ctx.runtime.set(id, { ...rt, agentName: rec.queuedTask.agentName, model: rec.queuedTask.model });
  ctx.broadcast();
}

/** The wider context the hub add/remove-repo handlers drive the owner through:
 *  reconciliation + poll hooks and the one-shot sets, shared by reference. */
export interface RepoRegistryContext {
  host: ManagerHost;
  runtime: Map<string, Runtime>;
  busy: Set<string>;
  reconciled: Set<string>;
  missingSeen: Set<string>;
  composed(): RepoEntry[];
  ensureReconciled(root: string): Promise<void>;
  schedulePoll(delayMs: number): void;
  broadcast(): void;
  /** True while a cartographer map run is in flight for this repo (a run holds no
   *  worktree record, so repoHasLiveWork can't see it - the manager reports it). */
  mapRunning(root: string): boolean;
}

/** True while any of the repo's records is mid-create or actively running. */
export function repoHasLiveWork(ctx: RepoRegistryContext, root: string): boolean {
  return loadState(primaryFor(root)).worktrees.some((rec) => {
    if (ctx.busy.has(rec.id)) return true;
    const st = ctx.runtime.get(rec.id)?.state;
    return st === 'provisioning' || st === 'working';
  });
}

/** Add a repo to the hub via the folder picker: reject a non-git dir, dedupe
 *  against the known list + the workspace, reconcile before the first broadcast. */
export async function onAddRepo(ctx: RepoRegistryContext): Promise<void> {
  const picked = await ctx.host.pickRepoFolder();
  if (picked === undefined) return; // cancelled - board untouched (no broadcast)
  const root = normalizeRepoPath(picked);
  if (!isGitRepo(root)) { ctx.host.post({ type: 'amError', message: `Not a git repository: ${root}` }); return; }
  const known = ctx.host.knownRepos();
  const key = repoKey(root);
  const dup = known.some((k) => repoKey(normalizeRepoPath(k)) === key) || ctx.composed().some((e) => e.workspace && repoKey(e.root) === key);
  if (!dup) ctx.host.saveKnownRepos([...known, root]);
  await ctx.ensureReconciled(root); // reconcile the new repo before its rows first broadcast
  ctx.broadcast();
  ctx.schedulePoll(0);
}

/** Rename how a repo is DISPLAYED on the board — never the real `name` a ticket file or the
 *  engine's board_* tools key by, and never written to disk. Empty/whitespace clears the
 *  override. */
export function setRepoDisplayName(ctx: RepoOpsContext, root: string | undefined, displayName: string): void {
  const entry = findEntry(ctx.composed(), root);
  if (!entry) { ctx.repoUnavailable(root); return; }
  const trimmed = displayName.trim();
  const names = { ...ctx.host.repoDisplayNames() };
  if (trimmed && trimmed !== entry.name) names[entry.root] = trimmed; else delete names[entry.root];
  ctx.host.saveRepoDisplayNames(names);
  ctx.broadcast();
}

/** Unregister a repo from the hub (never touches disk). Refuses while it has an in-flight
 *  create or a live session, so work is never orphaned. */
export function onRemoveRepo(ctx: RepoRegistryContext, root: string | undefined): void {
  if (!root) return;
  const target = normalizeRepoPath(root);
  const key = repoKey(target);
  // Read the primary BEFORE the entry is dropped: reconciliation is keyed by primary, so
  // clearing only `key` would leave a re-added repo un-reconciled against a drifted disk.
  const work = repoKey(primaryFor(target));
  if (findEntry(ctx.composed(), root)?.workspace) return; // the window's own repo isn't in the list
  if (repoHasLiveWork(ctx, target)) {
    ctx.host.post({ type: 'amError', message: 'This repo has active agents — Cancel or Delete them before unregistering.' });
    return;
  }
  if (ctx.mapRunning(target)) {
    ctx.host.post({ type: 'amError', message: 'This repo is being mapped — Cancel the map before unregistering.' });
    return;
  }
  const known = ctx.host.knownRepos();
  const filtered = known.filter((k) => repoKey(normalizeRepoPath(k)) !== key);
  if (filtered.length !== known.length) ctx.host.saveKnownRepos(filtered); // never touches disk
  // repos.json is shared now, so unregistering has to say so explicitly, or the entry
  // survives and adopt-on-read puts the repo straight back.
  updateRepoFile((doc) => dropEntry(doc, target));
  ctx.reconciled.delete(key); // a re-add must re-reconcile registry vs (possibly drifted) disk
  ctx.reconciled.delete(work);
  ctx.missingSeen.delete(key);
  ctx.broadcast();
}
