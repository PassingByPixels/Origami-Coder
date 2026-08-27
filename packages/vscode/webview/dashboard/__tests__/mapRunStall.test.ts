// Cartographer stall (S15 defect). A map run has no human at its surface: the engine
// can raise a permission ask or a question-shaped ask that nothing will ever answer,
// and `promptSession` had no timeout, so the board sat on "building…" forever (the
// observed run never settled). It now fails VISIBLY through the ordinary cancel path.
//
// Also covers the second bug in the same file: `stampAndRender` read
// `runGitStdout(['rev-parse','HEAD']).output` without checking `.ok`, which stamped
// git's ERROR TEXT into map.builtAt.sha on a repo with no commits.
//
// Driven against the real runMap with a hand-built ctx (the AgentManager fixture's
// waitFor polling can't share a fake clock with the watchdog).

import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMap, readMapStatus, MAP_DIR, type MapCtx, type RepoMapState } from '../../../src/dashboard/agentManager/mapRun';
import { repoKey } from '../../../src/dashboard/agentManager/registry';
import { runGit } from '../../../src/dashboard/agentManager/worktrees';

const made: string[] = [];
afterAll(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

const VALID_MAP = {
  version: 2, name: 'demo', summary: 'a fixture',
  nodes: [{ id: 'n', name: 'N', pillar: 1, kind: 'module', summary: 'x' }],
  edges: [], flows: [],
};

async function emptyRepo(commit: boolean): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-mapstall-'));
  made.push(dir);
  await runGit(['init', '-b', 'main'], dir);
  await runGit(['config', 'user.email', 'uat@origami.local'], dir);
  await runGit(['config', 'user.name', 'Origami UAT'], dir);
  if (commit) {
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    await runGit(['add', 'app.txt'], dir);
    await runGit(['commit', '-m', 'seed'], dir);
  }
  return dir;
}

/** A ctx whose prompt parks until the run cancels it — the shape of a stalled agent
 *  waiting on an ask nobody can answer. `onPrompt` runs once the prompt is parked. */
function stallingCtx(onPrompt?: () => void): { ctx: MapCtx; cancelled: () => boolean; dirAtCreate: () => boolean } {
  let resolvePrompt: (() => void) | undefined;
  let cancelled = false;
  let dirAtCreate = false;
  let root = '';
  const host = {
    post: () => {},
    createAgentSession: async (cwd: string) => { root = cwd; dirAtCreate = fs.existsSync(path.join(cwd, MAP_DIR)); return 'sess-map'; },
    setSessionModel: async () => {},
    agentModes: () => [{ id: 'cartographer', name: 'cartographer' }],
    agentTypes: () => [],
    saveAgentTypes: () => {},
    setSessionAgentMode: async () => {},
    promptSession: async () => { const p = new Promise<void>((r) => { resolvePrompt = r; }); onPrompt?.(); await p; return 'end_turn'; },
    sessionAlive: () => true,
    // A real cancel unblocks the parked prompt, exactly as the engine's does.
    cancelSession: async () => { cancelled = true; resolvePrompt?.(); },
    closeSession: () => {},
  };
  void root;
  return {
    ctx: { host: host as unknown as MapCtx['host'], mapRuns: new Map(), mapStatus: new Map<string, RepoMapState>(), broadcast: () => {} },
    cancelled: () => cancelled,
    dirAtCreate: () => dirAtCreate,
  };
}

describe('cartographer run — a stalled prompt fails visibly instead of hanging', () => {
  it('a prompt that never returns is cancelled and settles as a NAMED timeout failure', async () => {
    const repo = await emptyRepo(true);
    const { ctx, cancelled } = stallingCtx();
    vi.useFakeTimers();
    try {
      const run = runMap(ctx, repo);
      await vi.advanceTimersByTimeAsync(0); // let the run reach its parked prompt
      expect(ctx.mapRuns.size).toBe(1); // still building
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(ctx.mapRuns.size).toBe(1); // 14 minutes in: still patiently building
      await vi.advanceTimersByTimeAsync(2 * 60_000); // past the 15-minute watchdog
      await run;

      expect(cancelled()).toBe(true); // torn down through the ORDINARY cancel path
      const state = ctx.mapStatus.get(repoKey(repo))!;
      expect(state.status).toBe('failed');
      expect(state.errors?.join(' ')).toContain('15 minutes'); // names the timeout, not a vague failure
      expect(ctx.mapRuns.size).toBe(0); // the run is released, so the repo is mappable again
    } finally {
      vi.useRealTimers();
    }
  });

  it('the map directory exists BEFORE the session is created', async () => {
    const repo = await emptyRepo(true);
    const { ctx, dirAtCreate } = stallingCtx();
    vi.useFakeTimers();
    try {
      const run = runMap(ctx, repo);
      await vi.advanceTimersByTimeAsync(0);
      // The agent's first act is to write .origami/map/map.json; the directory must
      // already be there rather than something it has to reason about.
      expect(dirAtCreate()).toBe(true);
      await vi.advanceTimersByTimeAsync(16 * 60_000);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cartographer stamp — a repo with no commits', () => {
  it('leaves the sha ABSENT instead of stamping git error text', async () => {
    const repo = await emptyRepo(false); // git init, zero commits: rev-parse HEAD fails
    const { ctx } = stallingCtx(() => {
      // the "cartographer" writes its map, then the parked prompt is released
      fs.mkdirSync(path.join(repo, MAP_DIR), { recursive: true });
      fs.writeFileSync(path.join(repo, MAP_DIR, 'map.json'), JSON.stringify(VALID_MAP), 'utf8');
      void ctx.host.cancelSession('sess-map'); // unparks the prompt without flagging a cancel
    });
    await runMap(ctx, repo);

    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, MAP_DIR, 'map.json'), 'utf8'));
    expect(onDisk.builtAt).toBeUndefined(); // NOT { sha: "fatal: ambiguous argument 'HEAD'..." }
    const state = ctx.mapStatus.get(repoKey(repo))!;
    expect(state.status).toBe('ready'); // a valid map is still a valid map
    expect(state.sha).toBeUndefined();
    expect(state.behind).toBeUndefined(); // staleness UNKNOWN, never a false "fresh"
    // and the on-disk map still validates on a re-read
    expect((await readMapStatus(repo)).status).toBe('ready');
  }, 20_000);
});
