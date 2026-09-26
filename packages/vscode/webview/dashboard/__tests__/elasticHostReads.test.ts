// t-w2qv3o — host reads never wake a hidden chat's engine (src/dashboard/hostReads.ts,
// src/elastic/sessionSignals.ts onScreenClient, HostEngine.ensureOwn). The real HostEngine, NestHub
// adapter, usage sampler, collab watch and storage pane are driven here with fake engine clients.
// The bugs each block catches:
//
// - the 30 s Nests sync, the usage sampler, the 5 s collab watch or a storage scan reading through a
//   HIDDEN chat's engine: it pages the engine back in every tick and defeats the idle trim;
// - collab calls split over two engines: the collab runner holds its live state (agent statuses,
//   hop budget) in the process that ran the post, so a watch that reads another engine reports
//   "idle" while a room runs, and the sidebar ring lies;
// - a bare window (no chat) that now spawns an engine for a background read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostEngine, type HostClient } from '../../../src/dashboard/hostEngine';
import { hostOnlyClient, hostReadArg } from '../../../src/dashboard/hostReads';
import { onScreenClient, type PanelSignals, type SignalSession, type WindowSignals } from '../../../src/elastic/sessionSignals';
import { sampleUsage, __resetUsageSamplingForTests } from '../../../src/dashboard/usageHistory';
import { handleStorageMessage } from '../../../src/dashboard/storagePane';
import { COLLAB_WATCH_MS, stopCollabWatch, watchCollabs } from '../../../src/dashboard/collabWatch';
import { handleCollabMessage } from '../../../src/dashboard/collabManager';

class Engine implements HostClient {
  public calls: string[] = [];
  public lastExtAt = 0;
  constructor(public readonly name: string) {}
  async connect(): Promise<void> { /* the host engine connects; chats are already up */ }
  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (method === 'collab_state') return { collab: { id: 'c1', title: 'Storm', createdAt: '', loopBreakerCap: null }, participants: [], messages: [], agents: [] };
    if (method === 'provider_auth_usage') return { ok: true, windows: [] };
    return {};
  }
  dispose(): void { /* nothing to close */ }
}

function chat(id: string, client: Engine): SignalSession & { client: Engine } {
  return { id, client, gate: { current: 'ready' }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 } };
}

function world(opts: { sidebarVisible: boolean; chats: number; phone?: string | null; soloVisible?: string; grid?: boolean; focused?: boolean }) {
  const made: Engine[] = [];
  const host = new HostEngine<Engine>({ make: () => { const e = new Engine('host'); made.push(e); return e; }, cwd: () => 'C:/work', log: () => undefined });
  const chats = Array.from({ length: opts.chats }, (_, i) => chat(`session-${i + 1}`, new Engine(`chat${i + 1}`)));
  const panel: PanelSignals & { sessions(): Iterable<SignalSession & { client: Engine }> } = {
    sessions: () => chats,
    activeId: () => chats[0]?.id ?? null,
    grid: () => opts.grid === true,
    solo: (id) => (id === opts.soloVisible ? { visible: true, active: true } : undefined), // t-x3a89j: the ACTIVE editor tab
    question: () => false,
  };
  const win: WindowSignals = { sidebarVisible: () => opts.sidebarVisible, sidebarFocused: () => opts.focused === true, sidebarChat: () => panel.activeId(), phoneFocus: () => opts.phone ?? null, engineBusy: () => false };
  host.setChats(panel, () => onScreenClient(panel, win)); // the DashboardPanel wiring
  const read = () => hostReadArg(host, () => chats.length > 0);
  return { host, made, chats, read };
}

/** The collab host the way DashboardPanel wires it (collabManagerHost). */
const collabHost = (host: HostEngine<Engine>, posts: Array<Record<string, unknown>>) => ({
  post: (m: Record<string, unknown>) => void posts.push(m),
  cwd: () => 'C:/work',
  collabClient: () => hostOnlyClient(host),
  collabWatchClient: () => host.ownClient() ?? host.current(),
});

