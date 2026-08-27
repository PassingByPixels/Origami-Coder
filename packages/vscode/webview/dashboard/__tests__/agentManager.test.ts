// Agent Manager S3.6 - the fleet owner (manager.ts) driven through a scripted
// ManagerHost against REAL git fixture repos, plus the pollers' pure parsing.
// The host is the only fake (it stands in for DashboardPanel's session +
// per-session model-pin machinery); worktrees, registry, state and git stats
// are the real modules on real disk state. S3.6 board = a KANBAN: every
// broadcast carries every repo's rows (no active-repo selector, no gating), and
// each task can pin a model / a repo can carry a default.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManager, findSetupScript, type ManagerHost } from '../../../src/dashboard/agentManager/manager';
import { parseShortstat, statsKey, readWorktreeStats } from '../../../src/dashboard/agentManager/pollers';
import { createWorktree, runGit } from '../../../src/dashboard/agentManager/worktrees';
import { loadState, saveState } from '../../../src/dashboard/agentManager/state';
import { normalizeRepoPath, repoKey } from '../../../src/dashboard/agentManager/registry';
import { ARCHETYPES } from '../../../src/dashboard/agentManager/archetypes';
import { withMapBrief } from '../../../src/dashboard/agentManager/mapRun';

describe('pollers parsing', () => {
  it('parses git shortstat lines including missing halves', () => {
    expect(parseShortstat('3 files changed, 41 insertions(+), 7 deletions(-)')).toEqual({ adds: 41, dels: 7 });
    expect(parseShortstat('1 file changed, 5 insertions(+)')).toEqual({ adds: 5, dels: 0 });
    expect(parseShortstat('2 files changed, 9 deletions(-)')).toEqual({ adds: 0, dels: 9 });
    expect(parseShortstat('')).toEqual({ adds: 0, dels: 0 });
  });

  it('statsKey changes iff a stat changes (the broadcast suppression key)', () => {
    expect(statsKey({ ahead: 1, adds: 2, dels: 3 })).toBe('1|2|3');
    expect(statsKey({ ahead: 1, adds: 2, dels: 3 })).toBe(statsKey({ ahead: 1, adds: 2, dels: 3 }));
    expect(statsKey({ ahead: 1, adds: 2, dels: 4 })).not.toBe(statsKey({ ahead: 1, adds: 2, dels: 3 }));
  });
});

