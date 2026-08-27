// Agent Manager - mapRun.ts (S15): the CARTOGRAPHER run lifecycle, extracted from
// manager.ts (at its cap) so the fleet owner only routes. A map run is an ordinary
// engine session whose cwd is the REPO ROOT (never a worktree - the map describes
// the repo, and .origami/ is excluded so a root-cwd session leaves no deliverable
// footprint). One run per repo at a time; a second request while running is refused.
//
// On session idle the EXTENSION (not the agent - bash is denied to it) stamps
// builtAt {sha, branch, at} via git rev-parse, rewrites map.json, renders the
// self-contained map.html, and caches a fresh RepoMapState. A missing / invalid /
// unchanged map settles an HONEST failed state carrying the validation errors, never
// a silent success. Staleness (`behind` = commits builtAt.sha..HEAD) is recomputed
// on demand (refreshAllMapStatus, driven by the manager's request/poll paths). The
// brief line (withMapBrief) prefixes a task-run prompt when a valid map exists.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadState } from './state';
import { ensureExcluded, runGitStdout } from './worktrees';
import { mergeAgentTypes } from './agentTypes';
import { validateMap, type RepoMap } from './mapSchema';
import { renderMapHtml } from './mapHtml';
import { repoKey } from './registry';
import type { ManagerHost } from './host';

export const MAP_DIR = path.join('.origami', 'map');
export const MAP_JSON = path.join(MAP_DIR, 'map.json');
export const MAP_HTML = path.join(MAP_DIR, 'map.html');

const MAP_TASK_PROMPT =
  'Map this repository now. If .origami/map/map.json already exists, read it first and update it against the current code. Survey as your instructions require, then write .origami/map/map.json to the required schema. Write no other file.';

// A map run has no human at its surface, so a stalled prompt (a permission ask or a
// question nobody can answer) hung it on "building..." forever. Generous for a big repo
// on a local model, finite so the board always settles.
const MAP_TIMEOUT_MINUTES = 15;

/** The board-facing map status for a repo column (rides amState). */
export interface RepoMapState {
  status: 'none' | 'ready' | 'building' | 'failed';
  sha?: string;
  branch?: string;
  builtAt?: number;
  /** Commits HEAD is ahead of the stamped sha (0 = fresh). Undefined = unknown. */
  behind?: number;
  errors?: string[];
  name?: string;
}

/** One in-flight map run, keyed by repoKey(root) in the manager's mapRuns map. */
export interface MapRun {
  sessionId?: string;
  cancelRequested?: boolean;
  /** Watchdog fired: settle as an honest timeout, not a cancel's "disk truth". */
  timedOut?: boolean;
}

/** The narrow window the manager drives map runs through. */
export interface MapCtx {
  host: ManagerHost;
  mapRuns: Map<string, MapRun>;
  mapStatus: Map<string, RepoMapState>;
  broadcast(): void;
}

function mapFile(root: string): string { return path.join(root, MAP_JSON); }
function readRaw(root: string): string | null {
  try { return fs.readFileSync(mapFile(root), 'utf8'); } catch { return null; }
}

/** A stable comparison key so a poll only re-broadcasts on a real status change. */
function stateKey(s: RepoMapState): string {
  return `${s.status}|${s.sha ?? ''}|${s.behind ?? ''}|${s.name ?? ''}|${(s.errors ?? []).length}`;
}

async function revCount(root: string, range: string): Promise<number | undefined> {
  const r = await runGitStdout(['rev-list', '--count', range], root);
  if (!r.ok) return undefined; // e.g. the stamped sha is unreachable (rebase/force-push) -> staleness unknown, not 0
  return parseInt(r.output, 10) || 0;
}

/**
 * Read the on-disk map status: absent -> none; unparseable/invalid -> failed with
 * the precise errors; valid + stamped -> ready with `behind` computed from the
 * stamped sha; valid but UNSTAMPED (agent-authored, never finalized) -> ready with
 * behind undefined (staleness unknown). Never re-stamps - a pure read.
 */
