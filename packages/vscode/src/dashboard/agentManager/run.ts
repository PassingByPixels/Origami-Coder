// Agent Manager - run.ts (S3.7): the agent-run lifecycle, extracted from
// manager.ts (which keeps only routing, board shape, repos and the poller) so
// the owner stays under its line cap while the queue lands. Each function takes
// a narrow RunContext the AgentManager builds (host + shared runtime/busy/cancel
// maps + patch/broadcast/record). runCreate provisions a worktree+record, runs
// the optional setup script, then EITHER starts it now (start:true: session ->
// pin -> prompt -> idle) OR persists the task and settles 'queued' (start:false,
// no session). runStart runs a queued record's task: session -> pin (effective =
// queuedTask.model || repo default || none) -> clear the task -> working ->
// prompt -> idle. A create Cancel tears the half-built agent fully down; a start
// Cancel does NOT (the worktree pre-existed it) - close the session, restore
// 'queued', task untouched.

import { findSetupScript } from './setupScript';
import { createWorktree, removeWorktree } from './worktrees';
import { loadState, saveState, newWorktreeRecordId, type WorktreeRecord } from './state';
import { runGate } from '../chatCommands';
import { syncAgentType } from './agentTypes';
import { completeRun } from './completion';
import { withMapBrief } from './mapRun';
import { stampFold, unlinkTicket } from './tickets';
import type { ManagerHost, Runtime } from './manager';
const SETUP_TIMEOUT_MS = 300_000;

/** The lifecycle's window into the owner: host, the shared runtime/busy/cancel maps, and patch/broadcast/record. */
export interface RunContext {
  host: ManagerHost;
  ticketId?: string; // Folds board: the ticket a LAUNCH provisions for - set ONLY on the ctx the ticket layer hands to runCreate/runFanout, so race siblings all link to one ticket and fanout.ts never learns tickets exist
  runtime: Map<string, Runtime>;
  busy: Set<string>;
  cancelRequested: Set<string>;
  /** Cards mid-reopen (Chat on a dead session) - a double-click reopens once. */
  reopening: Set<string>;
  patch(id: string, patch: Partial<Runtime>): void;
  broadcast(): void;
  record(root: string, id: string): WorktreeRecord | undefined;
}

/** Resolve the model to pin: the raw per-task pick, else the repo default, else
 *  none. Read at use time so a later default change still applies to a queued
 *  task that named no model of its own. */
export function effectiveModel(root: string, taskModel: string): string {
  return taskModel || (loadState(root).defaultModel ?? '');
}

/** Drop a record's completion markers (done AND merged) — a restart is no longer
 *  done. No-op when both absent, so a fresh start never rewrites the file. */
function clearCompletion(root: string, id: string): void {
  const state = loadState(root);
  const rec = state.worktrees.find((r) => r.id === id);
  if (rec?.done || rec?.merged) { delete rec.done; delete rec.merged; saveState(root, state); }
}

