// t-sh7cog — the window's host engine (hostEngine.ts, hostEngineWindow.ts). The
// real bugs each block catches:
//
// - a bare window (no chat, Nests off, Manager closed) that spawns an engine:
//   ~1 s of CPU and ~400 MB for nothing (docs/decisions/host-engine-connection.md);
// - a host feature that still answers "Open a chat first" with no chat open;
// - two requests racing into two engine processes;
// - an engine that dies and is never replaced, or one that outlives the window;
// - a chat that exists and is IGNORED for a second process.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_ENGINE_CHANNEL, HOST_ENGINE_FAILED, HostEngine, attachHostNestView, type HostClient } from '../../../src/dashboard/hostEngine';
import { NEST_SYNC_MS, NestHub } from '../../../src/dashboard/nestHub';
import { handleSkillsPaneMessage } from '../../../src/dashboard/skillsPane';

// The output channels hostEngineWindow.ts makes, by name, with the lines written to each.
const channels = vi.hoisted(() => [] as Array<{ name: string; lines: string[] }>);
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: undefined },
  window: {
    createOutputChannel: (name: string) => {
      const made = { name, lines: [] as string[] };
      channels.push(made);
      return { appendLine: (line: string) => void made.lines.push(line), dispose: () => undefined };
    },
  },
}));

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');

class FakeClient implements HostClient {
  public connects: Array<[string, boolean | undefined]> = [];
  public disposed = 0;
  public calls: string[] = [];
  constructor(public readonly onClose: () => void, private readonly fail = false, private readonly gate?: Promise<void>) {}
  async connect(cwd: string, headless?: boolean): Promise<void> {
    this.connects.push([cwd, headless]);
    await this.gate;
    if (this.fail) throw new Error('spawn ENOENT');
  }
  async extMethod(method: string): Promise<Record<string, unknown>> { this.calls.push(method); return { rows: [], others: [] }; }
  dispose(): void { this.disposed++; }
}

function engine(opts: { fail?: () => boolean; gate?: Promise<void> } = {}) {
  const made: FakeClient[] = [];
  const log: string[] = [];
  const host = new HostEngine<FakeClient>({
    make: (onClose) => { const c = new FakeClient(onClose, opts.fail?.() ?? false, opts.gate); made.push(c); return c; },
    cwd: () => 'C:/work',
    log: (l) => void log.push(l),
  });
  return { host, made, log };
}