export async function readMapStatus(root: string): Promise<RepoMapState> {
  const raw = readRaw(root);
  if (raw === null) return { status: 'none' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'failed', errors: ['.origami/map/map.json is not valid JSON'] }; }
  const res = validateMap(parsed);
  if (!res.ok) return { status: 'failed', errors: res.errors };
  const map = res.map;
  const sha = map.builtAt?.sha;
  if (!sha) return { status: 'ready', builtAt: map.builtAt?.at, name: map.name };
  const behind = await revCount(root, `${sha}..HEAD`);
  return { status: 'ready', sha, branch: map.builtAt?.branch, builtAt: map.builtAt?.at, behind, name: map.name };
}

/** Stamp builtAt (git rev-parse - the agent cannot, bash is denied), rewrite
 *  map.json, and render the self-contained map.html. Returns the fresh ready state. */
async function stampAndRender(root: string, map: RepoMap): Promise<RepoMapState> {
  // Guard `.ok`: on a repo with no commits `rev-parse` FAILS and the unchecked read
  // stamped git's ERROR TEXT into builtAt.sha. A failed stamp leaves the field absent,
  // which readMapStatus already reads as "valid map, staleness unknown" - the truth.
  const head = await runGitStdout(['rev-parse', 'HEAD'], root);
  const headBranch = await runGitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const sha = head.ok ? head.output.trim() : undefined;
  const branch = headBranch.ok ? headBranch.output.trim() : undefined;
  const at = Date.now();
  map.builtAt = sha !== undefined && branch !== undefined ? { sha, branch, at } : undefined;
  fs.mkdirSync(path.join(root, MAP_DIR), { recursive: true });
  fs.writeFileSync(mapFile(root), JSON.stringify(map, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, MAP_HTML), renderMapHtml(map), 'utf8');
  return { status: 'ready', sha, branch, builtAt: at, behind: sha === undefined ? undefined : 0, name: map.name };
}

/** After the run settles: turn whatever the cartographer left on disk into a status.
 *  A TIMED-OUT run is an honest failure that names itself; a cancelled run reflects
 *  disk truth (prior map or none), never a false failure. */
async function finishMap(root: string, priorRaw: string | null, run: MapRun): Promise<RepoMapState> {
  if (run.timedOut) return { status: 'failed', errors: [`the cartographer did not finish within ${MAP_TIMEOUT_MINUTES} minutes - the run was cancelled`] };
  if (run.cancelRequested) return readMapStatus(root);
  const currentRaw = readRaw(root);
  if (currentRaw === null) return { status: 'failed', errors: ['the cartographer wrote no .origami/map/map.json'] };
  if (currentRaw === priorRaw) return { status: 'failed', errors: ['the cartographer produced no new map (map.json unchanged)'] };
  let parsed: unknown;
  try { parsed = JSON.parse(currentRaw); } catch { return { status: 'failed', errors: ['.origami/map/map.json is not valid JSON'] }; }
  const res = validateMap(parsed);
  if (!res.ok) return { status: 'failed', errors: res.errors };
  return stampAndRender(root, res.map);
}

/** Harvest the session roster (so cartographer shows in pickers) + set the session
 *  mode to cartographer before the prompt. A bad id is fatal, mirroring syncAgentType. */
async function applyCartographerMode(ctx: MapCtx, sessionId: string): Promise<void> {
  const harvested = ctx.host.agentModes(sessionId);
  if (harvested && harvested.length > 0) {
    const merged = mergeAgentTypes(ctx.host.agentTypes(), harvested);
    if (merged) { ctx.host.saveAgentTypes(merged); ctx.broadcast(); }
  }
  try { await ctx.host.setSessionAgentMode(sessionId, 'cartographer'); }
  catch { throw new Error('agent type unavailable: cartographer'); }
}

/**
 * Run the cartographer against the repo root. Refuses a second concurrent run for
 * the same repo. Provisions a session (cwd = root), pins the repo default model,
 * sets the cartographer mode, prompts, then finalizes on idle. Cancel (cancelMap)
 * flags the run and cancels the session; the finalize reverts to disk truth.
 */
