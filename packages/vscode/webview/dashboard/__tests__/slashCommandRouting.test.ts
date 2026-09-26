// slashCommandRouting.test.ts — t-xsufto (owner UAT of 0.4.178): a slash command runs in the chat it was typed in.
// The composer posted `slashCommand` with no sessionId and DashboardPanel.handleSlashCommand ran it on
// `activeSessionId`, the sidebar's last selected chat, which a popped-out chat never becomes. So `/wrap` typed in the
// "Mod work" tab ran in the empty "New session" chat, and `/bypass` would switch ANOTHER chat's permission mode.
//
// These tests drive the REAL DashboardPanel message handler over its own prototype (the pillsMountRace /
// remotePanelHarness pattern) with two fake chats: A is popped out (the owner types there), B is the sidebar's
// selected chat. The bugs each block catches: a shell command (/spend), a fork (/btw), an engine command (/wrap) or a
// mode command (/bypass /auto /plan /default) acting on B; a post for a closed chat falling back to B; the other
// composer posts (image error, budget note, model eject) reporting into B.
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
  window: { showWarningMessage: () => Promise.resolve(undefined), createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

// No OS toast from a test: turnDone would otherwise reach the desktop notifier.
vi.mock('../../../src/notify/notifyEvents', async (orig) => ({ ...(await orig() as Record<string, unknown>), notifyOnPost: () => undefined }));

const forked: string[] = [];
vi.mock('../../../src/dashboard/sessionFork', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  forkChat: vi.fn(async (sessionId: string) => { forked.push(sessionId); }),
}));
vi.mock('../../../src/dashboard/spend', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  // No read of the live ~/.origami/spend.json: A has spent $1.50, B $0.25.
  readSpend: () => ({ month: '2026-09', total: 3, sessions: { 'session-a': 1.5, 'session-b': 0.25 } }),
  writeBudget: (monthly: number | null) => ({ monthly }),
}));

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { DeltaFanout } from '../../../src/dashboard/deltaFanout';
import { PermissionBannerState } from '../../../src/dashboard/permissionBanner';

type Post = Record<string, unknown>;

function fakeChat(id: string, n: number) {
  const client = {
    currentSessionId: `ses_${id}`,
    modes: [] as string[],
    prompts: [] as string[],
    setSessionMode: vi.fn(async function (this: void, mode: string) { client.modes.push(mode); }),
    prompt: vi.fn(async (text: string) => { client.prompts.push(text); return 'end_turn'; }),
    setConfigOption: vi.fn(async () => undefined),
    getModeOption: () => ({ current: 'build', options: [] }),
    getModelOption: () => ({ current: '', options: [] }),
  };
  return {
    id, number: n, agentName: 'Tsuru', title: id === 'session-a' ? 'Mod work' : 'New session', messageLog: [], turnBusy: false,
    estimatedTokens: 0, pendingPermissions: new Map(), runningChildren: new Set(), client,
    gate: { current: 'ready', whenUp: async () => true, turn: async <T>(fn: () => Promise<T>) => ({ sent: true as const, value: await fn() }) },
  };
}