describe('findSetupScript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-setup-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  // Platform is passed EXPLICITLY, never left to the host default: asserting the
  // Windows runners through `process.platform` would pass here and fail the day
  // the suite runs on a Mac (the trap the cron suites already had to unpick).
  it('returns undefined without a script, and the ps1 runner when present', () => {
    expect(findSetupScript(dir, 'win32')).toBeUndefined();
    fs.mkdirSync(path.join(dir, '.origami'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.origami', 'setup-script.ps1'), 'Write-Output ok');
    const found = findSetupScript(dir, 'win32');
    expect(found?.label).toBe('setup-script.ps1');
    expect(found?.command).toContain('powershell');
    expect(found?.command).toContain('setup-script.ps1');
  });

  it('never hands a mac `powershell` or `cmd /c` — sh wins, a lone ps1 gets pwsh', () => {
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-setup-mac-'));
    fs.mkdirSync(path.join(only, '.origami'), { recursive: true });
    // A repo carrying BOTH: darwin must take the sh script, win32 the ps1.
    fs.writeFileSync(path.join(only, '.origami', 'setup-script.ps1'), 'Write-Output ok');
    fs.writeFileSync(path.join(only, '.origami', 'setup-script.cmd'), 'echo ok');
    fs.writeFileSync(path.join(only, '.origami', 'setup-script.sh'), 'echo ok');
    const mac = findSetupScript(only, 'darwin');
    expect(mac?.label).toBe('setup-script.sh');
    expect(mac?.command.startsWith('sh ')).toBe(true);
    expect(findSetupScript(only, 'win32')?.label).toBe('setup-script.ps1');
    // cmd.exe does not exist off Windows, so a .cmd is never offered there.
    fs.rmSync(path.join(only, '.origami', 'setup-script.sh'));
    const macCmdOnly = findSetupScript(only, 'darwin');
    expect(macCmdOnly?.label).toBe('setup-script.ps1');
    expect(macCmdOnly?.command).toContain('pwsh');
    expect(macCmdOnly?.command).not.toContain('cmd /c');
    fs.rmSync(only, { recursive: true, force: true });
  });

  it('quotes the path for the shell that will actually read it', () => {
    // runGate runs this with `shell: true`, so the string is parsed by cmd.exe on
    // Windows and by /bin/sh elsewhere. A repo path holding `$` or a backtick is
    // literal inside double quotes under cmd, but EXPANDED under sh — the command
    // would then point at a path that does not exist, and the setup note would
    // blame the script. `$` is legal in a directory name on both OSes.
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-setup-$HOME-'));
    fs.mkdirSync(path.join(odd, '.origami'), { recursive: true });
    fs.writeFileSync(path.join(odd, '.origami', 'setup-script.sh'), 'echo ok');
    const p = path.join(odd, '.origami', 'setup-script.sh');

    expect(findSetupScript(odd, 'darwin')?.command).toBe(`sh '${p}'`);
    expect(findSetupScript(odd, 'win32')?.command).toBe(`sh "${p}"`);
    fs.rmSync(odd, { recursive: true, force: true });
  });

  it("escapes a single quote in a mac path as '\\'' rather than ending the quote", () => {
    const q = fs.mkdtempSync(path.join(os.tmpdir(), "origami-am-setup-don't-"));
    fs.mkdirSync(path.join(q, '.origami'), { recursive: true });
    fs.writeFileSync(path.join(q, '.origami', 'setup-script.sh'), 'echo ok');
    const cmd = findSetupScript(q, 'darwin')!.command;
    // Naive single-quoting would close the quote mid-path and hand sh a broken
    // command; the escape must reopen it.
    expect(cmd).toContain(`don'\\''t`);
    expect(cmd.startsWith("sh '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    fs.rmSync(q, { recursive: true, force: true });
  });
});

interface FakeHost extends ManagerHost {
  posts: Array<Record<string, unknown>>;
  createdWith: Array<{ cwd: string; agentName?: string }>;
  prompted: Array<{ sessionId: string; text: string }>;
  cancelled: string[];
  closed: string[];
  live: Set<string>;
  resolvePrompt: (stopReason: string) => void;
  /** When set, createAgentSession blocks until releaseCreate() (or rejects). */
  deferCreate?: boolean;
  failCreate?: string;
  releaseCreate: () => void;
  /** Hub backing state. `pickResult` is what pickRepoFolder returns next. */
  known: string[];
  pickResult?: string;
  /** Board-only display-name overrides (repoOps.ts setRepoDisplayName), keyed by root. */
  displayNames: Record<string, string>;
  /** S5.2 auto-approve toggle backing (default ON, mirrors globalState). */
  autoApproveOn: boolean;
  /** Per-session model pins recorded by setSessionModel, + a fail switch. */
  modelPins: Array<{ sessionId: string; modelId: string }>;
  failSetModel?: string;
  /** When set, setSessionModel blocks until releaseSetModel() — to open a
   *  Cancel-during-pin window. `pinEntered` signals it reached the block. */
  deferSetModel?: boolean;
  releaseSetModel: () => void;
  pinEntered: string[];
  /** Interleave log of 'pin' vs 'prompt' so ordering can be asserted. */
  order: string[];
  /** Chat-on-Done: reopenAgentSession calls recorded here (+ a deferral gate so
   *  a double-fire-in-flight can be caught). reopenEntered signals entry. */
  reopened: Array<{ cwd: string; engineId: string; agentName?: string }>;
  reopenEntered: string[];
  deferReopen?: boolean;
  releaseReopen: () => void;
  /** S4 apply-to-main host surface: diffs opened, info toasts, conflicted opens. */
  diffOpened: Array<{ worktree: string; base: string; relPath: string; rightFsPath: string; title: string }>;
  infos: string[];
  conflictOpened: string[][];
  /** S6a typed agents: `sessionModes` = what agentModes() reports for a session
   *  (null before harvest); `agentTypesStore` backs agentTypes()/saveAgentTypes();
   *  `agentModeSet` logs setSessionAgentMode, which throws when the id is not a
   *  live mode. 'mode' is pushed to `order` so its ordering vs 'prompt' asserts. */
  sessionModes: Array<{ id: string; name: string; default?: boolean; description?: string }> | null;
  agentTypesStore: Array<{ id: string; name: string; default?: boolean }>;
  agentModeSet: Array<{ sessionId: string; modeId: string }>;
  /** S6c: `anySessionModes` is what harvestAnySessionModes() returns (the roster
   *  pre-fill source) - default null so pre-fill never fires unless a test opts in;
   *  `crossDiffs` records openCrossDiff calls (the race A-vs-B compare). */
  anySessionModes: Array<{ id: string; name: string; default?: boolean }> | null;
  crossDiffs: Array<{ leftFsPath: string; rightFsPath: string; title: string }>;
}

function makeHost(repo: string | undefined): FakeHost {
  let sessionCounter = 0;
  // A QUEUE of pending prompt resolvers (not a single slot): amStartAll fires
  // several starts at once, so more than one promptSession can be in flight -
  // resolvePrompt settles them FIFO. Single-prompt tests push one, shift one.
  const promptResolvers: Array<(r: string) => void> = [];
  let createResolve: (() => void) | undefined;
  let setModelResolve: (() => void) | undefined;
  let reopenResolve: (() => void) | undefined;
  const host: FakeHost = {
    posts: [], createdWith: [], prompted: [], cancelled: [], closed: [],
    live: new Set<string>(),
    known: [], displayNames: {}, autoApproveOn: true, modelPins: [], order: [], pinEntered: [],
    reopened: [], reopenEntered: [],
    diffOpened: [], infos: [], conflictOpened: [],
    sessionModes: null, agentTypesStore: [], agentModeSet: [],
    anySessionModes: null, crossDiffs: [],
    resolvePrompt: (r) => { promptResolvers.shift()?.(r); },
    releaseCreate: () => { createResolve?.(); createResolve = undefined; },
    releaseSetModel: () => { setModelResolve?.(); setModelResolve = undefined; },
    releaseReopen: () => { reopenResolve?.(); reopenResolve = undefined; },
    repoRoot: () => repo,
    knownRepos: () => host.known,
    saveKnownRepos: (paths) => { host.known = [...paths]; },
    pickRepoFolder: async () => host.pickResult,
    repoDisplayNames: () => host.displayNames,
    saveRepoDisplayNames: (names) => { host.displayNames = { ...names }; },
    autoApprove: () => host.autoApproveOn,
    setAutoApprove: (on) => { host.autoApproveOn = on; },
    createAgentSession: async (cwd, agentName) => {
      host.createdWith.push({ cwd, agentName });
      if (host.failCreate) throw new Error(host.failCreate);
      if (host.deferCreate) await new Promise<void>((r) => { createResolve = r; });
      const id = `session-fake-${++sessionCounter}`;
      host.live.add(id);
      return id;
    },
    promptSession: (sessionId, text) => {
      host.prompted.push({ sessionId, text });
      host.order.push('prompt');
      return new Promise<string>((resolve) => { promptResolvers.push(resolve); });
    },
    cancelSession: async (sessionId) => { host.cancelled.push(sessionId); },
    closeSession: (sessionId) => { host.closed.push(sessionId); host.live.delete(sessionId); },
    sessionAlive: (sessionId) => host.live.has(sessionId),
    openChat: () => undefined,
    post: (msg) => { host.posts.push(msg as Record<string, unknown>); },
    openTerminal: () => undefined,
    setSessionModel: async (sessionId, modelId) => {
      host.pinEntered.push(sessionId); // reached the pin (before any block) — a stable wait signal
      if (host.failSetModel) throw new Error(host.failSetModel);
      if (host.deferSetModel) await new Promise<void>((r) => { setModelResolve = r; });
      host.modelPins.push({ sessionId, modelId });
      host.order.push('pin');
    },
    // The engine-store id of a live UI session — a stable derived value the run
    // lifecycle persists on the record for Chat-on-Done. undefined once gone.
    engineSessionId: (uiId) => (host.live.has(uiId) ? `engine-${uiId}` : undefined),
    reopenAgentSession: async (cwd, engineId, agentName) => {
      host.reopenEntered.push(engineId);
      host.reopened.push({ cwd, engineId, agentName });
      if (host.deferReopen) await new Promise<void>((r) => { reopenResolve = r; });
      const id = `session-reopened-${++sessionCounter}`;
      host.live.add(id);
      return id;
    },
    openFileDiff: (worktree, base, relPath, rightFsPath, title) => { host.diffOpened.push({ worktree, base, relPath, rightFsPath, title }); },
    harvestAnySessionModes: () => host.anySessionModes,
    openCrossDiff: (leftFsPath, rightFsPath, title) => { host.crossDiffs.push({ leftFsPath, rightFsPath, title }); },
    info: (msg) => { host.infos.push(msg); },
    openConflicted: (absPaths) => { host.conflictOpened.push(absPaths); },
    agentModes: () => host.sessionModes,
    setSessionAgentMode: async (sessionId, modeId) => {
      const ids = (host.sessionModes ?? []).map((m) => m.id);
      if (!ids.includes(modeId)) throw new Error(`agent type "${modeId}" not one of: ${ids.join(', ') || '(none)'}`);
      host.agentModeSet.push({ sessionId, modeId });
      host.order.push('mode');
    },
    agentTypes: () => host.agentTypesStore,
    saveAgentTypes: (types) => { host.agentTypesStore = [...types]; },
    // Marker reads as already-installed so the constructor's ensureArchetypes is a
    // no-op in every manager test (never touches the real ~/.config agent dir).
    archetypeMarker: () => ({ get: () => true, set: () => undefined }),
  };
  return host;
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

const key = (p: string) => repoKey(normalizeRepoPath(p));
interface MapStateT { status: string; sha?: string; branch?: string; builtAt?: number; behind?: number; errors?: string[]; name?: string }
interface RepoBoardT { root: string; name: string; workspace: boolean; missing: boolean; defaultModel: string; rows: Array<Record<string, unknown>>; map?: MapStateT }
type AmState = { repos: RepoBoardT[]; noRepo: boolean; autoApprove: boolean; agentTypes: Array<{ id: string; name: string; default?: boolean }>; displayNames: Record<string, string> };
const lastAmState = (host: FakeHost) =>
  [...host.posts].reverse().find((p) => p.type === 'amState') as unknown as AmState | undefined;
const board = (host: FakeHost, root: string) => lastAmState(host)?.repos.find((r) => key(r.root) === key(root));
const rowsOf = (host: FakeHost, root: string) => (board(host, root)?.rows ?? []);
const rowNames = (host: FakeHost, root: string) => rowsOf(host, root).map((r) => r.name as string);

describe('AgentManager S3.6 kanban (fake host, real git)', () => {
  const madeRepos: string[] = [];
  const madePlain: string[] = [];

  async function makeGitRepo(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-'));
    madeRepos.push(dir);
    expect((await runGit(['init', '-b', 'main'], dir)).ok).toBe(true);
    await runGit(['config', 'user.email', 'uat@origami.local'], dir);
    await runGit(['config', 'user.name', 'Origami UAT'], dir);
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    await runGit(['add', 'app.txt'], dir);
    expect((await runGit(['commit', '-m', 'seed'], dir)).ok).toBe(true);
    return dir;
  }
  /** A worktree + its registry record, so the repo's column has a visible row. */
  async function seedWorktree(repo: string, name: string): Promise<void> {
    const created = await createWorktree(repo, name);
    const st = loadState(repo);
    st.worktrees.push({
      id: `w-${name}`, name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: [],
    });
    saveState(repo, st);
  }

  afterAll(() => {
    for (const d of [...madeRepos, ...madePlain]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  });

  it('noRepo: no workspace and nothing registered -> empty board', async () => {
    const host = makeHost(undefined);
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    const st = lastAmState(host)!;
    expect(st.noRepo).toBe(true);
    expect(st.repos).toEqual([]);
    mgr.dispose();
  });

  it('(arch1) constructing the manager installs the Folds archetypes (constructor->ensureArchetypes wiring)', () => {
    // A get()=false marker + XDG_CONFIG_HOME redirected to a temp dir: the real
    // global agent dir is NEVER touched, and merely NEWing the manager must write
    // the archetype files. Delete the constructor's ensureArchetypes call and this
    // goes red (no files, marker never set) - the assertion the manager suite lacked.
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-cfg-'));
    try {
      process.env.XDG_CONFIG_HOME = cfg;
      const host = makeHost(undefined);
      let setCalls = 0;
      host.archetypeMarker = () => ({ get: () => false, set: () => { setCalls += 1; } });
      const mgr = new AgentManager(host);
      const agentDir = path.join(cfg, 'origami', 'agent');
      for (const a of ARCHETYPES) expect(fs.existsSync(path.join(agentDir, a.file))).toBe(true);
      expect(setCalls).toBe(1); // the install pass ran to completion and recorded the marker
      mgr.dispose();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });

  it('the workspace git repo appears first as a workspace column', async () => {
    const repo = await makeGitRepo();
    await seedWorktree(repo, 'wswt');
    const host = makeHost(repo); // workspace itself IS a git repo
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    expect(lastAmState(host)!.repos[0].workspace).toBe(true);
    expect(rowNames(host, repo)).toEqual(['wswt']);
    mgr.dispose();
  }, 30_000);

  it('(1) amRequestState with two registered repos -> ONE amState carrying both repos rows', async () => {
    const a = await makeGitRepo();
    const b = await makeGitRepo();
    await seedWorktree(a, 'awt');
    await seedWorktree(b, 'bwt');
    const host = makeHost(undefined);
    host.known = [a, b];
    const mgr = new AgentManager(host);
    host.posts.length = 0;
    await mgr.handle({ type: 'amRequestState' });
    // exactly one broadcast, not one-per-repo (the poll macrotask hasn't fired yet)
    expect(host.posts.filter((p) => p.type === 'amState')).toHaveLength(1);
    const st = lastAmState(host)!;
    expect(st.noRepo).toBe(false);
    expect(rowNames(host, a)).toEqual(['awt']);
    expect(rowNames(host, b)).toEqual(['bwt']);
    mgr.dispose();
  }, 30_000);

  it('(2) a create in repo B updates B rows in the broadcast while A stays intact (isolation without gating)', async () => {
    const a = await makeGitRepo();
    const b = await makeGitRepo();
    await seedWorktree(a, 'awt');
    const host = makeHost(undefined);
    host.known = [a, b];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    const done = mgr.handle({ type: 'amCreate', root: b, name: 'bnew', agentName: 'tsuru', prompt: 'x' });
    await waitFor(() => host.prompted.length === 1);
    expect(rowNames(host, b)).toContain('bnew'); // B gained a row
    expect(rowNames(host, a)).toEqual(['awt']);  // A untouched in the SAME broadcast
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(3) amCreate with model p/m pins the session BEFORE prompting; the row carries the model', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'pinned', agentName: 'tsuru', prompt: 'go', model: 'lmstudio/qwen' });
    await waitFor(() => host.prompted.length === 1);
    expect(host.modelPins).toHaveLength(1);
    expect(host.modelPins[0].modelId).toBe('lmstudio/qwen');
    expect(host.modelPins[0].sessionId).toBe(host.prompted[0].sessionId);
    expect(host.order.indexOf('pin')).toBeLessThan(host.order.indexOf('prompt')); // pin precedes the task
    expect(rowsOf(host, repo).find((r) => r.name === 'pinned')!.model).toBe('lmstudio/qwen');
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(4) empty task model inherits the repo default; with neither default nor pick, no pin happens', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: 'lmstudio/deflt' });
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'usedefault', agentName: 'tsuru', prompt: 'go', model: '' });
    await waitFor(() => host.prompted.length === 1);
    expect(host.modelPins.map((p) => p.modelId)).toEqual(['lmstudio/deflt']);
    expect(rowsOf(host, repo).find((r) => r.name === 'usedefault')!.model).toBe('lmstudio/deflt');
    host.resolvePrompt('end_turn');
    await done;
    // clear the default, create again with no model -> setSessionModel NEVER called
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: '' });
    host.modelPins.length = 0;
    const done2 = mgr.handle({ type: 'amCreate', root: repo, name: 'nomodel', agentName: 'tsuru', prompt: 'go', model: '' });
    await waitFor(() => host.prompted.length === 2);
    expect(host.modelPins).toHaveLength(0);
    expect(rowsOf(host, repo).find((r) => r.name === 'nomodel')!.model).toBe('');
    host.resolvePrompt('end_turn');
    await done2;
    mgr.dispose();
  }, 30_000);

  it('(5) a failed model pin errors the row (mentioning the pin), never runs the task, worktree stays removable', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.failSetModel = 'invalid model id';
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amCreate', root: repo, name: 'badpin', agentName: 'tsuru', prompt: 'go', model: 'lmstudio/nope' });
    const row = rowsOf(host, repo).find((r) => r.name === 'badpin')!;
    expect(row.state).toBe('error');
    expect(String(row.errorDetail).toLowerCase()).toContain('model pin');
    expect(host.prompted).toHaveLength(0); // never ran on the wrong model
    await mgr.handle({ type: 'amDelete', root: repo, id: String(row.id), deleteBranch: true });
    expect(loadState(repo).worktrees.find((r) => r.id === row.id)).toBeUndefined();
    mgr.dispose();
  }, 30_000);

  it('(6) amSetRepoDefault persists to the repo state file, round-trips in amState, survives boot reconcile; empty clears', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: 'openrouter/foo' });
    expect(loadState(repo).defaultModel).toBe('openrouter/foo');    // persisted to disk
    expect(board(host, repo)!.defaultModel).toBe('openrouter/foo'); // round-trips in the board
    // a fresh manager boots (reconciles) and must NOT wipe the default
    const host2 = makeHost(undefined);
    host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    expect(board(host2, repo)!.defaultModel).toBe('openrouter/foo');
    mgr2.dispose();
    // empty clears the field
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: '' });
    expect(loadState(repo).defaultModel).toBeUndefined();
    expect(board(host, repo)!.defaultModel).toBe('');
    mgr.dispose();
  }, 30_000);

  it('(6b) amRenameRepo persists a board-only label (rides amState, real name untouched), clears on re-typing the real name, refuses an unregistered root', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    const realName = board(host, repo)!.name;

    await mgr.handle({ type: 'amRenameRepo', root: repo, displayName: 'Pretty Label' });
    expect(host.displayNames[repo]).toBe('Pretty Label');           // persisted via the host
    expect(lastAmState(host)!.displayNames[repo]).toBe('Pretty Label'); // rides the NEXT broadcast
    expect(board(host, repo)!.name).toBe(realName);                 // the real name is never touched

    // Re-typing the exact real name clears the override back off.
    await mgr.handle({ type: 'amRenameRepo', root: repo, displayName: realName });
    expect(host.displayNames[repo]).toBeUndefined();

    // An unregistered root is refused (amError), no state written.
    host.posts.length = 0;
    await mgr.handle({ type: 'amRenameRepo', root: '/not/registered', displayName: 'x' });
    expect(host.posts.some((p) => p.type === 'amError')).toBe(true);
    expect(host.displayNames['/not/registered']).toBeUndefined();
    mgr.dispose();
  }, 30_000);

  it('(7) a scoped action with an unknown or missing root errors with no side effects', async () => {
    const repo = await makeGitRepo();
    const bogus = path.join(os.tmpdir(), 'origami-am-not-registered-x');
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    host.posts.length = 0;
    const before = loadState(repo).worktrees.length;
    await mgr.handle({ type: 'amCreate', root: bogus, name: 'x', agentName: 'tsuru', prompt: 'y' });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('Repository not available'))).toBe(true);
    expect(host.createdWith).toHaveLength(0);            // no session started
    expect(loadState(repo).worktrees.length).toBe(before); // no worktree created
    expect(host.posts.some((p) => p.type === 'amState')).toBe(false);
    // a registered-then-deleted (missing) repo is also rejected for actions
    const gone = await makeGitRepo();
    host.known = [repo, gone];
    await mgr.handle({ type: 'amRequestState' });
    fs.rmSync(gone, { recursive: true, force: true });
    host.posts.length = 0;
    await mgr.handle({ type: 'amDelete', root: gone, id: 'whatever', deleteBranch: false });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('Repository not available'))).toBe(true);
    mgr.dispose();
  }, 30_000);

  it('(8) a poll after a shown repo folder is deleted clears its rows and flags it missing', async () => {
    const repo = await makeGitRepo();
    await seedWorktree(repo, 'ghostwt');
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    expect(rowNames(host, repo)).toEqual(['ghostwt']);
    fs.rmSync(repo, { recursive: true, force: true }); // vanishes while the board sits on it
    await (mgr as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    const b = board(host, repo)!;
    expect(b.rows).toEqual([]);      // ghost rows cleared
    expect(b.missing).toBe(true);    // column flags missing
    mgr.dispose();
  }, 30_000);

  it('(9) Cancel during provisioning tears the half-built agent down; the task never runs', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferCreate = true;
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'doomed', agentName: 'tsuru', prompt: 'x' });
    await waitFor(() => host.createdWith.length === 1); // parked in createAgentSession (provisioning)
    const midRow = rowsOf(host, repo).find((r) => r.name === 'doomed')!;
    expect(midRow.state).toBe('provisioning');
    await mgr.handle({ type: 'amCancel', root: repo, id: String(midRow.id) });
    host.releaseCreate();
    await done;
    expect(host.closed).toEqual(['session-fake-1']);
    expect(loadState(repo).worktrees.find((r) => r.name === 'doomed')).toBeUndefined();
    expect(fs.existsSync(String(midRow.path))).toBe(false);
    expect(host.prompted).toHaveLength(0);
    mgr.dispose();
  }, 30_000);

  it('(9) Delete during provisioning is refused with guidance; double-delete afterwards is a quiet no-op', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferCreate = true;
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'busybee', agentName: 'tsuru', prompt: 'x' });
    await waitFor(() => host.createdWith.length === 1);
    const row = rowsOf(host, repo).find((r) => r.name === 'busybee')!;
    await mgr.handle({ type: 'amDelete', root: repo, id: String(row.id), deleteBranch: true });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('use Cancel'))).toBe(true);
    expect(loadState(repo).worktrees.find((r) => r.name === 'busybee')).toBeDefined(); // untouched
    host.releaseCreate();
    await waitFor(() => host.prompted.length === 1);
    host.resolvePrompt('end_turn');
    await done;
    host.posts.length = 0;
    await Promise.all([
      mgr.handle({ type: 'amDelete', root: repo, id: String(row.id), deleteBranch: true }),
      mgr.handle({ type: 'amDelete', root: repo, id: String(row.id), deleteBranch: true }),
    ]);
    expect(host.posts.filter((p) => p.type === 'amError')).toEqual([]);
    expect(loadState(repo).worktrees.find((r) => r.name === 'busybee')).toBeUndefined();
    mgr.dispose();
  }, 30_000);

  it('(defect 4) Cancel during the model-pin RPC tears the agent down; the task never runs', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferSetModel = true; // park INSIDE setSessionModel: session exists, task not yet prompted
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'pinwait', agentName: 'tsuru', prompt: 'x', model: 'lmstudio/qwen' });
    // Blocked inside the pin => sessionId already recorded (manager line ~298),
    // task not yet prompted: exactly the widened Cancel window this fix targets.
    await waitFor(() => host.pinEntered.length === 1);
    const row = rowsOf(host, repo).find((r) => r.name === 'pinwait')!;
    expect(row.state).toBe('provisioning');
    await mgr.handle({ type: 'amCancel', root: repo, id: String(row.id) });
    host.releaseSetModel(); // the pin resolves AFTER the cancel landed
    await done;
    expect(host.prompted).toHaveLength(0);                 // the task never ran on the cancelled agent
    expect(host.closed).toContain('session-fake-1');       // session torn down
    expect(loadState(repo).worktrees.find((r) => r.name === 'pinwait')).toBeUndefined(); // worktree gone
    expect(fs.existsSync(String(row.path))).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('(defect 2) unregister is refused while an agent is live; disk untouched; allowed once it settles', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferCreate = true; // park in createAgentSession (provisioning)
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'runner', agentName: 'tsuru', prompt: 'x' });
    await waitFor(() => host.createdWith.length === 1);
    expect(rowsOf(host, repo).find((r) => r.name === 'runner')!.state).toBe('provisioning');
    host.posts.length = 0;
    await mgr.handle({ type: 'amRemoveRepo', root: repo });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('active agents'))).toBe(true);
    expect(host.known.some((k) => key(k) === key(repo))).toBe(true); // still registered (column intact) - not orphaned
    expect(host.posts.some((p) => p.type === 'amState')).toBe(false); // a refusal doesn't rebroadcast
    host.releaseCreate();
    await waitFor(() => host.prompted.length === 1);
    host.resolvePrompt('end_turn');
    await done; // settles idle
    await mgr.handle({ type: 'amRemoveRepo', root: repo });
    expect(host.known.some((k) => key(k) === key(repo))).toBe(false); // now unregisters cleanly
    expect(fs.existsSync(repo)).toBe(true);                           // disk never touched
    mgr.dispose();
  }, 30_000);

  it('(defect 3) remove then re-add re-reconciles, dropping a record that went stale while off the board', async () => {
    const repo = await makeGitRepo();
    await seedWorktree(repo, 'stalewt');
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' }); // first reconcile: record is live
    expect(rowNames(host, repo)).toEqual(['stalewt']);
    const wtPath = loadState(repo).worktrees[0].path;
    await mgr.handle({ type: 'amRemoveRepo', root: repo }); // off the board (detached, so allowed)
    // While off the board the worktree is removed via git (record now stale on disk).
    expect((await runGit(['worktree', 'remove', '--force', wtPath], repo)).ok).toBe(true);
    expect(loadState(repo).worktrees).toHaveLength(1); // record still lingers in the state file
    host.pickResult = repo;
    await mgr.handle({ type: 'amAddRepo' }); // re-add MUST re-reconcile (reconciled key was cleared)
    expect(rowNames(host, repo)).toEqual([]); // stale record dropped, no ghost row
    expect(loadState(repo).worktrees).toHaveLength(0);
    mgr.dispose();
  }, 30_000);

  it('amCreate provisions a worktree, prompts, settles idle, and records the session', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'My Task', agentName: 'tsuru', prompt: 'do the thing' });
    await waitFor(() => host.prompted.length === 1);
    expect(host.createdWith).toHaveLength(1);
    expect(host.createdWith[0].cwd).toContain(path.join('.origami', 'worktrees', 'my-task'));
    expect(host.createdWith[0].agentName).toBe('tsuru');
    const mid = rowsOf(host, repo).find((r) => r.name === 'my-task')!;
    expect(mid.state).toBe('working');
    expect(host.prompted[0].text).toBe('do the thing');
    host.resolvePrompt('end_turn');
    await done;
    const end = rowsOf(host, repo).find((r) => r.name === 'my-task')!;
    expect(end.state).toBe('idle');
    expect(end.stopReason).toBe('end_turn');
    const rec = loadState(repo).worktrees.find((r) => r.name === 'my-task')!;
    expect(rec.sessions).toEqual(['session-fake-1']);
    // git stats see an edit in the worktree
    fs.appendFileSync(path.join(rec.path, 'app.txt'), 'agent line\n');
    const stats = await readWorktreeStats(rec.path, rec.baseSha);
    expect(stats.adds).toBeGreaterThan(0);
    mgr.dispose();
  }, 30_000);

  it('amDelete closes the session FIRST, removes the worktree, and drops the record', async () => {
    const repo = await makeGitRepo();
    const created = await createWorktree(repo, 'to-del');
    const st = loadState(repo);
    st.worktrees.push({
      id: 'wdel', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: ['session-fake-1'],
    });
    saveState(repo, st);
    const host = makeHost(undefined);
    host.known = [repo];
    host.live.add('session-fake-1');
    const mgr = new AgentManager(host);
    const mgrAny = mgr as unknown as { runtime: Map<string, { state: string; sessionId?: string }> };
    mgrAny.runtime.set('wdel', { state: 'idle', sessionId: 'session-fake-1' });
    await mgr.handle({ type: 'amDelete', root: repo, id: 'wdel', deleteBranch: true });
    expect(host.closed).toEqual(['session-fake-1']);
    expect(fs.existsSync(created.path)).toBe(false);
    expect((await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${created.branch}`], repo)).ok).toBe(false);
    expect(loadState(repo).worktrees.find((r) => r.id === 'wdel')).toBeUndefined();
    mgr.dispose();
  }, 30_000);

  it('a bare record (never ran — empty sessions[]) reads as detached', async () => {
    const repo = await makeGitRepo();
    const created = await createWorktree(repo, 'leftover');
    const st = loadState(repo);
    st.worktrees.push({
      // Empty sessions[] = a bare/orphan worktree that never drove a run: detached.
      // (A record that DID run but never completed reads 'error' — see d3.)
      id: 'wleftover', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: [],
    });
    saveState(repo, st);
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    const row = rowsOf(host, repo).find((r) => r.name === 'leftover')!;
    expect(row.state).toBe('detached');
    expect(row.hasSession).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('a rejected createAgentSession surfaces the REAL error on the row', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.failCreate = 'engine failed to start: binary missing';
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amCreate', root: repo, name: 'no-engine', agentName: 'tsuru', prompt: 'x' });
    const row = rowsOf(host, repo).find((r) => r.name === 'no-engine')!;
    expect(row.state).toBe('error');
    expect(String(row.errorDetail)).toContain('binary missing');
    await mgr.handle({ type: 'amDelete', root: repo, id: String(row.id), deleteBranch: true });
    mgr.dispose();
  }, 30_000);

  it('amAddRepo registers a picked git repo (as a column); a non-repo dir is rejected without a rebroadcast', async () => {
    const repo = await makeGitRepo();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-plain-'));
    madePlain.push(plain);
    const host = makeHost(undefined);
    host.pickResult = repo;
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amAddRepo' });
    expect(host.known.map(key)).toContain(key(repo)); // saved
    expect(board(host, repo)).toBeDefined();           // appears as a column
    // a non-repo directory: amError, list + board untouched
    host.pickResult = plain;
    host.posts.length = 0;
    await mgr.handle({ type: 'amAddRepo' });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('Not a git repository'))).toBe(true);
    expect(host.known.some((k) => key(k) === key(plain))).toBe(false);
    expect(host.posts.some((p) => p.type === 'amState')).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('amRemoveRepo unregisters a repo without touching disk; the column disappears', async () => {
    const a = await makeGitRepo();
    const b = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [a, b];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    expect(board(host, a)).toBeDefined();
    await mgr.handle({ type: 'amRemoveRepo', root: a });
    expect(host.known.some((k) => key(k) === key(a))).toBe(false); // unregistered
    expect(fs.existsSync(a)).toBe(true);                           // disk untouched
    expect(fs.existsSync(path.join(a, '.git'))).toBe(true);
    expect(board(host, a)).toBeUndefined();                        // column gone
    expect(board(host, b)).toBeDefined();
    mgr.dispose();
  }, 30_000);

  it('dispose() permanently stops the poll loop even around an in-flight run', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' }); // arms the poll chain
    mgr.dispose();
    // a manual re-entry (standing in for an in-flight pollOnce's re-arm) must not resurrect the timer
    const mgrAny = mgr as unknown as { pollOnce: () => Promise<void>; pollTimer: unknown; schedulePoll: (d: number) => void };
    await mgrAny.pollOnce();
    mgrAny.schedulePoll(0);
    expect(mgrAny.pollTimer).toBeUndefined();
    mgr.dispose();
  }, 30_000);

  // ---- S3.7 queue: amCreate start:false / amStart / amStartAll ----

  /** Queue a task against the repo and return the created row's id. */
  async function queue(mgr: AgentManager, host: FakeHost, root: string, name: string, prompt: string, model = ''): Promise<string> {
    await mgr.handle({ type: 'amCreate', root, name, agentName: 'tsuru', prompt, model, start: false });
    return String(rowsOf(host, root).find((r) => r.name === name)!.id);
  }

  it('(q1) amCreate start:false persists the queuedTask, creates NO session, row is queued', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amCreate', root: repo, name: 'q1', agentName: 'tsuru', prompt: 'do q1', model: 'lmstudio/x', start: false });
    const rec = loadState(repo).worktrees.find((r) => r.name === 'q1')!;
    expect(rec.queuedTask).toEqual({ prompt: 'do q1', agentName: 'tsuru', model: 'lmstudio/x' });
    expect(fs.existsSync(rec.path)).toBe(true);       // worktree provisioned
    expect(host.createdWith).toHaveLength(0);          // but NO session created
    expect(host.prompted).toHaveLength(0);
    const row = rowsOf(host, repo).find((r) => r.name === 'q1')!;
    expect(row.state).toBe('queued');
    expect(row.hasSession).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('(q2) a reloaded manager keeps the queuedTask and shows the row as queued (not detached)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await queue(mgr, host, repo, 'q2', 'do q2', 'lmstudio/x');
    mgr.dispose();
    // fresh manager over the same repo = a reload (boot reconcile runs)
    const host2 = makeHost(undefined);
    host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    expect(loadState(repo).worktrees.find((r) => r.name === 'q2')!.queuedTask).toEqual({ prompt: 'do q2', agentName: 'tsuru', model: 'lmstudio/x' });
    const row = rowsOf(host2, repo).find((r) => r.name === 'q2')!;
    expect(row.state).toBe('queued'); // NOT 'detached'
    mgr2.dispose();
  }, 30_000);

  it('(q3) amStart runs the stored task: session + pin(model) + prompt(text), clears the task, working->idle', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'q3', 'run q3', 'lmstudio/pin');
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.createdWith).toHaveLength(1);
    expect(host.modelPins).toEqual([{ sessionId: host.prompted[0].sessionId, modelId: 'lmstudio/pin' }]);
    expect(host.order.indexOf('pin')).toBeLessThan(host.order.indexOf('prompt'));
    expect(host.prompted[0].text).toBe('run q3');
    expect(loadState(repo).worktrees.find((r) => r.name === 'q3')!.queuedTask).toBeUndefined(); // cleared
    expect(rowsOf(host, repo).find((r) => r.name === 'q3')!.state).toBe('working');
    host.resolvePrompt('end_turn');
    await done;
    expect(rowsOf(host, repo).find((r) => r.name === 'q3')!.state).toBe('idle');
    mgr.dispose();
  }, 30_000);

  it('(q4) a queued task with no model pins the repo default resolved AT START time', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'q4', 'go', ''); // queued with NO model
    // The default is set AFTER queuing -> proves resolution happens at start, not queue.
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: 'lmstudio/deflt' });
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.modelPins.map((p) => p.modelId)).toEqual(['lmstudio/deflt']);
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(q5) Cancel during a start closes the session but KEEPS the worktree + queuedTask, back to queued', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferCreate = true; // park inside createAgentSession during the start
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'q5', 'later', 'lmstudio/x'); // queuing makes no session, deferCreate is inert here
    const path0 = rowsOf(host, repo).find((r) => r.name === 'q5')!.path as string;
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.createdWith.length === 1);       // parked mid-start
    expect(rowsOf(host, repo).find((r) => r.name === 'q5')!.state).toBe('provisioning');
    await mgr.handle({ type: 'amCancel', root: repo, id });
    host.releaseCreate();
    await done;
    expect(host.closed).toContain('session-fake-1');          // session torn down
    expect(host.prompted).toHaveLength(0);                    // task never ran
    expect(fs.existsSync(path0)).toBe(true);                  // worktree SURVIVES (it pre-existed the start)
    expect(loadState(repo).worktrees.find((r) => r.name === 'q5')!.queuedTask).toEqual({ prompt: 'later', agentName: 'tsuru', model: 'lmstudio/x' });
    expect(rowsOf(host, repo).find((r) => r.name === 'q5')!.state).toBe('queued'); // restored
    mgr.dispose();
  }, 30_000);

  it('(q6) amStartAll starts every queued record in the repo — and only that repo', async () => {
    const a = await makeGitRepo();
    const b = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [a, b];
    const mgr = new AgentManager(host);
    await queue(mgr, host, a, 'a1', 'ta1');
    await queue(mgr, host, a, 'a2', 'ta2');
    await queue(mgr, host, b, 'b1', 'tb1');
    await mgr.handle({ type: 'amStartAll', root: a });
    await waitFor(() => host.prompted.length === 2);          // both of A's tasks fired
    expect(host.createdWith).toHaveLength(2);
    const started = new Set(host.prompted.map((p) => p.text));
    expect(started).toEqual(new Set(['ta1', 'ta2']));
    // B's task is untouched: still queued on disk and on the board.
    expect(loadState(b).worktrees.find((r) => r.name === 'b1')!.queuedTask).toBeDefined();
    expect(rowsOf(host, b).find((r) => r.name === 'b1')!.state).toBe('queued');
    host.resolvePrompt('end_turn');
    host.resolvePrompt('end_turn');
    await waitFor(() => rowsOf(host, a).filter((r) => r.state === 'idle').length === 2);
    mgr.dispose();
  }, 30_000);

  it('(q7) amStart on a record with NO queued task errors and does nothing', async () => {
    const repo = await makeGitRepo();
    await seedWorktree(repo, 'plain'); // a plain record — no queuedTask
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' }); // reconcile -> detached
    const id = String(rowsOf(host, repo).find((r) => r.name === 'plain')!.id);
    host.posts.length = 0;
    await mgr.handle({ type: 'amStart', root: repo, id });
    expect(host.posts.some((p) => p.type === 'amError')).toBe(true);
    expect(host.createdWith).toHaveLength(0);            // no session
    expect(host.prompted).toHaveLength(0);               // no task run
    expect(host.posts.some((p) => p.type === 'amState')).toBe(false); // a rejection doesn't rebroadcast
    mgr.dispose();
  }, 30_000);

  it('(defect 1) a start whose model pin fails closes the session and leaves the task retryable', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'requeue', 'run me', 'lmstudio/pin');
    host.failSetModel = 'invalid model id';
    await mgr.handle({ type: 'amStart', root: repo, id });
    const errored = rowsOf(host, repo).find((r) => r.name === 'requeue')!;
    expect(errored.state).toBe('error');
    expect(String(errored.errorDetail).toLowerCase()).toContain('model pin');
    expect(host.closed).toContain('session-fake-1'); // the orphan session is torn down, not left running
    expect(loadState(repo).worktrees.find((r) => r.name === 'requeue')!.queuedTask).toBeDefined(); // task survives the failure
    expect(errored.hasSession).toBe(false);
    // Retry now succeeds — the live-session guard is NOT tripped by an orphan.
    host.failSetModel = undefined;
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.prompted[0].text).toBe('run me');
    expect(loadState(repo).worktrees.find((r) => r.name === 'requeue')!.queuedTask).toBeUndefined(); // cleared on the successful start
    host.resolvePrompt('end_turn');
    await done;
    expect(rowsOf(host, repo).find((r) => r.name === 'requeue')!.state).toBe('idle');
    mgr.dispose();
  }, 30_000);

  it('(defect 2) Delete during a START provisioning says Cancel KEEPS the worktree (not tears it down)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.deferCreate = true; // park inside createAgentSession during the start window
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'starting', 'go', 'lmstudio/x');
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.createdWith.length === 1); // provisioning, busy, worktree already on disk
    expect(rowsOf(host, repo).find((r) => r.name === 'starting')!.state).toBe('provisioning');
    host.posts.length = 0;
    await mgr.handle({ type: 'amDelete', root: repo, id, deleteBranch: true });
    const err = host.posts.find((p) => p.type === 'amError');
    expect(err).toBeDefined();
    expect(String(err!.message)).toContain('keeps the worktree');
    expect(String(err!.message)).not.toContain('tears the worktree down');
    expect(loadState(repo).worktrees.find((r) => r.name === 'starting')!.queuedTask).toBeDefined(); // Delete was a no-op, task intact
    // settle: cancel the start (keeps the worktree) so dispose is clean
    await mgr.handle({ type: 'amCancel', root: repo, id });
    host.releaseCreate();
    await done;
    expect(rowsOf(host, repo).find((r) => r.name === 'starting')!.state).toBe('queued');
    mgr.dispose();
  }, 30_000);

  // ---- S3.8 honest states: dead-session error + persisted completion + editable queue ----

  it('(s1) a working row whose engine session has died reads as error, not detached', async () => {
    const repo = await makeGitRepo();
    const created = await createWorktree(repo, 'died');
    const st = loadState(repo);
    st.worktrees.push({
      id: 'wdied', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: ['session-gone'],
    });
    saveState(repo, st);
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    // A live working runtime whose session id is NOT in host.live (it died mid-run).
    (mgr as unknown as { runtime: Map<string, { state: string; sessionId?: string }> })
      .runtime.set('wdied', { state: 'working', sessionId: 'session-gone' });
    await mgr.handle({ type: 'amRequestState' });
    const row = rowsOf(host, repo).find((r) => r.name === created.name)!;
    expect(row.state).toBe('error'); // red, NOT 'detached'
    expect(String(row.errorDetail).toLowerCase()).toContain('engine session died');
    expect(row.hasSession).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('(s2) a completed run persists as done and reloads as idle with its stopReason (not detached)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'finished', agentName: 'tsuru', prompt: 'do it' });
    await waitFor(() => host.prompted.length === 1);
    host.resolvePrompt('stop_reason_end');
    await done;
    expect(loadState(repo).worktrees.find((r) => r.name === 'finished')!.done)
      .toEqual({ stopReason: 'stop_reason_end', at: expect.any(Number) });
    mgr.dispose();
    // A fresh manager over the same repo = a window reload (boot reconcile runs).
    const host2 = makeHost(undefined);
    host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    const row = rowsOf(host2, repo).find((r) => r.name === 'finished')!;
    expect(row.state).toBe('idle');                 // stays done, NOT 'detached'
    expect(row.stopReason).toBe('stop_reason_end');
    expect(row.hasSession).toBe(false);             // session is gone -> Chat hidden
    mgr2.dispose();
  }, 30_000);

  it('(s3) runStart clears a stale done marker at start and re-persists it on completion', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 's3', 'go s3', 'lmstudio/pin');
    // Simulate a record carrying a stale done marker alongside its queued task.
    const st = loadState(repo);
    st.worktrees.find((r) => r.id === id)!.done = { stopReason: 'old', at: 1 };
    saveState(repo, st);
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.done).toBeUndefined(); // cleared at start
    expect(host.prompted[0].text).toBe('go s3');
    expect(host.modelPins).toEqual([{ sessionId: host.prompted[0].sessionId, modelId: 'lmstudio/pin' }]);
    host.resolvePrompt('end_turn');
    await done;
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask).toBeUndefined(); // task cleared
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.done)
      .toEqual({ stopReason: 'end_turn', at: expect.any(Number) });                       // fresh completion
    expect(rowsOf(host, repo).find((r) => r.id === id)!.state).toBe('idle');
    mgr.dispose();
  }, 30_000);

  it('(s4) amUpdateQueued edits a queued task, survives reload, refused while busy / not queued / unknown root', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 's4', 'old prompt', 'lmstudio/old');
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, prompt: 'new prompt', model: 'lmstudio/new' });
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask)
      .toEqual({ prompt: 'new prompt', agentName: 'tsuru', model: 'lmstudio/new' });
    const row = rowsOf(host, repo).find((r) => r.id === id)!;
    expect(row.queuedPrompt).toBe('new prompt'); // board reflects the edit
    expect(row.model).toBe('lmstudio/new');
    // model may be cleared to '' ("repo default resolved at start time")
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, model: '' });
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask!.model).toBe('');
    // refused while a start is in flight (busy): no field change, no rebroadcast beyond the start's own
    host.deferCreate = true;
    const startP = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.createdWith.length === 1);
    host.posts.length = 0;
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, prompt: 'blocked' });
    expect(host.posts.some((p) => p.type === 'amError')).toBe(true);
    expect(host.posts.some((p) => p.type === 'amState')).toBe(false);
    // settle: cancel the start (keeps the worktree + queued task), unblock the create
    await mgr.handle({ type: 'amCancel', root: repo, id });
    host.releaseCreate();
    await startP;
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask!.prompt).toBe('new prompt'); // refused edit didn't land
    mgr.dispose();
    // survives a reload
    const host2 = makeHost(undefined);
    host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask!.prompt).toBe('new prompt');
    // refused without a queued task (a plain record), no side effects
    await seedWorktree(repo, 'plain-s4');
    await mgr2.handle({ type: 'amRequestState' });
    const plainId = String(rowsOf(host2, repo).find((r) => r.name === 'plain-s4')!.id);
    host2.posts.length = 0;
    await mgr2.handle({ type: 'amUpdateQueued', root: repo, id: plainId, prompt: 'x' });
    expect(host2.posts.some((p) => p.type === 'amError')).toBe(true);
    expect(loadState(repo).worktrees.find((r) => r.id === plainId)!.queuedTask).toBeUndefined();
    expect(host2.posts.some((p) => p.type === 'amState')).toBe(false);
    // refused for an unknown root
    host2.posts.length = 0;
    await mgr2.handle({ type: 'amUpdateQueued', root: path.join(os.tmpdir(), 'origami-am-nope-x'), id, prompt: 'x' });
    expect(host2.posts.some((p) => p.type === 'amError' && String(p.message).includes('Repository not available'))).toBe(true);
    mgr2.dispose();
  }, 30_000);

  it('(s5) starting a queued task after an edit uses the UPDATED prompt and model', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 's5', 'orig prompt', 'lmstudio/orig');
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, prompt: 'edited task', model: 'lmstudio/edited' });
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.prompted[0].text).toBe('edited task'); // promptSession got the new text
    expect(host.modelPins).toEqual([{ sessionId: host.prompted[0].sessionId, modelId: 'lmstudio/edited' }]); // pin honours the new pick
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(s6) a fresh reconcile does not clobber a done marker written by another window during listWorktrees', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 's6', 'run me', 'lmstudio/pin'); // record with a queuedTask, worktree live
    mgr.dispose();
    // A fresh window boots. ensureReconciled reads state, then AWAITS listWorktrees
    // (a real git subprocess). We land the "other window" write during that await:
    // the queued task was started and completed elsewhere (queuedTask cleared +
    // done persisted). The reconcile must read state AFTER the await, not clobber it.
    const host2 = makeHost(undefined);
    host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    const p = mgr2.handle({ type: 'amRequestState' }); // suspends in ensureReconciled at `await listWorktrees`
    const concurrent = loadState(repo);
    const rec = concurrent.worktrees.find((r) => r.id === id)!;
    delete rec.queuedTask;                                 // window A started it (run.ts runStart)
    rec.done = { stopReason: 'other_window_done', at: Date.now() }; // and it finished (persistDone)
    saveState(repo, concurrent);                           // lands DURING mgr2's listWorktrees await
    await p;
    const after = loadState(repo).worktrees.find((r) => r.id === id)!;
    expect(after.done).toEqual({ stopReason: 'other_window_done', at: expect.any(Number) }); // survived
    expect(after.queuedTask).toBeUndefined();                                                 // not resurrected
    const row = rowsOf(host2, repo).find((r) => r.id === id)!;
    expect(row.state).toBe('idle');                        // seeded done, NOT queued/detached
    expect(row.stopReason).toBe('other_window_done');
    mgr2.dispose();
  }, 30_000);

  // ---- S3.9 death-proof completion + Chat on Done ----

  it('(d1) a run whose engine dies as the prompt resolves goes error and persists NO done marker', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'dyingatend', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    const sess = host.prompted[0].sessionId;
    host.live.delete(sess);             // engine dies before the resolution is observed
    host.resolvePrompt('end_turn');     // the (now-lying) stop reason arrives
    await done;
    const row = rowsOf(host, repo).find((r) => r.name === 'dyingatend')!;
    expect(row.state).toBe('error');
    expect(String(row.errorDetail)).toContain('engine died as the run ended');
    expect(loadState(repo).worktrees.find((r) => r.name === 'dyingatend')!.done).toBeUndefined(); // NO done marker
    mgr.dispose();
    // a fresh manager reloads it NOT as idle (it ran, never completed -> error)
    const host2 = makeHost(undefined); host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    expect(rowsOf(host2, repo).find((r) => r.name === 'dyingatend')!.state).not.toBe('idle');
    mgr2.dispose();
  }, 30_000);

  it('(d2) a runCreate failure closes the session and the errored row claims no live session', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.failSetModel = 'invalid model id'; // fails AFTER the session exists (post model-pin)
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amCreate', root: repo, name: 'createfail', agentName: 'tsuru', prompt: 'go', model: 'lmstudio/nope' });
    const row = rowsOf(host, repo).find((r) => r.name === 'createfail')!;
    expect(row.state).toBe('error');
    expect(host.closed).toContain('session-fake-1'); // the zombie session torn down (catch parity)
    expect(row.hasSession).toBe(false);              // the errored card no longer claims a live session
    mgr.dispose();
  }, 30_000);

  it('(d3) a reloaded record that ran (non-empty sessions[]) but never completed reads as error', async () => {
    const repo = await makeGitRepo();
    const created = await createWorktree(repo, 'incomplete');
    const st = loadState(repo);
    st.worktrees.push({
      id: 'wincomplete', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: ['session-prev'], // it ran
    });
    saveState(repo, st);
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    const row = rowsOf(host, repo).find((r) => r.name === created.name)!;
    expect(row.state).toBe('error');                 // red, NOT detached
    expect(String(row.errorDetail)).toContain('run never completed');
    expect(row.hasSession).toBe(false);
    mgr.dispose();
  }, 30_000);

  it('(d4) the engine session id is persisted on the record at create-start and at queued-start', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    // create-start
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'eng-create', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    const sess1 = host.prompted[0].sessionId;
    expect(loadState(repo).worktrees.find((r) => r.name === 'eng-create')!.engineSessionId).toBe(`engine-${sess1}`);
    host.resolvePrompt('end_turn');
    await done;
    // queued-start
    const id = await queue(mgr, host, repo, 'eng-queue', 'later');
    const done2 = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 2);
    const sess2 = host.prompted[1].sessionId;
    expect(loadState(repo).worktrees.find((r) => r.name === 'eng-queue')!.engineSessionId).toBe(`engine-${sess2}`);
    host.resolvePrompt('end_turn');
    await done2;
    mgr.dispose();
  }, 30_000);

  it('(d5) Chat on a Done card reopens the transcript from the persisted engine id (once); no id -> amError', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'chatme', agentName: 'tsuru', prompt: 'do it' });
    await waitFor(() => host.prompted.length === 1);
    const sess = host.prompted[0].sessionId;
    host.resolvePrompt('end_turn');
    await done;
    const id = String(rowsOf(host, repo).find((r) => r.name === 'chatme')!.id);
    const engineId = loadState(repo).worktrees.find((r) => r.id === id)!.engineSessionId!;
    expect(engineId).toBe(`engine-${sess}`);
    // The engine child dies: the card is Done with no live session.
    host.live.delete(sess);
    host.deferReopen = true;
    // Two Chat clicks in flight -> the reopen must fire exactly once.
    const c1 = mgr.handle({ type: 'amOpenChat', root: repo, id });
    const c2 = mgr.handle({ type: 'amOpenChat', root: repo, id });
    await waitFor(() => host.reopenEntered.length === 1);
    host.releaseReopen();
    await Promise.all([c1, c2]);
    expect(host.reopened).toHaveLength(1);                         // reopened ONCE despite the double-click
    expect(host.reopened[0].engineId).toBe(engineId);
    expect(host.reopened[0].agentName).toBe('tsuru');             // rt agentName threaded through
    expect(host.reopened[0].cwd).toContain('chatme');            // worktree cwd passed (not omitted)
    expect(rowsOf(host, repo).find((r) => r.id === id)!.hasSession).toBe(true); // runtime now points at the live reopened session
    // A record with NO persisted engine id cannot reopen — amError, no reopen.
    await seedWorktree(repo, 'noeng');
    await mgr.handle({ type: 'amRequestState' });
    const noEngId = String(rowsOf(host, repo).find((r) => r.name === 'noeng')!.id);
    host.posts.length = 0;
    await mgr.handle({ type: 'amOpenChat', root: repo, id: noEngId });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('No transcript recorded'))).toBe(true);
    expect(host.reopened).toHaveLength(1);                         // unchanged — no new reopen
    mgr.dispose();
  }, 30_000);

  it('(d6) Delete during an in-flight Chat reopen is refused (no worktree race) and works after it settles', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'racer', agentName: 'tsuru', prompt: 'do it' });
    await waitFor(() => host.prompted.length === 1);
    const sess = host.prompted[0].sessionId;
    host.resolvePrompt('end_turn');
    await done;
    const id = String(rowsOf(host, repo).find((r) => r.name === 'racer')!.id);
    const wtPath = loadState(repo).worktrees.find((r) => r.id === id)!.path;
    host.live.delete(sess);           // engine child gone: Done card, dead session
    host.deferReopen = true;
    const chat = mgr.handle({ type: 'amOpenChat', root: repo, id }); // reopen spawns a fresh child, in flight
    await waitFor(() => host.reopenEntered.length === 1);
    host.posts.length = 0;
    await mgr.handle({ type: 'amDelete', root: repo, id, deleteBranch: false }); // races the reopen
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('reopening'))).toBe(true);
    expect(loadState(repo).worktrees.find((r) => r.id === id)).toBeDefined();     // NOT deleted mid-reopen
    expect(fs.existsSync(wtPath)).toBe(true);                                     // worktree dir intact
    host.releaseReopen();
    await chat;
    expect(rowsOf(host, repo).find((r) => r.id === id)!.hasSession).toBe(true);   // record now points at the live reopened session
    await mgr.handle({ type: 'amDelete', root: repo, id, deleteBranch: false });  // reopen settled -> delete proceeds
    expect(host.closed.some((s) => s.startsWith('session-reopened'))).toBe(true); // the reopened session is closed, not leaked
    expect(loadState(repo).worktrees.find((r) => r.id === id)).toBeUndefined();   // record gone
    mgr.dispose();
  }, 30_000);

  it('(d7) retry-Start survives a Chat-reopen on an errored+queued card (viewer session superseded)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'errqueue', 'run me', 'lmstudio/pin');
    host.failSetModel = 'invalid model id';
    await mgr.handle({ type: 'amStart', root: repo, id });          // errors AFTER the engine id is recorded; task stays queued
    expect(rowsOf(host, repo).find((r) => r.id === id)!.state).toBe('error');
    await mgr.handle({ type: 'amOpenChat', root: repo, id });       // Chat-reopen the transcript on the errored card
    expect(host.reopened).toHaveLength(1);
    expect(rowsOf(host, repo).find((r) => r.id === id)!.hasSession).toBe(true); // a live viewer session now sits on the row
    host.closed.length = 0;
    host.failSetModel = undefined;
    const done = mgr.handle({ type: 'amStart', root: repo, id });   // retry must NOT be vetoed by the viewer
    await waitFor(() => host.prompted.length === 1);
    expect(host.prompted[0].text).toBe('run me');                   // the queued task actually ran
    expect(host.closed.some((s) => s.startsWith('session-reopened'))).toBe(true); // viewer superseded, not leaked
    host.resolvePrompt('end_turn');
    await done;
    expect(rowsOf(host, repo).find((r) => r.id === id)!.state).toBe('idle');
    mgr.dispose();
  }, 30_000);

  it('(d8) after a reload, Chat-on-Done reopens with the agent that produced the transcript', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.sessionModes = [{ id: 'kaida', name: 'Kaida' }]; // S6a: a typed run needs a REAL mode to apply
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'named', agentName: 'kaida', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    host.resolvePrompt('end_turn');
    await done;
    expect(loadState(repo).worktrees.find((r) => r.name === 'named')!.agentName).toBe('kaida'); // persisted on the record
    mgr.dispose();
    // Fresh window: reconcile seeds 'idle' with NO runtime agentName; the engine child is gone.
    const host2 = makeHost(undefined); host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    const id = String(rowsOf(host2, repo).find((r) => r.name === 'named')!.id);
    await mgr2.handle({ type: 'amOpenChat', root: repo, id });
    expect(host2.reopened).toHaveLength(1);
    expect(host2.reopened[0].agentName).toBe('kaida'); // from rec.agentName, not the global default (undefined)
    mgr2.dispose();
  }, 30_000);

  // ---- S4 diff view + apply-to-main (ApplyController routed through the owner) ----

  /** A worktree + record whose working tree has been edited (uncommitted). */
  async function seedChangedWorktree(repo: string, name: string, edit: (wtPath: string) => void): Promise<{ id: string; path: string; baseSha: string }> {
    await runGit(['config', 'core.autocrlf', 'false'], repo); // apply roundtrips need stable EOLs (system default is true here)
    const created = await createWorktree(repo, name);
    const id = `w-${name}`;
    const st = loadState(repo);
    st.worktrees.push({ id, name: created.name, branch: created.branch, path: created.path, baseSha: created.baseSha, createdAt: Date.now(), sessions: [] });
    saveState(repo, st);
    edit(created.path);
    return { id, path: created.path, baseSha: created.baseSha };
  }
  const lastPost = (host: FakeHost, type: string) => [...host.posts].reverse().find((p) => p.type === type);

  it('(c1) amDiffFiles posts the worktree change set for the card', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c1', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nagent line\n'));
    await mgr.handle({ type: 'amRequestState' });
    host.posts.length = 0;
    await mgr.handle({ type: 'amDiffFiles', root: repo, id });
    const reply = lastPost(host, 'amDiffFiles') as { id: string; files: Array<{ path: string; adds: number }> } | undefined;
    expect(reply).toBeDefined();
    expect(reply!.id).toBe(id);
    expect(reply!.files.map((f) => f.path)).toContain('app.txt');
    expect(reply!.files.find((f) => f.path === 'app.txt')!.adds).toBeGreaterThan(0);
    mgr.dispose();
  }, 30_000);

  it('(c2) amOpenFileDiff calls host.openFileDiff with worktree/base/relPath and the right-side abs path', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id, path: wtPath, baseSha } = await seedChangedWorktree(repo, 'c2', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'edited\n'));
    await mgr.handle({ type: 'amOpenFileDiff', root: repo, id, path: 'app.txt' });
    expect(host.diffOpened).toHaveLength(1);
    expect(host.diffOpened[0]).toMatchObject({ worktree: wtPath, base: baseSha, relPath: 'app.txt', rightFsPath: path.join(wtPath, 'app.txt'), title: 'app.txt' });
    mgr.dispose();
  }, 30_000);

  // ---- S6c roster pre-fill (a fresh window's empty picker seeds from a live session) ----

  it('(pf1) opening the board with an empty roster pre-fills agent types harvested from a live session', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.anySessionModes = [{ id: 'build', name: 'Build', default: true }, { id: 'plan', name: 'Plan' }];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    // The harvested modes rode the very amState the board request emitted...
    expect(lastAmState(host)!.agentTypes.map((t) => t.id)).toEqual(['build', 'plan']);
    // ...and were persisted (globalState), so later picks read them without a re-harvest.
    expect(host.agentTypesStore.map((t) => t.id)).toEqual(['build', 'plan']);
    mgr.dispose();
  }, 30_000);

  it('(pf2) a richer persisted roster is NOT shrunk by a smaller/later harvest', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.agentTypesStore = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }, { id: 'reviewer', name: 'Reviewer' }];
    host.anySessionModes = [{ id: 'build', name: 'Build', default: true }]; // a smaller harvest
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    // The persisted roster already has real options, so pre-fill leaves it intact —
    // every entry survives, none dropped to match the tiny harvest.
    expect(lastAmState(host)!.agentTypes.map((t) => t.id)).toEqual(['build', 'plan', 'reviewer']);
    mgr.dispose();
  }, 30_000);

  it('(pf3) with no live session that knows its modes, the empty roster stays empty (degrades to Tsuru)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.anySessionModes = null; // fresh window, no client is up yet
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    expect(lastAmState(host)!.agentTypes).toEqual([]);
    expect(host.agentTypesStore).toEqual([]);
    mgr.dispose();
  }, 30_000);

  // ---- S6d race compare (per-sibling per-file diff TEXT + the A-vs-B cross-diff) ----

  it('(rc1) amRaceFileDiffs posts each sibling\'s per-file UNIFIED DIFF text keyed by id (the union the screen renders)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const a = await seedChangedWorktree(repo, 'rc1a', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nfrom a\n'));
    const b = await seedChangedWorktree(repo, 'rc1b', (wt) => {
      fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nfrom b\n');
      fs.writeFileSync(path.join(wt, 'only-b.txt'), 'b only\n'); // new file — markUntracked surfaces it
    });
    host.posts.length = 0;
    await mgr.handle({ type: 'amRaceFileDiffs', root: repo, ids: [a.id, b.id] });
    const reply = lastPost(host, 'amRaceFileDiffs') as { ids: string[]; diffs: Record<string, Array<{ path: string; adds: number; text: string; binary: boolean; truncated: boolean }>> } | undefined;
    expect(reply).toBeDefined();
    expect(reply!.ids).toEqual([a.id, b.id]);
    // A touched only app.txt; B touched app.txt AND only-b.txt — so the screen's union
    // is {app.txt (both), only-b.txt (B only)}: exactly what gates the A-vs-B button.
    expect(reply!.diffs[a.id].map((f) => f.path)).toEqual(['app.txt']);
    expect(reply!.diffs[b.id].map((f) => f.path).sort()).toEqual(['app.txt', 'only-b.txt']);
    // The column renders REAL hunks, not just a count: each sibling's own edit is
    // visible in its diff text (this is what the numbers table could not show).
    const aApp = reply!.diffs[a.id].find((f) => f.path === 'app.txt')!;
    expect(aApp.adds).toBeGreaterThan(0);
    expect(aApp.binary).toBe(false);
    expect(aApp.truncated).toBe(false);
    expect(aApp.text).toContain('+from a');
    expect(reply!.diffs[b.id].find((f) => f.path === 'app.txt')!.text).toContain('+from b');
    mgr.dispose();
  }, 30_000);

  it('(rc2) amCrossDiff opens a native diff of the two siblings\' on-disk files with the right paths + title', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const a = await seedChangedWorktree(repo, 'rc2a', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nfrom a\n'));
    const b = await seedChangedWorktree(repo, 'rc2b', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nfrom b\n'));
    const nameA = loadState(repo).worktrees.find((r) => r.id === a.id)!.name;
    const nameB = loadState(repo).worktrees.find((r) => r.id === b.id)!.name;
    await mgr.handle({ type: 'amCrossDiff', root: repo, ids: [a.id, b.id], path: 'app.txt' });
    expect(host.crossDiffs).toHaveLength(1);
    expect(host.crossDiffs[0]).toEqual({
      leftFsPath: path.join(a.path, 'app.txt'),
      rightFsPath: path.join(b.path, 'app.txt'),
      title: `app.txt: ${nameA} vs ${nameB}`,
    });
    mgr.dispose();
  }, 30_000);

  it('(rc3) amCrossDiff with a missing sibling is a quiet no-op (nothing opened)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const a = await seedChangedWorktree(repo, 'rc3a', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nx\n'));
    await mgr.handle({ type: 'amCrossDiff', root: repo, ids: [a.id, 'does-not-exist'], path: 'app.txt' });
    expect(host.crossDiffs).toHaveLength(0);
    mgr.dispose();
  }, 30_000);

  it('(c3) amApply happy path applies to main, toasts info, posts amApplyResult ok:true, deletes the patch', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c3', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nfrom the agent\n'));
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toBe('v1\nfrom the agent\n'); // landed in main working tree
    expect((await runGit(['rev-list', '--count', 'HEAD'], repo)).output.trim()).toBe('1');    // NOT committed
    expect((await runGit(['diff', '--cached', '--name-only'], repo)).output.trim()).toBe('');  // NOT staged
    expect(host.infos.some((m) => /Applied 1 file\(s\)/.test(m))).toBe(true);
    const res = lastPost(host, 'amApplyResult') as { id: string; ok: boolean } | undefined;
    expect(res).toMatchObject({ id, ok: true });
    mgr.dispose();
  }, 30_000);

  it('(c4) amApply with a conflict (main diverged) posts ok:false + conflicts, no info, main untouched', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c4', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'agent\n'));
    fs.writeFileSync(path.join(repo, 'app.txt'), 'human uncommitted\n'); // main diverges (does not match index)
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    const res = lastPost(host, 'amApplyResult') as { id: string; ok: boolean; conflicts: string[] } | undefined;
    expect(res!.ok).toBe(false);
    expect(res!.conflicts).toContain('app.txt');
    expect(host.infos).toHaveLength(0);                                          // no success toast
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toBe('human uncommitted\n'); // untouched
    mgr.dispose();
  }, 30_000);

  it('(c5) amApply force over a committed divergence opens the conflicted files and reports conflicts', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c5', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nagent\n'));
    fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\nhuman\n');
    await runGit(['commit', '-am', 'human'], repo); // committed divergence -> 3way leaves markers
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'], force: true });
    expect(host.conflictOpened).toHaveLength(1);
    expect(host.conflictOpened[0]).toContain(path.join(repo, 'app.txt'));
    const res = lastPost(host, 'amApplyResult') as { ok: boolean; conflicts: string[] } | undefined;
    expect(res!.ok).toBe(false);
    expect(res!.conflicts).toContain('app.txt');
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toContain('<<<<<<<'); // markers written
    mgr.dispose();
  }, 30_000);

  it('(c6) amApply is refused for an unknown root and for a busy record (no apply)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c6', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'agent\n'));
    // unknown root -> actionRoot posts amError, nothing applies
    host.posts.length = 0;
    await mgr.handle({ type: 'amApply', root: path.join(os.tmpdir(), 'origami-am-nope-c6'), id, files: ['app.txt'] });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('Repository not available'))).toBe(true);
    expect(host.posts.some((p) => p.type === 'amApplyResult')).toBe(false);
    // busy record -> refused via amApplyResult (so the pane's "Applying…" resets,
    // never hangs), no apply, main untouched
    (mgr as unknown as { busy: Set<string> }).busy.add(id);
    host.posts.length = 0;
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    const busyRes = lastPost(host, 'amApplyResult') as { ok: boolean; error?: string } | undefined;
    expect(busyRes!.ok).toBe(false);
    expect(String(busyRes!.error)).toContain('busy');
    expect(host.infos).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toBe('v1\n'); // main untouched
    mgr.dispose();
  }, 30_000);

  it('(c7) amApply is refused for a LIVE working agent (worktree still mutating), main untouched', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'c7', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'half-written\n'));
    host.live.add('live-c7'); // the agent's session is alive
    (mgr as unknown as { runtime: Map<string, { state: string; sessionId?: string }> }).runtime.set(id, { state: 'working', sessionId: 'live-c7' });
    host.posts.length = 0;
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    const res = lastPost(host, 'amApplyResult') as { ok: boolean; error?: string } | undefined;
    expect(res!.ok).toBe(false);
    expect(String(res!.error)).toMatch(/still running/i);
    expect(host.infos).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toBe('v1\n'); // NOT promoted mid-run
    mgr.dispose();
  }, 30_000);

  it('(c8) a buildPatch failure (worktree gone) posts amApplyResult with an error, never hangs', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id, path: wtPath } = await seedChangedWorktree(repo, 'c8', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'x\n'));
    fs.rmSync(wtPath, { recursive: true, force: true }); // the worktree dir vanished under us
    host.posts.length = 0;
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    const res = lastPost(host, 'amApplyResult') as { ok: boolean; error?: string } | undefined;
    expect(res).toBeDefined();
    expect(res!.ok).toBe(false);
    expect(typeof res!.error).toBe('string');
    mgr.dispose();
  }, 30_000);

  it('(c9) two concurrent applies on the same repo both land (serialized, no index.lock race)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const a = await seedChangedWorktree(repo, 'c9a', (wt) => fs.writeFileSync(path.join(wt, 'a9.txt'), 'from a\n'));
    const b = await seedChangedWorktree(repo, 'c9b', (wt) => fs.writeFileSync(path.join(wt, 'b9.txt'), 'from b\n'));
    await runGit(['add', 'a9.txt'], a.path); // track the new file so it shows in baseSha..working-tree
    await runGit(['add', 'b9.txt'], b.path);
    await Promise.all([
      mgr.handle({ type: 'amApply', root: repo, id: a.id, files: ['a9.txt'] }),
      mgr.handle({ type: 'amApply', root: repo, id: b.id, files: ['b9.txt'] }),
    ]);
    expect(fs.readFileSync(path.join(repo, 'a9.txt'), 'utf8')).toBe('from a\n');
    expect(fs.readFileSync(path.join(repo, 'b9.txt'), 'utf8')).toBe('from b\n');
    const oks = (host.posts.filter((p) => p.type === 'amApplyResult') as Array<{ ok: boolean }>).filter((r) => r.ok);
    expect(oks).toHaveLength(2);
    mgr.dispose();
  }, 30_000);

  // ---- S4.1 Merged category: a clean apply retires the card ----

  it('(m1) a clean apply stamps merged on the record and the follow-up broadcast row carries mergedAt', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'm1', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nmerged line\n'));
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    const rec = loadState(repo).worktrees.find((r) => r.id === id)!;
    expect(rec.merged).toEqual({ at: expect.any(Number) });          // stamped on disk
    const row = rowsOf(host, repo).find((r) => r.id === id)!;
    expect(row.mergedAt as number).toBeGreaterThan(0);               // broadcast row carries it
    mgr.dispose();
  }, 30_000);

  it('(m2) merged survives a reload; seeding is unchanged (a never-ran record still seeds detached)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const { id } = await seedChangedWorktree(repo, 'm2', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nmerged\n'));
    await mgr.handle({ type: 'amApply', root: repo, id, files: ['app.txt'] });
    mgr.dispose();
    // Fresh manager over the same repo = a window reload (boot reconcile runs).
    const host2 = makeHost(undefined); host2.known = [repo];
    const mgr2 = new AgentManager(host2);
    await mgr2.handle({ type: 'amRequestState' });
    const row = rowsOf(host2, repo).find((r) => r.id === id)!;
    expect(row.mergedAt as number).toBeGreaterThan(0);  // merged persisted across the reload
    expect(row.state).toBe('detached');                 // merged does not change seeding
    mgr2.dispose();
  }, 30_000);

  it('(m3) a conflicted apply and a forced apply do NOT stamp merged', async () => {
    // Conflict (main diverged uncommitted): ok:false -> no merged.
    const repo1 = await makeGitRepo();
    const host1 = makeHost(undefined); host1.known = [repo1];
    const mgr1 = new AgentManager(host1);
    const c = await seedChangedWorktree(repo1, 'm3c', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'agent\n'));
    fs.writeFileSync(path.join(repo1, 'app.txt'), 'human uncommitted\n');
    await mgr1.handle({ type: 'amApply', root: repo1, id: c.id, files: ['app.txt'] });
    expect(loadState(repo1).worktrees.find((r) => r.id === c.id)!.merged).toBeUndefined();
    mgr1.dispose();
    // Forced over a committed divergence (markers written): ok:false -> no merged.
    const repo2 = await makeGitRepo();
    const host2 = makeHost(undefined); host2.known = [repo2];
    const mgr2 = new AgentManager(host2);
    const f = await seedChangedWorktree(repo2, 'm3f', (wt) => fs.writeFileSync(path.join(wt, 'app.txt'), 'v1\nagent\n'));
    fs.writeFileSync(path.join(repo2, 'app.txt'), 'v1\nhuman\n');
    await runGit(['commit', '-am', 'human'], repo2);
    await mgr2.handle({ type: 'amApply', root: repo2, id: f.id, files: ['app.txt'], force: true });
    expect(loadState(repo2).worktrees.find((r) => r.id === f.id)!.merged).toBeUndefined();
    mgr2.dispose();
  }, 30_000);

  it('(m4) runStart clears a stale merged marker (and done); the restarted row has mergedAt 0', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'm4', 'go m4', 'lmstudio/pin');
    // Simulate a record carrying stale completion markers alongside its queued task.
    const st = loadState(repo);
    const rec = st.worktrees.find((r) => r.id === id)!;
    rec.merged = { at: 123 };
    rec.done = { stopReason: 'old', at: 1 };
    saveState(repo, st);
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    const after = loadState(repo).worktrees.find((r) => r.id === id)!;
    expect(after.merged).toBeUndefined();  // cleared at start
    expect(after.done).toBeUndefined();
    expect(rowsOf(host, repo).find((r) => r.id === id)!.mergedAt as number).toBe(0);
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  // ---- S5 multi-model fan-out (runFanout, routed via amCreate variants) ----

  it('(f1) a 3-variant race creates 3 siblings (-1/-2/-3), ONE shared groupId, each pinned its own model, all prompted the same task', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'race', prompt: 'do the task', variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' },
      { agentName: 'tsuru', model: 'lmstudio/b' },
      { agentName: 'tsuru', model: 'lmstudio/c' },
    ] });
    await waitFor(() => host.prompted.length === 3);
    const recs = loadState(repo).worktrees;
    expect(recs.map((r) => r.name).sort()).toEqual(['race-1', 'race-2', 'race-3']);
    const gids = new Set(recs.map((r) => r.groupId));
    expect(gids.size).toBe(1);          // one shared groupId across all siblings
    expect([...gids][0]).toBeTruthy();  // and it is actually set
    expect(new Set(host.modelPins.map((p) => p.modelId))).toEqual(new Set(['lmstudio/a', 'lmstudio/b', 'lmstudio/c']));
    expect(host.prompted.map((p) => p.text)).toEqual(['do the task', 'do the task', 'do the task']);
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    await waitFor(() => rowsOf(host, repo).filter((r) => r.state === 'idle').length === 3);
    mgr.dispose();
  }, 30_000);

  it('(f2) a race with 5 variants (too many) or 1 variant (too few) errors and creates no records', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    host.posts.length = 0;
    await mgr.handle({ type: 'amCreate', root: repo, name: 'toomany', prompt: 'x', variants: [
      { agentName: 'tsuru', model: 'm/1' }, { agentName: 'tsuru', model: 'm/2' }, { agentName: 'tsuru', model: 'm/3' },
      { agentName: 'tsuru', model: 'm/4' }, { agentName: 'tsuru', model: 'm/5' },
    ] });
    expect(host.posts.some((p) => p.type === 'amError' && /2-4 variants/.test(String(p.message)))).toBe(true);
    expect(loadState(repo).worktrees).toHaveLength(0);
    expect(host.createdWith).toHaveLength(0);
    host.posts.length = 0;
    await mgr.handle({ type: 'amCreate', root: repo, name: 'toofew', prompt: 'x', variants: [{ agentName: 'tsuru', model: 'm/1' }] });
    expect(host.posts.some((p) => p.type === 'amError' && /2-4 variants/.test(String(p.message)))).toBe(true);
    expect(loadState(repo).worktrees).toHaveLength(0);
    mgr.dispose();
  }, 30_000);

  it('(f3) identical variants are deduped: 4 given, 2 unique -> 2 records', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'dup', prompt: 'go', variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' }, { agentName: 'tsuru', model: 'lmstudio/b' },
      { agentName: 'tsuru', model: 'lmstudio/a' }, { agentName: 'tsuru', model: 'lmstudio/b' },
    ] });
    await waitFor(() => host.prompted.length === 2);
    expect(loadState(repo).worktrees.map((r) => r.name).sort()).toEqual(['dup-1', 'dup-2']);
    expect(new Set(host.modelPins.map((p) => p.modelId))).toEqual(new Set(['lmstudio/a', 'lmstudio/b']));
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    await waitFor(() => rowsOf(host, repo).filter((r) => r.state === 'idle').length === 2);
    mgr.dispose();
  }, 30_000);

  it('(f4) a queued race provisions all siblings queued with a shared groupId and NO sessions; Run all starts them', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amCreate', root: repo, name: 'qrace', prompt: 'run me', start: false, variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' }, { agentName: 'tsuru', model: 'lmstudio/b' }, { agentName: 'tsuru', model: 'lmstudio/c' },
    ] });
    await waitFor(() => loadState(repo).worktrees.length === 3); // all provisioned (serialized by the repo lock)
    const recs = loadState(repo).worktrees;
    expect(recs.every((r) => r.queuedTask !== undefined)).toBe(true);
    expect(new Set(recs.map((r) => r.groupId)).size).toBe(1);
    expect(host.createdWith).toHaveLength(0); // a queued race opens no sessions
    expect(host.prompted).toHaveLength(0);
    expect(rowsOf(host, repo).every((r) => r.state === 'queued')).toBe(true);
    await mgr.handle({ type: 'amStartAll', root: repo });
    await waitFor(() => host.prompted.length === 3);
    expect(new Set(host.prompted.map((p) => p.text))).toEqual(new Set(['run me']));
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await waitFor(() => rowsOf(host, repo).filter((r) => r.state === 'idle').length === 3);
    mgr.dispose();
  }, 30_000);

  it('(f5) one variant failing its session does not abort the others (it errors, siblings run)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    // Fail the FIRST createAgentSession only, then delegate to the real one.
    let calls = 0;
    const realCreate = host.createAgentSession;
    host.createAgentSession = async (cwd, agentName) => {
      calls++;
      if (calls === 1) { host.createdWith.push({ cwd, agentName }); throw new Error('engine failed to start'); }
      return realCreate(cwd, agentName);
    };
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'mixed', prompt: 'go', variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' }, { agentName: 'tsuru', model: 'lmstudio/b' }, { agentName: 'tsuru', model: 'lmstudio/c' },
    ] });
    await waitFor(() => host.prompted.length === 2); // the two healthy variants ran
    await waitFor(() => rowsOf(host, repo).filter((r) => r.state === 'error').length === 1);
    expect(loadState(repo).worktrees).toHaveLength(3);                         // all three records exist
    expect(new Set(loadState(repo).worktrees.map((r) => r.groupId)).size).toBe(1);
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(f6) launches are non-blocking and ordered: variant 2 opens its session even while variant 1 is stuck prompting', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    // Neither prompt resolves (default): a serialized fan-out would deadlock after
    // variant 1's promptSession, never opening variant 2's session.
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'seq', prompt: 'go', variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' }, { agentName: 'tsuru', model: 'lmstudio/b' },
    ] });
    await waitFor(() => host.prompted.length === 2); // BOTH reached prompt without either resolving
    expect(host.createdWith[0].cwd).toContain('seq-1'); // creation order matches variant order
    expect(host.createdWith[1].cwd).toContain('seq-2');
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    await waitFor(() => rowsOf(host, repo).filter((r) => r.state === 'idle').length === 2);
    mgr.dispose();
  }, 30_000);

  it('(f7) dedupe is on the EFFECTIVE model: an explicit pick + a blank variant that resolves to the same repo default collapse to one -> amError, no records', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: 'lmstudio/a' });
    host.posts.length = 0;
    // variant 1 explicitly names the repo default; variant 2 is blank (resolves to
    // the SAME default at run time). Raw-string dedupe would keep both and race a
    // model against itself; effective-model dedupe collapses the field below two.
    await mgr.handle({ type: 'amCreate', root: repo, name: 'samey', prompt: 'go', variants: [
      { agentName: 'tsuru', model: 'lmstudio/a' },
      { agentName: 'tsuru', model: '' },
    ] });
    expect(host.posts.some((p) => p.type === 'amError' && /2-4 variants/.test(String(p.message)))).toBe(true);
    expect(loadState(repo).worktrees).toHaveLength(0); // no siblings provisioned
    expect(host.createdWith).toHaveLength(0);
    mgr.dispose();
  }, 30_000);

  it('(f8) effective-model dedupe does NOT over-collapse: a blank variant still races a DIFFERENT explicit model', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amSetRepoDefault', root: repo, model: 'lmstudio/a' });
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'legit', prompt: 'go', variants: [
      { agentName: 'tsuru', model: '' },           // -> repo default lmstudio/a
      { agentName: 'tsuru', model: 'lmstudio/b' },  // distinct model
    ] });
    await waitFor(() => host.prompted.length === 2); // two distinct siblings both ran
    expect(loadState(repo).worktrees.map((r) => r.name).sort()).toEqual(['legit-1', 'legit-2']);
    expect(new Set(host.modelPins.map((p) => p.modelId))).toEqual(new Set(['lmstudio/a', 'lmstudio/b']));
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  // S5.2 — the auto-approve toggle plumbing: it rides amState (so the header
  // checkbox can render it) and amSetAutoApprove writes it through the host and
  // re-broadcasts (so a change is reflected everywhere).
  it('(s52) amState carries autoApprove; amSetAutoApprove flips it and re-broadcasts', async () => {
    const host = makeHost(undefined); // no repos needed — this is board-level state
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    expect(lastAmState(host)?.autoApprove).toBe(true); // default ON

    await mgr.handle({ type: 'amSetAutoApprove', on: false });
    expect(host.autoApproveOn).toBe(false);           // written through to the host
    expect(lastAmState(host)?.autoApprove).toBe(false); // and the re-broadcast reflects it

    await mgr.handle({ type: 'amSetAutoApprove', on: true });
    expect(lastAmState(host)?.autoApprove).toBe(true);
    mgr.dispose();
  });

  // ---- S6a typed agents: roster harvest + typed run applies the ACP mode ----

  it('(t1) a create harvests the session modes into amState.agentTypes, deduped, and re-harvest merges', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.sessionModes = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'harvest', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    // The board's roster now carries both engine modes (persisted through the host).
    expect(lastAmState(host)!.agentTypes).toEqual([{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }]);
    expect(host.agentTypesStore).toEqual([{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }]);
    host.resolvePrompt('end_turn');
    await done;
    // A second create whose session exposes a NEW mode UNIONS it in (no dupes).
    host.sessionModes = [{ id: 'build', name: 'Build' }, { id: 'review', name: 'Review' }];
    const done2 = mgr.handle({ type: 'amCreate', root: repo, name: 'harvest2', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 2);
    expect(lastAmState(host)!.agentTypes).toEqual([
      { id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }, { id: 'review', name: 'Review' },
    ]);
    host.resolvePrompt('end_turn');
    await done2;
    mgr.dispose();
  }, 30_000);

  it('(t1b) the harvested engine-default flag rides through into amState.agentTypes (so the picker hides the true default, not a hardcoded id)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    // `default_agent: 'plan'` -> the session reports 'plan' as its current/default
    // mode. The flag must survive harvest -> mergeAgentTypes -> save -> broadcast.
    host.sessionModes = [{ id: 'build', name: 'Build', default: false }, { id: 'plan', name: 'Plan', default: true }];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'flagged', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    expect(lastAmState(host)!.agentTypes).toEqual([
      { id: 'build', name: 'Build', default: false }, { id: 'plan', name: 'Plan', default: true },
    ]);
    expect(host.agentTypesStore).toEqual([
      { id: 'build', name: 'Build', default: false }, { id: 'plan', name: 'Plan', default: true },
    ]);
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(t1c) a harvested mode DESCRIPTION rides host->manager->amState AND the persisted roster (the picker tooltip source)', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    // A mode carrying a description (what modesFromOption yields for a real agent
    // type) must survive harvest -> mergeAgentTypes -> save -> broadcast; a refactor
    // that picks only id/name/default at any hop drops the picker's tooltip.
    host.sessionModes = [{ id: 'ask', name: 'Ask', description: 'Answers questions about the codebase; never edits.' }];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'desc', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    const broadcast = lastAmState(host)!.agentTypes.find((t) => t.id === 'ask');
    expect(broadcast).toHaveProperty('description', 'Answers questions about the codebase; never edits.');
    expect(host.agentTypesStore.find((t) => t.id === 'ask')).toHaveProperty('description', 'Answers questions about the codebase; never edits.');
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(t2) a typed run sets the session mode BEFORE the prompt; a tsuru run sets NONE', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.sessionModes = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }];
    const mgr = new AgentManager(host);
    // Typed: agentName 'plan' is a real mode -> setSessionAgentMode('plan') runs, before the prompt.
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'typed', agentName: 'plan', prompt: 'do it', model: 'lmstudio/x' });
    await waitFor(() => host.prompted.length === 1);
    expect(host.agentModeSet).toEqual([{ sessionId: host.prompted[0].sessionId, modeId: 'plan' }]);
    expect(host.order.indexOf('mode')).toBeLessThan(host.order.indexOf('prompt')); // mode precedes the task
    expect(host.order.indexOf('pin')).toBeLessThan(host.order.indexOf('mode'));     // and follows the model pin
    host.resolvePrompt('end_turn');
    await done;
    // tsuru: NO mode call at all (byte-identical to the pre-S6a default path).
    host.agentModeSet.length = 0;
    const done2 = mgr.handle({ type: 'amCreate', root: repo, name: 'plain', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 2);
    expect(host.agentModeSet).toEqual([]);
    host.resolvePrompt('end_turn');
    await done2;
    mgr.dispose();
  }, 30_000);

  it('(t3) an unknown agent type errors the run fatally, never prompts, and keeps the task retryable', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.sessionModes = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'ghosttype', 'run me', 'lmstudio/pin');
    // Edit the queued task to carry an agent type the engine does not expose.
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, agentName: 'ghost' });
    await mgr.handle({ type: 'amStart', root: repo, id });
    const row = rowsOf(host, repo).find((r) => r.id === id)!;
    expect(row.state).toBe('error');
    expect(String(row.errorDetail).toLowerCase()).toContain('agent type unavailable');
    expect(String(row.errorDetail)).toContain('ghost');
    expect(host.prompted).toHaveLength(0);                 // the task never ran under a bogus type
    expect(host.closed).toContain('session-fake-1');       // orphan session torn down
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask).toBeDefined(); // still queued -> retryable
    // Retry after fixing the type to a real mode now succeeds.
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, agentName: 'plan' });
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.agentModeSet.some((m) => m.modeId === 'plan')).toBe(true);
    expect(host.prompted[0].text).toBe('run me');
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(t3-legacy) a queued task carrying the removed board-only kami type runs as engine default, never erroring', async () => {
    // State tolerance: a .origami/agent-manager.json written before the Kami removal
    // can hold a queuedTask whose agentName is the now-deleted board-only 'kami' type
    // (a single-run queued via the create-form's Queue button, never started). On
    // Start it must degrade like tsuru - run under the engine default, no bogus mode
    // set - not throw 'agent type unavailable: kami' and strand the task.
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.sessionModes = [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }];
    const mgr = new AgentManager(host);
    const id = await queue(mgr, host, repo, 'legacykami', 'run me', 'lmstudio/pin');
    await mgr.handle({ type: 'amUpdateQueued', root: repo, id, agentName: 'kami' }); // the pre-removal synthetic type
    const done = mgr.handle({ type: 'amStart', root: repo, id });
    await waitFor(() => host.prompted.length === 1);
    expect(host.agentModeSet).toEqual([]);                 // 'kami' skipped like tsuru - no mode call
    expect(host.prompted[0].text).toBe('run me');          // the task actually ran
    const row = rowsOf(host, repo).find((r) => r.id === id)!;
    expect(row.state).not.toBe('error');                   // not the 'agent type unavailable' failure
    expect(loadState(repo).worktrees.find((r) => r.id === id)!.queuedTask).toBeUndefined(); // cleared on the successful start
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(t4) a race of two TYPES on the SAME model survives dedupe -> two typed siblings', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    host.sessionModes = [{ id: 'plan', name: 'Plan' }, { id: 'review', name: 'Review' }];
    const mgr = new AgentManager(host);
    // Same model, different agent type: the dedupe key is (agentName, model), so
    // both must survive (racing two AGENTS on one model is a legitimate race).
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'typerace', prompt: 'go', variants: [
      { agentName: 'plan', model: 'lmstudio/same' },
      { agentName: 'review', model: 'lmstudio/same' },
    ] });
    await waitFor(() => host.prompted.length === 2);
    expect(loadState(repo).worktrees.map((r) => r.name).sort()).toEqual(['typerace-1', 'typerace-2']);
    expect(new Set(host.agentModeSet.map((m) => m.modeId))).toEqual(new Set(['plan', 'review'])); // each sibling set its own type
    host.resolvePrompt('end_turn'); host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  // ---- Legacy state tolerance: a .origami/agent-manager.json written by the
  //      pre-removal build can hold records carrying the dropped `kami` field and
  //      a done.stopReason from the kami verdict family ('kami_passed' etc.). The
  //      board must load and render those without crashing - as a plain done row. ----

  it('(legacy) loads a record with old kami fields (kami:{round} + a kami_* stopReason) and renders it as a normal done row', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    // A REAL worktree so boot reconciliation (git worktree list = ground truth) keeps the record.
    const wt = await createWorktree(repo, 'legacyverified');
    // Hand-write the state file in the PRE-removal shape: the record still carries
    // the now-dropped `kami` field and a done.stopReason from the retired verdict
    // family. loadState only validates version + worktrees[], so the extra fields
    // must be tolerated (read, never rejected), not corrupt the record.
    const legacy = {
      version: 1,
      worktrees: [{
        id: 'wlegacy', name: wt.name, branch: wt.branch, path: wt.path, baseSha: wt.baseSha,
        createdAt: Date.now(), sessions: ['old-sess'],
        kami: { round: 4, verdict: 'passed' },
        done: { stopReason: 'kami_passed', at: Date.now() },
      }],
    };
    fs.mkdirSync(path.join(repo, '.origami'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.origami', 'agent-manager.json'), JSON.stringify(legacy, null, 2));

    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' }); // reconcile + broadcast must not throw on the legacy fields
    const row = rowsOf(host, repo).find((r) => r.id === 'wlegacy');
    expect(row).toBeDefined();
    // Seeded idle from the persisted done marker; the unknown kami_* reason passes
    // straight through as the row's stopReason - a plain done row, no kami UI, no crash.
    expect(row!.state).toBe('idle');
    expect(row!.stopReason).toBe('kami_passed');
    expect(loadState(repo).worktrees.find((r) => r.id === 'wlegacy')).toBeDefined(); // still readable
    mgr.dispose();
  }, 30_000);

  // ---- S7 question attention: setAgentQuestion drives the row's needsYou chip;
  //      it is cleared on answer, and the rows.ts in-progress gate drops it the
  //      moment the run leaves 'working' (idle / died) or the record is deleted. ----

  it('(S7 a) a question flags the row with a needs-you preview while it stays In progress; answering clears it', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'asker', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    const sid = [...host.live][0];
    // The engine asked a question and no view was mounted -> the panel flags the row.
    mgr.setAgentQuestion(sid, 'Which branch should I target?');
    const asking = rowsOf(host, repo).find((r) => r.name === 'asker')!;
    expect(asking.state).toBe('working'); // a questioning agent is still In progress
    expect(asking.needsYou).toEqual({ kind: 'question', preview: 'Which branch should I target?' });
    // Answering clears the attention; the run is still working (it resumes).
    mgr.setAgentQuestion(sid, null);
    const answered = rowsOf(host, repo).find((r) => r.name === 'asker')!;
    expect(answered.state).toBe('working');
    expect(answered.needsYou).toBeNull();
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(S7 b) a completed run shows no needs-you chip even if a question was pending mid-run', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'finisher', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    mgr.setAgentQuestion([...host.live][0], 'still there?');
    host.resolvePrompt('end_turn');
    await done;
    const end = rowsOf(host, repo).find((r) => r.name === 'finisher')!;
    expect(end.state).toBe('idle');
    expect(end.needsYou).toBeNull(); // the in-progress gate drops it on completion
    mgr.dispose();
  }, 30_000);

  it('(S7 c) a run whose engine died mid-question shows error, not a stale needs-you chip', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'zombie', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    const sid = [...host.live][0];
    mgr.setAgentQuestion(sid, 'are you there?');
    host.live.delete(sid); // engine died while the question was up
    await mgr.handle({ type: 'amRequestState' }); // rebuild rows
    const dead = rowsOf(host, repo).find((r) => r.name === 'zombie')!;
    expect(dead.state).toBe('error');
    expect(dead.needsYou).toBeNull();
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);

  it('(S7 d) deleting a questioning agent removes the row and its needs-you attention', async () => {
    const repo = await makeGitRepo();
    const host = makeHost(undefined); host.known = [repo];
    const mgr = new AgentManager(host);
    const done = mgr.handle({ type: 'amCreate', root: repo, name: 'doomed', agentName: 'tsuru', prompt: 'go' });
    await waitFor(() => host.prompted.length === 1);
    mgr.setAgentQuestion([...host.live][0], 'wait!');
    expect(rowsOf(host, repo).find((r) => r.name === 'doomed')!.needsYou).not.toBeNull();
    const rec = loadState(repo).worktrees.find((r) => r.name === 'doomed')!;
    await mgr.handle({ type: 'amDelete', root: repo, id: rec.id, deleteBranch: true });
    expect(rowsOf(host, repo).find((r) => r.name === 'doomed')).toBeUndefined();
    host.resolvePrompt('end_turn');
    await done;
    mgr.dispose();
  }, 30_000);
});

// S15 cartographer map runs — driven through the same fake host + real git fixtures.
// The fake "agent" never writes files, so each test SIMULATES the cartographer by
// writing .origami/map/map.json itself before resolving the parked prompt (the run
// then validates + stamps it, exactly as it would a real agent's output).
describe('AgentManager S15 cartographer map runs (fake host, real git)', () => {
  const made: string[] = [];
  afterAll(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

  async function makeMapRepo(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-map-'));
    made.push(dir);
    expect((await runGit(['init', '-b', 'main'], dir)).ok).toBe(true);
    await runGit(['config', 'user.email', 'uat@origami.local'], dir);
    await runGit(['config', 'user.name', 'Origami UAT'], dir);
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    await runGit(['add', 'app.txt'], dir);
    expect((await runGit(['commit', '-m', 'seed'], dir)).ok).toBe(true);
    return dir;
  }
  const VALID_MAP = {
    version: 2, name: 'demo', summary: 'a fixture',
    nodes: [{ id: 'n', name: 'N', pillar: 1, kind: 'module', summary: 'x' }],
    edges: [], flows: [],
  };
  function writeMapRaw(repo: string, raw: string): void {
    fs.mkdirSync(path.join(repo, '.origami', 'map'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.origami', 'map', 'map.json'), raw, 'utf8');
  }
  const mapOf = (host: FakeHost, root: string): MapStateT | undefined => board(host, root)?.map;
  const cartoRuns = (host: FakeHost) => host.createdWith.filter((c) => c.agentName === 'cartographer');

  async function startMappedRepo(): Promise<{ repo: string; host: FakeHost; mgr: AgentManager }> {
    const repo = await makeMapRepo();
    const host = makeHost(repo);
    host.known = [repo];
    host.sessionModes = [{ id: 'cartographer', name: 'cartographer' }]; // so the mode applies
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    return { repo, host, mgr };
  }

  it('runs at the repo ROOT (not a worktree), stamps builtAt on idle, renders map.html, board reads fresh', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => cartoRuns(host).length === 1);
    // the session cwd is the repo root, NOT under .origami/worktrees/
    expect(cartoRuns(host).every((c) => !c.cwd.includes('worktrees'))).toBe(true);
    await waitFor(() => host.prompted.length === 1); // the run has reached its prompt => building + resolver queued
    expect(mapOf(host, repo)?.status).toBe('building');
    writeMapRaw(repo, JSON.stringify(VALID_MAP)); // the "cartographer" writes its map (no builtAt)
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'ready');
    const m = mapOf(host, repo)!;
    expect(m.behind).toBe(0);
    const head = (await runGit(['rev-parse', 'HEAD'], repo)).output;
    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, '.origami', 'map', 'map.json'), 'utf8'));
    expect(onDisk.builtAt.sha).toBe(head);      // stamped by the tooling (the agent can't - bash denied)
    expect(onDisk.builtAt.branch).toBe('main');
    expect(m.sha).toBe(head);
    expect(fs.existsSync(path.join(repo, '.origami', 'map', 'map.html'))).toBe(true); // human artifact
    expect(host.closed.length).toBeGreaterThan(0); // session torn down after the run
    mgr.dispose();
  }, 30_000);

  it('an INVALID map (bad pillar ref) settles a failed state carrying the precise errors, never a silent success', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => host.prompted.length === 1);
    writeMapRaw(repo, JSON.stringify({
      version: 2, name: 'x', summary: 'y',
      nodes: [{ id: 'n', name: 'N', pillar: 99, kind: 'm', summary: 's' }], edges: [], flows: [],
    }));
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'failed');
    expect(mapOf(host, repo)!.errors!.some((e) => e.includes('99'))).toBe(true);
    mgr.dispose();
  }, 30_000);

  it('a second map run while one is in flight is refused (no new session, an amError posted)', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    void mgr.handle({ type: 'amMapRepo', root: repo });     // first: parks in promptSession
    await waitFor(() => host.prompted.length === 1);        // first run parked at its prompt (building)
    expect(mapOf(host, repo)?.status).toBe('building');
    const before = cartoRuns(host).length;
    await mgr.handle({ type: 'amMapRepo', root: repo });     // second: refused
    expect(cartoRuns(host).length).toBe(before);            // no second session
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('already building'))).toBe(true);
    writeMapRaw(repo, JSON.stringify(VALID_MAP)); host.resolvePrompt('end_turn'); // let the first finish
    await waitFor(() => mapOf(host, repo)?.status === 'ready');
    mgr.dispose();
  }, 30_000);

  it('staleness: a new commit after a fresh map makes the board read N behind on the next request', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => host.prompted.length === 1);
    writeMapRaw(repo, JSON.stringify(VALID_MAP));
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'ready' && (mapOf(host, repo)?.behind ?? -1) === 0);
    // advance HEAD one commit past the stamped sha
    fs.writeFileSync(path.join(repo, 'app.txt'), 'v2\n');
    await runGit(['add', 'app.txt'], repo);
    await runGit(['commit', '-m', 'v2'], repo);
    await mgr.handle({ type: 'amRequestState' }); // recomputes staleness
    await waitFor(() => (mapOf(host, repo)?.behind ?? 0) === 1);
    expect(mapOf(host, repo)!.status).toBe('ready');
    mgr.dispose();
  }, 30_000);

  it('brief injection: withMapBrief prefixes the map line only when a valid map exists', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    // no map yet -> the prompt is unchanged
    expect(await withMapBrief(repo, 'do the thing')).toBe('do the thing');
    // build a map, then the brief is prefixed with the short sha + behind count
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => host.prompted.length === 1);
    writeMapRaw(repo, JSON.stringify(VALID_MAP));
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'ready');
    const briefed = await withMapBrief(repo, 'do the thing');
    expect(briefed).toContain('.origami/map/map.json');
    expect(briefed).toContain('0 commits behind HEAD');
    expect(briefed.endsWith('do the thing')).toBe(true);
    mgr.dispose();
  }, 30_000);

  it('(defect 4) an unreachable stamped sha degrades to UNKNOWN staleness, never a false "fresh"', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => host.prompted.length === 1);
    writeMapRaw(repo, JSON.stringify(VALID_MAP));
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'ready' && (mapOf(host, repo)?.behind ?? -1) === 0);
    // Rewrite the stamped sha to a commit no longer in history (as a rebase / force-
    // push would): `rev-list <deadsha>..HEAD` then errors, and the board must report
    // UNKNOWN rather than the high-confidence "0 behind / fresh" it did before.
    const mapPath = path.join(repo, '.origami', 'map', 'map.json');
    const onDisk = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    onDisk.builtAt.sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    fs.writeFileSync(mapPath, JSON.stringify(onDisk), 'utf8');
    await mgr.handle({ type: 'amRequestState' }); // recompute staleness off the rewritten stamp
    await waitFor(() => mapOf(host, repo)?.status === 'ready' && mapOf(host, repo)?.behind === undefined);
    expect(mapOf(host, repo)!.behind).toBeUndefined(); // unknown, NOT 0
    mgr.dispose();
  }, 30_000);

  it('(defect 8) a valid but UNSTAMPED map reports unknown staleness (never "0 behind / fresh")', async () => {
    const { repo, host, mgr } = await startMappedRepo();
    // A valid map placed on disk that never went through a completed run carries no
    // builtAt (schema-legal): staleness is genuinely unknown, not zero.
    writeMapRaw(repo, JSON.stringify(VALID_MAP)); // VALID_MAP has no builtAt
    await mgr.handle({ type: 'amRequestState' });
    await waitFor(() => mapOf(host, repo)?.status === 'ready');
    expect(mapOf(host, repo)!.sha).toBeUndefined();    // unstamped
    expect(mapOf(host, repo)!.behind).toBeUndefined(); // unknown, not 0
    // the brief says staleness unknown, not a confident "0 commits behind"
    const briefed = await withMapBrief(repo, 'do the thing');
    expect(briefed).toContain('staleness unknown');
    expect(briefed).not.toContain('0 commits behind');
    mgr.dispose();
  }, 30_000);

  it('(defect 5) unregister is refused while a cartographer map run is in flight, then allowed once it settles', async () => {
    // A map run holds NO worktree record, so the task-agent liveness guard can't see
    // it; without the mapRuns check a running cartographer would be orphaned (its repo
    // gone from the board, its Cancel-Map path dead). repo is a REGISTERED repo (not
    // the workspace) so onRemoveRepo proceeds past the workspace short-circuit.
    const repo = await makeMapRepo();
    const host = makeHost(undefined);
    host.known = [repo];
    host.sessionModes = [{ id: 'cartographer', name: 'cartographer' }];
    const mgr = new AgentManager(host);
    await mgr.handle({ type: 'amRequestState' });
    void mgr.handle({ type: 'amMapRepo', root: repo });
    await waitFor(() => host.prompted.length === 1); // parked at its prompt => building
    expect(mapOf(host, repo)?.status).toBe('building');
    host.posts.length = 0;
    await mgr.handle({ type: 'amRemoveRepo', root: repo });
    expect(host.posts.some((p) => p.type === 'amError' && String(p.message).includes('being mapped'))).toBe(true);
    expect(host.known.some((k) => key(k) === key(repo))).toBe(true); // still registered - the run stays cancelable
    // let the run settle, then removal is allowed
    writeMapRaw(repo, JSON.stringify(VALID_MAP));
    host.resolvePrompt('end_turn');
    await waitFor(() => mapOf(host, repo)?.status === 'ready');
    await mgr.handle({ type: 'amRemoveRepo', root: repo });
    expect(host.known.some((k) => key(k) === key(repo))).toBe(false); // now unregisters cleanly
    mgr.dispose();
  }, 30_000);
});