export async function runMap(ctx: MapCtx, root: string): Promise<void> {
  const key = repoKey(root);
  if (ctx.mapRuns.has(key)) { ctx.host.post({ type: 'amError', message: 'A map is already building for this repository.' }); return; }
  const run: MapRun = {};
  ctx.mapRuns.set(key, run);
  ctx.broadcast();
  const priorRaw = readRaw(root);
  let sessionId: string | undefined;
  try {
    ensureExcluded(root); // keep the regenerable .origami/map/ out of the working tree
    fs.mkdirSync(path.join(root, MAP_DIR), { recursive: true }); // exist before the agent's first write, so it never hesitates over a missing dir
    const effModel = loadState(root).defaultModel ?? ''; // same resolution as a task run's repo default
    sessionId = await ctx.host.createAgentSession(root, 'cartographer');
    run.sessionId = sessionId;
    if (!run.cancelRequested && effModel) await ctx.host.setSessionModel(sessionId, effModel);
    if (!run.cancelRequested) await applyCartographerMode(ctx, sessionId);
    if (!run.cancelRequested) await withTimeout(ctx, root, run, () => ctx.host.promptSession(sessionId!, MAP_TASK_PROMPT));
    ctx.mapStatus.set(key, await finishMap(root, priorRaw, run));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e); // a cut run (cancel OR timeout) settles through finishMap, not as this throw
    ctx.mapStatus.set(key, run.cancelRequested || run.timedOut ? await finishMap(root, priorRaw, run) : { status: 'failed', errors: [detail] });
  } finally {
    if (sessionId && ctx.host.sessionAlive(sessionId)) ctx.host.closeSession(sessionId);
    ctx.mapRuns.delete(key);
    ctx.broadcast();
  }
}

/** Run the prompt under a watchdog: on expiry flag it and reuse the ORDINARY cancel path. */
async function withTimeout(ctx: MapCtx, root: string, run: MapRun, body: () => Promise<unknown>): Promise<void> {
  const timer = setTimeout(() => { run.timedOut = true; cancelMap(ctx, root); }, MAP_TIMEOUT_MINUTES * 60_000);
  try { await body(); } finally { clearTimeout(timer); }
}

/** Cancel an in-flight map run: flag it + cancel its session; finalize reverts to disk. */
export function cancelMap(ctx: MapCtx, root: string): void {
  const run = ctx.mapRuns.get(repoKey(root));
  if (!run) return;
  run.cancelRequested = true;
  if (run.sessionId && ctx.host.sessionAlive(run.sessionId)) void ctx.host.cancelSession(run.sessionId);
  ctx.broadcast();
}

/** The merged board value for a repo: building (from an in-flight run, carrying any
 *  prior sha/behind for context) else the cached on-disk status else none. */
export function boardMapState(ctx: MapCtx, root: string): RepoMapState {
  const key = repoKey(root);
  if (ctx.mapRuns.has(key)) {
    const prior = ctx.mapStatus.get(key);
    return { status: 'building', sha: prior?.sha, behind: prior?.behind, builtAt: prior?.builtAt, name: prior?.name };
  }
  return ctx.mapStatus.get(key) ?? { status: 'none' };
}

/** Refresh the cached on-disk status for every non-building repo; returns true when
 *  any changed (so the caller broadcasts). Building repos are owned by their run. */
export async function refreshAllMapStatus(ctx: MapCtx, roots: string[]): Promise<boolean> {
  let changed = false;
  for (const root of roots) {
    const key = repoKey(root);
    if (ctx.mapRuns.has(key)) continue;
    const next = await readMapStatus(root);
    const prev = ctx.mapStatus.get(key);
    if (!prev || stateKey(prev) !== stateKey(next)) { ctx.mapStatus.set(key, next); changed = true; }
  }
  return changed;
}

/** Prefix the map brief onto a task-run prompt when the repo has a VALID map;
 *  otherwise return the prompt unchanged (nothing when absent/invalid/building). */
export async function withMapBrief(root: string, prompt: string): Promise<string> {
  const st = await readMapStatus(root);
  if (st.status !== 'ready') return prompt;
  const shortsha = st.sha ? st.sha.slice(0, 7) : '(unstamped)';
  const staleness = st.behind === undefined ? 'staleness unknown' : `${st.behind} commits behind HEAD`;
  return `A repo architecture map exists at .origami/map/map.json (built at ${shortsha}, ${staleness}) - read it before exploring.\n\n${prompt}`;
}