describe('a bare window spawns no engine (acceptance 3)', () => {
  it('activation, a Nests-off hub at work, and every background read spawn nothing', async () => {
    vi.useFakeTimers();
    const { host, made } = engine();
    const subs: Array<{ dispose(): unknown }> = [];
    const { activateHostEngine } = await import('../../../src/dashboard/hostEngineWindow');
    const hub = new NestHub({ enabled: () => false, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
    activateHostEngine({ subscriptions: subs }, host, hub);
    // Nests off: the group is never attached (activateGroup.ts), and even a
    // hub that is poked answers without asking the engine.
    await hub.sync();
    await hub.onPeer('deskAAAAAAA', { type: 'nest/index', rows: [] });
    hub.onLocalPost({ type: 'sessionCreated' });
    await vi.advanceTimersByTimeAsync(NEST_SYNC_MS * 3);
    // The background readers (glidepath sampler, collab watch, provider probe) use current().
    expect(host.current()).toBeUndefined();
    expect(made).toHaveLength(0);
    vi.useRealTimers();
  });

  it('Nests on but no nest joined (no device id): the hub refuses before the engine is asked', async () => {
    const { host, made } = engine();
    const hub = new NestHub({ enabled: () => true, setTimer: () => 0, clearTimer: () => undefined });
    attachHostNestView(hub, host);
    await expect(hub.call('nest_index')).rejects.toThrow(/device id/);
    expect(made).toHaveLength(0);
  });

  it('the request gate never includes the reads a mounting sidebar sends by itself', async () => {
    const { HOST_ENGINE_MESSAGE_TYPES } = await import('../../../src/dashboard/hostEngineWindow');
    // The nest index read comes on every sidebar mount, Nests on or off; model and
    // usage reads come from chat surfaces. None of them may start an engine.
    for (const t of ['requestNestIndex', 'nestContinue', 'nestOpenRead', 'requestModels', 'requestProviderStatus', 'providerUsageRequest', 'modelStatus', 'promptCapture', 'cacheStats'])
      expect(HOST_ENGINE_MESSAGE_TYPES.has(t), t).toBe(false);
    // What the owner named: Manager panes, History, the Labyrinth.
    for (const t of ['requestHistory', 'requestRunSteps', 'requestRunStats', 'toolsRequest', 'mcpRequest', 'artifactsRequest', 'listSkills', 'listInstructions', 'requestStorageStats', 'requestNestStorage', 'glidepathRequest', 'requestCollabs'])
      expect(HOST_ENGINE_MESSAGE_TYPES.has(t), t).toBe(true);
  });
});

describe('resolution and lifetime', () => {
  it('a chat\'s client wins and nothing spawns; with no chat, ONE headless connect serves concurrent requests', async () => {
    const { host, made } = engine();
    const chat = new FakeClient(() => undefined);
    let chats: FakeClient[] = [chat];
    const panel = {};
    host.setChats(panel, () => chats[0]);
    await expect(host.ensure()).resolves.toBe(chat);
    expect(made).toHaveLength(0);
    chats = [];
    const [a, b] = await Promise.all([host.ensure(), host.ensure()]);
    expect(made).toHaveLength(1);
    expect(a).toBe(made[0]);
    expect(b).toBe(made[0]);
    expect(made[0]!.connects).toEqual([['C:/work', true]]);
    // A chat that opens later is preferred again; the host stays for the next gap.
    chats = [chat];
    expect(host.current()).toBe(chat);
    chats = [];
    expect(host.current()).toBe(made[0]);
    // An old panel's dispose releases nothing a newer panel registered; its own release does.
    const newer = {};
    host.setChats(newer, () => chat);
    host.releaseChats(panel);
    expect(host.current()).toBe(chat);
    host.releaseChats(newer);
    expect(host.current()).toBe(made[0]);
  });

  // t-vbj03h: this engine can hold the Flock lease while a chat is open, and
  // current() then returns the chat. Flock needs the host client itself.
  it('ownClient() is the host client even while a chat is open, and nothing after it exits', async () => {
    const { host, made } = engine();
    expect(host.ownClient()).toBeUndefined();
    await host.ensure();
    const chat = new FakeClient(() => undefined);
    host.setChats({}, () => chat);
    expect(host.current()).toBe(chat);
    expect(host.ownClient()).toBe(made[0]);
    made[0]!.onClose();
    expect(host.ownClient()).toBeUndefined();
  });

  it('an engine that exits is dropped and the next request starts a new one', async () => {
    const { host, made } = engine();
    await host.ensure();
    made[0]!.onClose();
    expect(host.current()).toBeUndefined();
    await host.ensure();
    expect(made).toHaveLength(2);
    expect(host.current()).toBe(made[1]);
  });

  it('a failed start answers undefined, disposes the child, says why, and the next request tries again', async () => {
    let fail = true;
    const { host, made, log } = engine({ fail: () => fail });
    await expect(host.ensure()).resolves.toBeUndefined();
    expect(made[0]!.disposed).toBe(1);
    expect(log.join('\n')).toMatch(/host engine did not start: spawn ENOENT/);
    await expect(host.nestEngine.extMethod('nest_index', {})).rejects.toThrow(HOST_ENGINE_FAILED);
    fail = false;
    await expect(host.ensure()).resolves.toBe(made[2]);
  });

  it('window close disposes the host engine through the client\'s own dispose, and nothing respawns after', async () => {
    const { host, made } = engine();
    const subs: Array<{ dispose(): unknown }> = [];
    const { activateHostEngine } = await import('../../../src/dashboard/hostEngineWindow');
    activateHostEngine({ subscriptions: subs }, host, { attachView: () => undefined });
    await host.ensure();
    expect(made[0]!.disposed).toBe(0);
    for (const s of subs) s.dispose(); // what VS Code does with context.subscriptions on window close
    expect(made[0]!.disposed).toBe(1);
    await expect(host.ensure()).resolves.toBeUndefined();
    expect(made).toHaveLength(1);
  });

  it('a close while the engine is still starting disposes it when it arrives', async () => {
    let open!: () => void;
    const { host, made } = engine({ gate: new Promise<void>((r) => (open = r)) });
    const pending = host.ensure();
    host.dispose();
    open();
    await expect(pending).resolves.toBeUndefined();
    expect(made[0]!.disposed).toBe(1);
  });

  it('the production client closes like a chat engine: AcpClient.dispose -> shutdownEngine', () => {
    // hostEngineWindow.ts builds the host client as a plain AcpClient; its dispose is the
    // stdin-EOF-then-kill path every chat engine takes (engineShutdown.ts).
    expect(read('src/dashboard/hostEngineWindow.ts')).toMatch(/make: \(onClose\) => new AcpClient\(hostHandlers\(onClose\)\)/);
    expect(read('src/acpClient.ts')).toMatch(/dispose\(\): void \{[\s\S]{0,300}if \(this\.child\) shutdownEngine\(this\.child\);/);
    expect(read('src/extension.ts')).toMatch(/activateHostEngine\(context\);/);
  });
});

// t-tc2es2. The failure text named an "Origami" output channel that did not exist,
// and the reason went to console.log, which no user opens.
describe('the host engine failure text names a channel that exists', () => {
  it('HOST_ENGINE_FAILED names HOST_ENGINE_CHANNEL, and the window log writes its lines to a channel of that name', async () => {
    expect(HOST_ENGINE_FAILED).toContain(`"${HOST_ENGINE_CHANNEL}" output channel`);
    const { hostEngineLog } = await import('../../../src/dashboard/hostEngineWindow');
    hostEngineLog('[origami] host engine did not start: spawn ENOENT');
    hostEngineLog('[origami] host engine closed: exit 1');
    expect(channels).toEqual([{ name: HOST_ENGINE_CHANNEL, lines: ['[origami] host engine did not start: spawn ENOENT', '[origami] host engine closed: exit 1'] }]);
  });
  it('the window host engine logs its start failure, closes and errors through that channel (source guard)', () => {
    const src = read('src/dashboard/hostEngineWindow.ts');
    expect(src).toMatch(/log: hostEngineLog,/);
    expect(src).toMatch(/onClose: \(reason\) => \{ hostEngineLog\(/);
    expect(src).toMatch(/onError: \(message\) => hostEngineLog\(/);
  });
});

describe('the skills pane with no chat open', () => {
  it('lists through the host engine, and still says "Open a chat first" when there is none', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const base = { sessions: () => new Map(), activeSessionId: () => null, post: (x: Record<string, unknown>) => void posts.push(x), cwd: () => 'C:/work' };
    await handleSkillsPaneMessage({ ...base, hostClient: () => ({ extMethod: async () => ({ skills: [{ name: 'wrap', location: 'C:/work/.origami/skills/wrap' }] }) }) }, { type: 'listSkills' });
    expect(posts[0]).toMatchObject({ type: 'skillsData', skills: [{ name: 'wrap', scope: 'local' }] });
    expect(posts[0]!['error']).toBeUndefined();
    await handleSkillsPaneMessage({ ...base, hostClient: () => undefined }, { type: 'listSkills' });
    expect(posts[1]).toMatchObject({ type: 'skillsData', skills: [], error: expect.stringMatching(/Open a chat first/) });
  });
});

// DashboardPanel.ts cannot be built without an extension host (see
// questionRouting.test.ts), so its glue is held at the SOURCE: each regex is an
// invariant a plausible edit breaks, with the bug it would let through.
describe('DashboardPanel wiring (source guards)', () => {
  const src = read('src/dashboard/DashboardPanel.ts');
  it('exactly ONE place starts the host engine: the request gate, after boot, with no engine at all', () => {
    expect(src.match(/hostEngine\.ensure\(/g)).toHaveLength(1);
    expect(src).toMatch(/if \(this\.booted && !this\.engineClient\(\) && typeof m\.type === 'string' && HOST_ENGINE_MESSAGE_TYPES\.has\(m\.type\)\) await hostEngine\.ensure\(\);/);
    // Boot is flagged only once initialize() has made (and maybe retired) its boot chat.
    expect(src).toMatch(/this\.restoring = false; this\.saveOpen\(\); this\.booted = true;/);
  });
  it('no host read resolves the chat inline any more (a site left on the old pick answers "Open a chat first" with no chat)', () => {
    expect(src.match(/getActiveSession\(\) \?\? \[\.\.\.this\.sessions\.values\(\)\]\[0\]/g)).toHaveLength(3); // chatClient + the two per-chat reads
    expect(src).toMatch(/private chatClient\(\): AcpClient \| undefined \{ return \(this\.getActiveSession\(\) \?\? \[\.\.\.this\.sessions\.values\(\)\]\[0\]\)\?\.client; \}/);
    expect(src).toMatch(/cacheStatsPayload\(session\?\.client\)/);
    expect(src).toMatch(/promptCapturePayload\(session\?\.client\)/);
  });
  it('the background sampler reads without spawning; the nest route hands the hub the host adapter', () => {
    expect(src).toMatch(/startUsageSampling\(glidepathHost\(this\.context, \(\) => this\.engineArg\(\)/);
    expect(src).toMatch(/engine: \(\) => hostEngine\.nestEngine,/);
    expect(src).toMatch(/hostEngine\.setChats\(this, \(\) => this\.chatClient\(\)\);/);
    expect(src).toMatch(/hostEngine\.releaseChats\(this\);/);
  });
  it('the Flock host offers the host engine as a route (t-vbj03h: without it the pane shows "another window" for this one)', () => {
    expect(src).toMatch(/hostEngine: \(\) => \{ const own = hostEngine\.ownClient\(\); return own \? \{ client: own, pid: own\.pid \} : undefined; \}/);
  });
});
