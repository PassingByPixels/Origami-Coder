// Agent Manager - repoOps.ts (S4/S5): repo-scoped registry mutations extracted
// from manager.ts to keep the owner under its line cap. S4 moved the two small
// state ops (setRepoDefault / updateQueued); S5 additionally moves the hub
// add/remove-repo handlers (onAddRepo / onRemoveRepo, their natural home) to
// reclaim room for the fan-out routing. Verbatim behaviour moves - only `this.*`
// became `ctx.*`; the AgentManager builds the narrow contexts these drive it
// through. No new behaviour lives here.

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

/** Edit a queued record's stored task in place (amUpdateQueued). Valid only
 *  while the record HAS a queuedTask and nothing is in flight for it (else
 *  amError, NO side effects). Only the provided fields are changed; model may
 *  be set to '' ("repo default resolved at start time"). run.ts is untouched -
 *  a later amStart re-reads the edited task straight from the state file. */
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
 *  reconciliation + poll hooks and the reconciled/missingSeen one-shot sets
 *  (shared by reference so their deletes reach the manager's sets). */
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
function repoHasLiveWork(ctx: RepoRegistryContext, root: string): boolean {
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

/** Rename how a repo is DISPLAYED on the board (the pill/header label) — never
 *  the real `name` a ticket file or the engine's board_* tools key by, and never
 *  written to the repo/folder itself. Empty/whitespace clears the override back
 *  to the real name. Refuses only when the root isn't a composed repo at all. */
export function setRepoDisplayName(ctx: RepoOpsContext, root: string | undefined, displayName: string): void {
  const entry = findEntry(ctx.composed(), root);
  if (!entry) { ctx.repoUnavailable(root); return; }
  const trimmed = displayName.trim();
  const names = { ...ctx.host.repoDisplayNames() };
  if (trimmed && trimmed !== entry.name) names[entry.root] = trimmed; else delete names[entry.root];
  ctx.host.saveRepoDisplayNames(names);
  ctx.broadcast();
}

/** Unregister a repo from the hub (never touches disk). Refuses while it has an
 *  in-flight create or a live session (that work would be orphaned); the
 *  workspace's own repo is never on the list. Clears its one-shot reconcile/
 *  missing markers so a re-add re-reconciles registry vs (possibly drifted) disk. */
export function onRemoveRepo(ctx: RepoRegistryContext, root: string | undefined): void {
  if (!root) return;
  const target = normalizeRepoPath(root);
  const key = repoKey(target);
  // Read the primary BEFORE the entry is dropped below: ensureReconciled keys its
  // one-shot by the PRIMARY, so clearing only `key` would leave a re-added repo
  // un-reconciled against a disk that drifted while it was gone.
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
  // repos.json is a SHARED file now, so its sync PRESERVES what the extension
  // does not compose. Unregistering therefore has to say so explicitly - else the
  // entry survives and adopt-on-read puts the repo straight back on the board.
  updateRepoFile((doc) => dropEntry(doc, target));
  ctx.reconciled.delete(key); // a re-add must re-reconcile registry vs (possibly drifted) disk
  ctx.reconciled.delete(work);
  ctx.missingSeen.delete(key);
  ctx.broadcast();
}