export async function runCreate(
  ctx: RunContext, root: string, rawName: string, agentName: string, prompt: string, model: string, start: boolean, groupId?: string,
): Promise<void> {
  const { host } = ctx;
  let recId = '';
  let sessionId: string | undefined;
  const effModel = effectiveModel(root, model);
  try {
    const created = await createWorktree(root, rawName || 'agent');
    const state = loadState(root);
    recId = newWorktreeRecordId();
    const record: WorktreeRecord = {
      id: recId, name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: [], ...(groupId ? { groupId } : {}), ...(ctx.ticketId ? { ticketId: ctx.ticketId } : {}),
    };
    // Queue (start:false): store the task (RAW model pick - repo default is
    // resolved at start time) on the record instead of running it now.
    if (!start) record.queuedTask = { prompt, agentName, model };
    state.worktrees.push(record);
    saveState(root, state);
    stampFold(root, recId, start ? 'in_progress' : 'pending', `fold ${created.name} provisioned`); // ticket launch: link it + take the status the launch implies
    ctx.busy.add(recId);
    ctx.runtime.set(recId, {
      state: start ? 'provisioning' : 'queued',
      agentName, model: start ? effModel : model, startedAt: Date.now(),
    });
    ctx.broadcast();

    // Optional repo setup script, in the worktree, non-fatal (Kilo semantics).
    const setup = findSetupScript(root);
    if (setup) {
      const r = await runGate(setup.command, created.path, SETUP_TIMEOUT_MS);
      ctx.patch(recId, {
        setupNote: r.passed ? `${setup.label} ok` : `${setup.label} FAILED (non-fatal): ${r.output.slice(0, 200)}`,
      });
      ctx.broadcast();
    }
    if (await abortIfCancelled(ctx, root, recId, undefined)) return;

    // Queued: the worktree is provisioned and the task is persisted; do NOT
    // create a session. The card settles 'queued' until amStart.
    if (!start) {
      ctx.busy.delete(recId);
      ctx.broadcast();
      return;
    }

    sessionId = await host.createAgentSession(created.path, agentName || undefined);
    if (await abortIfCancelled(ctx, root, recId, sessionId)) return;
    const st2 = loadState(root);
    const rec = st2.worktrees.find((r) => r.id === recId);
    if (rec) { rec.sessions.push(sessionId); rec.engineSessionId = host.engineSessionId(sessionId); rec.agentName = agentName; saveState(root, st2); }
    ctx.patch(recId, { sessionId }); // record before pinning so a teardown can close it

    // Pin the effective model on THIS session only, before the task runs. A
    // throw here is fatal to the create (never silently run on the wrong
    // model) and lands on the row via the catch as a 'model pin failed' error.
    if (effModel) {
      try {
        await host.setSessionModel(sessionId, effModel);
      } catch (e) {
        throw new Error(`model pin failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Harvest the roster + (typed run only) set the session mode before the prompt; a bad type is fatal.
    await syncAgentType(ctx, sessionId, agentName);
    // A Cancel could have landed during the pin/mode RPCs above (a real await gap).
    if (await abortIfCancelled(ctx, root, recId, sessionId)) return;

    ctx.patch(recId, { state: 'working' });
    ctx.busy.delete(recId); // session is live - cancel/delete work normally now
    ctx.broadcast();

    // Run to completion: the single prompt settles through the shared death-proof
    // resolution + persisted done marker + idle patch (completion.completeRun). A
    // valid repo map prefixes a one-line brief so the agent reads it first (S15).
    await completeRun(ctx, root, recId, sessionId, await withMapBrief(root, prompt));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (recId) {
      // Parity with runStart's catch: tear down any live session and stop the
      // errored card claiming one (else a zombie Session lingers with a dead client).
      if (sessionId && host.sessionAlive(sessionId)) host.closeSession(sessionId);
      ctx.patch(recId, { state: 'error', errorDetail: detail, sessionId: undefined });
    } else host.post({ type: 'amError', message: `Create failed for "${rawName || 'agent'}": ${detail}` });
  } finally {
    if (recId) { ctx.busy.delete(recId); ctx.cancelRequested.delete(recId); }
  }
  ctx.broadcast();
}

/** Cancel checkpoint for the CREATE provisioning window: tears the half-built
 *  agent back down (session if any, worktree, record) and reports. */
export async function abortIfCancelled(
  ctx: RunContext, root: string, recId: string, sessionId: string | undefined,
): Promise<boolean> {
  if (!ctx.cancelRequested.has(recId)) return false;
  ctx.cancelRequested.delete(recId);
  if (sessionId && ctx.host.sessionAlive(sessionId)) ctx.host.closeSession(sessionId);
  const rec = ctx.record(root, recId);
  if (rec) {
    await removeWorktree(root, rec.path, { deleteBranch: rec.branch || undefined });
    const state = loadState(root);
    state.worktrees = state.worktrees.filter((r) => r.id !== recId);
    saveState(root, state);
    if (rec.ticketId) unlinkTicket(root, rec.ticketId, 'create cancelled — fold torn down'); // the fold is gone: the work still has to happen, so the ticket goes back to Todo unlinked
  }
  ctx.runtime.delete(recId);
  ctx.busy.delete(recId);
  ctx.broadcast();
  return true;
}

/** Start a queued record's stored task. Only valid for a record WITH a queued
 *  task and no live session (else amError, no side effects). */
export async function runStart(ctx: RunContext, root: string, id: string): Promise<void> {
  const { host } = ctx;
  const rec = ctx.record(root, id);
  const rt = ctx.runtime.get(id);
  // A live session blocks Start only when it's an ACTIVE run - a reopened
  // Chat-on-Done viewer must not veto retry-Start (it's superseded below).
  const live = (rt?.state === 'provisioning' || rt?.state === 'working') && rt?.sessionId ? host.sessionAlive(rt.sessionId) : false;
  if (!rec?.queuedTask || live || ctx.busy.has(id)) {
    host.post({ type: 'amError', message: 'This agent has no queued task to start.' });
    return;
  }
  const task = rec.queuedTask;
  const effModel = effectiveModel(root, task.model);
  let sessionId: string | undefined;
  ctx.busy.add(id);
  ctx.cancelRequested.delete(id);
  if (rt?.sessionId && host.sessionAlive(rt.sessionId)) host.closeSession(rt.sessionId); // supersede a reopened viewer session, else the fresh run leaks it
  try {
    clearCompletion(root, id); // a (re)start supersedes prior done/merged markers
    // 'provisioning' so the card shows a live Cancel during the start window;
    // amCancel routes it to cancelRequested, honoured by the abort checkpoints
    // below WITHOUT tearing down the pre-existing worktree.
    ctx.patch(id, { state: 'provisioning', agentName: task.agentName, model: effModel, startedAt: Date.now() });
    ctx.broadcast();

    sessionId = await host.createAgentSession(rec.path, task.agentName || undefined);
    if (await abortStartIfCancelled(ctx, root, id, sessionId)) return;
    const st = loadState(root);
    const r2 = st.worktrees.find((r) => r.id === id);
    if (r2) { r2.sessions.push(sessionId); r2.engineSessionId = host.engineSessionId(sessionId); r2.agentName = task.agentName; saveState(root, st); }
    ctx.patch(id, { sessionId });

    if (effModel) {
      try {
        await host.setSessionModel(sessionId, effModel);
      } catch (e) {
        throw new Error(`model pin failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Set the queued task's agent type before the prompt (fatal on a bad type), and
    // BEFORE the queuedTask is cleared below so a failure stays retryable.
    await syncAgentType(ctx, sessionId, task.agentName);
    if (await abortStartIfCancelled(ctx, root, id, sessionId)) return;

    // Clear the queued task ONLY past the last abort checkpoint, so an aborted
    // start never loses it (it stays in the state file until this point).
    const st2 = loadState(root);
    const r3 = st2.worktrees.find((r) => r.id === id);
    if (r3) { delete r3.queuedTask; saveState(root, st2); }
    stampFold(root, id, 'in_progress', 'fold started'); // past every abort point: the ticket is really being worked

    ctx.patch(id, { state: 'working' });
    ctx.busy.delete(id);
    ctx.broadcast();

    // Run to completion (see runCreate): the single prompt settles through the
    // shared death-proof completion; a valid repo map prefixes a brief (S15).
    await completeRun(ctx, root, id, sessionId, await withMapBrief(root, task.prompt));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (sessionId && host.sessionAlive(sessionId)) host.closeSession(sessionId); // no orphan session -> the still-queued task stays retryable
    ctx.patch(id, { state: 'error', errorDetail: detail, sessionId: undefined });
  } finally {
    ctx.busy.delete(id); ctx.cancelRequested.delete(id);
  }
  ctx.broadcast();
}

/** Cancel checkpoint for a START: the worktree pre-existed it, so do NOT remove
 *  it - close any session and restore 'queued' (task stays in the state file). */
async function abortStartIfCancelled(ctx: RunContext, root: string, id: string, sessionId: string | undefined): Promise<boolean> {
  if (!ctx.cancelRequested.has(id)) return false;
  ctx.cancelRequested.delete(id);
  if (sessionId && ctx.host.sessionAlive(sessionId)) ctx.host.closeSession(sessionId);
  ctx.patch(id, { state: 'queued', sessionId: undefined });
  stampFold(root, id, 'pending', 'start cancelled — fold kept, task still queued'); // the fold survives, so the link does too
  ctx.busy.delete(id);
  ctx.broadcast();
  return true;
}

/** Start every queued record in the repo. Each start is fired (not awaited to
 *  completion) so the sessions run concurrently; each broadcasts as it moves. */
export function startAllQueued(ctx: RunContext, root: string): void {
  for (const rec of loadState(root).worktrees) {
    if (!rec.queuedTask) continue;
    const rt = ctx.runtime.get(rec.id);
    if (rt?.sessionId && ctx.host.sessionAlive(rt.sessionId)) continue;
    void runStart(ctx, root, rec.id);
  }
}

/** Open a card's chat (amOpenChat): a live session opens directly; a Done card
 *  with a persisted engine id reopens its transcript in a fresh agent session
 *  (new ui id -> runtime, so later clicks reuse it); else amError. Re-entry is
 *  guarded so a double-click can't spawn two engines for one card. */
export async function openChat(ctx: RunContext, root: string, id: string): Promise<void> {
  const { host } = ctx;
  const rt = ctx.runtime.get(id);
  if (rt?.sessionId && host.sessionAlive(rt.sessionId)) { host.openChat(rt.sessionId); return; }
  if (ctx.reopening.has(id)) return;
  const rec = ctx.record(root, id);
  if (!rec?.engineSessionId) { host.post({ type: 'amError', message: 'No transcript recorded for this agent.' }); return; }
  ctx.reopening.add(id);
  try {
    // loadSessionId AND cwd together: replay the transcript in the worktree.
    const uiId = await host.reopenAgentSession(rec.path, rec.engineSessionId, rt?.agentName || rec.agentName || rec.queuedTask?.agentName || undefined);
    ctx.patch(id, { sessionId: uiId }); // hasSession flips true -> later Chat clicks reuse it
    host.openChat(uiId);
    ctx.broadcast();
  } catch (e) {
    host.post({ type: 'amError', message: `Could not reopen chat: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    ctx.reopening.delete(id);
  }
}