/** Two chats: A popped out into its own tab (typed in), B the sidebar's selected chat (activeSessionId). */
function rig() {
  const posts: Post[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, unknown>;
  Object.defineProperty(p, 'cwd', { value: process.cwd() });
  const a = fakeChat('session-a', 7);
  const b = fakeChat('session-b', 8);
  const sessions = new Map<string, unknown>([[a.id, a], [b.id, b]]);
  p['sessions'] = sessions;
  p['activeSessionId'] = b.id;
  p['extraViews'] = [];
  p['viewSolo'] = new Map();
  p['viewWiring'] = new Map();
  p['deltaFanout'] = new DeltaFanout((id) => sessions.has(id));
  p['pendingQuestionPermissions'] = new Map();
  p['permBanner'] = new PermissionBannerState();
  // Eject: `begin` answers "busy", so the handler reports in its chat and never spawns the `lms` CLI (the owner's LM Studio).
  p['modelOps'] = { begins: [] as string[], begin(sid: string) { this.begins.push(sid); return null; }, busyMessage: () => 'a model operation is running' };
  p['context'] = {
    extensionUri: { fsPath: process.cwd() },
    extension: { packageJSON: { version: 'harness' } },
    globalState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
    workspaceState: { get: <T>(_k: string, d: T) => d, update: () => Promise.resolve() },
  };
  p['panel'] = { webview: { postMessage: (m: Post) => { posts.push(m); return Promise.resolve(true); } } };
  p['pollControllerState'] = async () => undefined; // the gauge poll after a turn: not what this suite is about
  const send = (m: Post) => (p['handleWebviewMessage'] as (m: unknown) => Promise<void>).call(p, m);
  const to = (sid: string) => posts.filter((m) => m.sessionId === sid);
  const banner = p['permBanner'] as PermissionBannerState;
  return { posts, a, b, send, to, banner };
}

beforeEach(() => { forked.length = 0; });

describe('a slash command typed in a popped-out chat runs in THAT chat, not the sidebar`s selected chat', () => {
  it('/spend reports the typed-in chat`s own cost, in that chat', async () => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: 'spend', args: '', sessionId: 'session-a' });
    expect(r.to('session-a').map((m) => m.type)).toEqual(['echoUser', 'system', 'turnDone']);
    expect(String(r.to('session-a')[1]!.text)).toContain('this chat: $1.50');
    expect(r.to('session-b')).toEqual([]);
  });

  it('/btw forks the typed-in chat', async () => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: 'btw', args: 'a side question', sessionId: 'session-a' });
    expect(forked).toEqual(['session-a']);
  });

  it('a custom command (/wrap) is prompted to the typed-in chat`s engine only', async () => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: 'wrap', args: '', sessionId: 'session-a' });
    expect(r.a.client.prompts).toEqual(['/wrap']);
    expect(r.b.client.prompts).toEqual([]);
    expect(r.to('session-a').map((m) => m.type)).toEqual(['echoUser', 'turnDone']);
    expect(r.to('session-b')).toEqual([]);
  });

  it.each(['bypass', 'auto', 'plan', 'default'])('/%s changes the mode of the typed-in chat only; the other chat`s mode is unchanged', async (mode) => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: mode, args: '', sessionId: 'session-a' });
    expect(r.a.client.modes).toEqual([mode]);
    expect(r.b.client.modes).toEqual([]);
    expect(r.banner.modeFor('session-b')).toBe('default');
    expect(r.to('session-a').filter((m) => m.type === 'modeUpdate').map((m) => m.mode)).toEqual([mode]);
    expect(r.to('session-b').filter((m) => m.type === 'modeUpdate')).toEqual([]);
  });

  it('a post that names a chat that is no longer open runs nowhere (never falls back to the selected chat)', async () => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: 'bypass', args: '', sessionId: 'session-gone' });
    expect(r.a.client.modes).toEqual([]);
    expect(r.b.client.modes).toEqual([]);
  });

  it('a post with no sessionId (an older webview, a palette command) keeps the old fallback: the selected chat', async () => {
    const r = rig();
    await r.send({ type: 'slashCommand', command: 'wrap', args: '' });
    expect(r.b.client.prompts).toEqual(['/wrap']);
    expect(r.a.client.prompts).toEqual([]);
  });
});

describe('the other composer posts that relied on activeSessionId report into the chat they came from', () => {
  it('an image error from the composer lands in the typed-in chat', async () => {
    const r = rig();
    await r.send({ type: 'imageError', message: 'too big', sessionId: 'session-a' });
    expect(r.to('session-a').map((m) => m.type)).toEqual(['imageError']);
    expect(r.to('session-b')).toEqual([]);
  });

  it('the model picker`s Eject reports in the chat it was clicked in', async () => {
    const r = rig();
    await r.send({ type: 'modelPanel.unload', identifier: 'some-model', sessionId: 'session-a' });
    expect(r.to('session-a').map((m) => m.text)).toEqual(['a model operation is running']);
    expect(r.to('session-b')).toEqual([]);
  });
});