const usageHost = (client: { extMethod(m: string, p?: Record<string, unknown>): Promise<Record<string, unknown>> } | undefined) => ({
  client, post: () => undefined, read: () => undefined, write: () => undefined, now: () => Date.now(),
  capableIds: async () => ['openai'], planWindows: async () => [],
});

beforeEach(() => __resetUsageSamplingForTests());
afterEach(() => { stopCollabWatch(); vi.useRealTimers(); });

describe('the active chat is HIDDEN: every host read goes to the host engine', () => {
  it('Nests (the hub adapter), usage sampling and storage reach the host engine; the hidden chat is asked nothing', async () => {
    const { host, made, chats, read } = world({ sidebarVisible: false, chats: 2 });
    await host.nestEngine.extMethod('nest_index', {});
    await sampleUsage(usageHost(read().client));
    const posts: Array<Record<string, unknown>> = [];
    await handleStorageMessage({ ...read(), post: (x) => void posts.push(x) }, { type: 'requestStorageStats' });
    expect(made).toHaveLength(1); // ONE host engine serves all three
    expect(made[0]!.calls).toEqual(['nest_index', 'provider_auth_usage', 'storage_stats']);
    expect(chats.map((c) => c.client.calls)).toEqual([[], []]);
    expect(posts[0]).toMatchObject({ type: 'storageStatsData', stats: {} });
  });

  it('the collab watch polls the host engine every tick once it runs, never a chat', async () => {
    vi.useFakeTimers();
    const { host, made, chats } = world({ sidebarVisible: false, chats: 1 });
    await hostOnlyClient(host).extMethod('collab_post', {}); // a room ran here: the runner is in the host engine
    const posts: Array<Record<string, unknown>> = [];
    watchCollabs(collabHost(host, posts), ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 3);
    expect(made[0]!.calls).toEqual(['collab_post', 'collab_state', 'collab_state', 'collab_state']);
    expect(chats[0]!.client.calls).toEqual([]);
    expect(posts).toHaveLength(3);
  });

  it('no host engine and every chat hidden: the collab watch asks nobody and starts nothing', async () => {
    vi.useFakeTimers();
    const { host, made, chats } = world({ sidebarVisible: false, chats: 1 });
    const posts: Array<Record<string, unknown>> = [];
    watchCollabs(collabHost(host, posts), ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS * 3);
    expect(made).toHaveLength(0);
    expect(chats[0]!.client.calls).toEqual([]);
    expect(posts).toHaveLength(0);
  });
});

describe('a chat ON screen: host reads use it and spawn nothing', () => {
  it('sidebar visible with the active chat: Nests, usage and storage go to that chat', async () => {
    const { host, made, chats, read } = world({ sidebarVisible: true, chats: 2 });
    await host.nestEngine.extMethod('nest_index', {});
    await sampleUsage(usageHost(read().client));
    await handleStorageMessage({ ...read(), post: () => undefined }, { type: 'requestStorageStats' });
    expect(made).toHaveLength(0);
    expect(chats[0]!.client.calls).toEqual(['nest_index', 'provider_auth_usage', 'storage_stats']);
    expect(chats[1]!.client.calls).toEqual([]);
  });

  it('only chat 2 has a focused editor tab: reads go to chat 2, not the hidden active chat 1', async () => {
    const { host, made, chats } = world({ sidebarVisible: false, chats: 2, soloVisible: 'session-2' });
    await host.nestEngine.extMethod('nest_index', {});
    expect(made).toHaveLength(0);
    expect(chats.map((c) => c.client.calls)).toEqual([[], ['nest_index']]);
  });

  it('t-x3a89j: a grid sidebar that is visible but not focused holds no active chat: reads go to the host engine, not a tile (a read stamps the quiet clock, so a tile read on every timer never idles)', async () => {
    const { host, made, chats } = world({ sidebarVisible: true, chats: 3, grid: true, focused: false });
    await host.nestEngine.extMethod('nest_index', {});
    expect(made).toHaveLength(1);
    expect(chats.map((c) => c.client.calls)).toEqual([[], [], []]);
  });

  it('a chat on the phone counts as on screen', async () => {
    const { host, made, chats } = world({ sidebarVisible: false, chats: 2, phone: 'session-2' });
    await host.nestEngine.extMethod('nest_index', {});
    expect(made).toHaveLength(0);
    expect(chats[1]!.client.calls).toEqual(['nest_index']);
  });

  it('collab runner calls still go to the host engine while a chat is on screen: one engine holds every room', async () => {
    const { host, made, chats } = world({ sidebarVisible: true, chats: 1 });
    await hostOnlyClient(host).extMethod('collab_post', {});
    await hostOnlyClient(host).extMethod('collab_state', {});
    expect(made).toHaveLength(1);
    expect(made[0]!.calls).toEqual(['collab_post', 'collab_state']);
    expect(chats[0]!.client.calls).toEqual([]);
  });

  it('the collab LIST (sent on every sidebar mount) and a watch with no host engine read the on-screen chat and start nothing', async () => {
    vi.useFakeTimers();
    const { host, made, chats, read } = world({ sidebarVisible: true, chats: 1 });
    await read().client!.extMethod('collab_list', {});
    watchCollabs(collabHost(host, []), ['c1']);
    await vi.advanceTimersByTimeAsync(COLLAB_WATCH_MS);
    expect(made).toHaveLength(0);
    expect(chats[0]!.client.calls).toEqual(['collab_list', 'collab_state']);
  });
});

describe('collabManager: the list rides collabListClient, a post rides collabClient', () => {
  it('requestCollabs reads the on-screen chat and starts nothing; collabPost goes to the host engine', async () => {
    const { host, made, chats, read } = world({ sidebarVisible: true, chats: 1 });
    const posts: Array<Record<string, unknown>> = [];
    const h = { ...collabHost(host, posts), collabListClient: () => read().client, collabOrder: () => [], saveCollabOrder: () => undefined, openCollab: async () => undefined, promptCaptureFor: async () => ({ capture: null }) };
    await handleCollabMessage(h, { type: 'requestCollabs' });
    expect(made).toHaveLength(0);
    expect(chats[0]!.client.calls).toEqual(['collab_list']);
    await handleCollabMessage(h, { type: 'collabPost', collabId: 'c1', text: 'hi' });
    expect(made[0]!.calls).toEqual(['collab_post']);
    expect(chats[0]!.client.calls).toEqual(['collab_list']);
    stopCollabWatch();
  });
});

describe('a bare window (no chat, no host engine) still spawns nothing for a background read', () => {
  it('usage sampling and storage get no client; nothing starts', async () => {
    const { made, read } = world({ sidebarVisible: true, chats: 0 });
    expect(read()).toEqual({});
    await sampleUsage(usageHost(read().client));
    expect(made).toHaveLength(0);
  });
});

describe('a read resolves its engine when it is MADE, not when the client object was built', () => {
  it('a client built while the chat was on screen goes to the host engine once the chat hides', async () => {
    let visible = true;
    const made: Engine[] = [];
    const host = new HostEngine<Engine>({ make: () => { const e = new Engine('host'); made.push(e); return e; }, cwd: () => 'C:/work', log: () => undefined });
    const c = chat('session-1', new Engine('chat1'));
    const panel = { sessions: () => [c], activeId: () => 'session-1', grid: () => false, solo: () => undefined, question: () => false };
    host.setChats(panel, () => onScreenClient(panel, { sidebarVisible: () => visible, sidebarFocused: () => false, sidebarChat: () => panel.activeId(), phoneFocus: () => null, engineBusy: () => false }));
    const client = hostReadArg(host, () => true).client!;
    await client.extMethod('provider_auth_usage');
    visible = false;
    await client.extMethod('provider_auth_usage');
    expect(c.client.calls).toEqual(['provider_auth_usage']);
    expect(made[0]!.calls).toEqual(['provider_auth_usage']);
  });
});
