// t-z1xlfy — the agent map's host data: the engine's `origami/backgroundTask`
// decoded through the REAL acpClient, and the per-chat store that a map opening
// late reads back.
import { describe, expect, it, vi } from 'vitest';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { adoptTreeRoster, agentTreePost, backgroundTaskFrom, newAgentTree, noteBackgroundTask } from '../../../src/dashboard/agentTreeHost';

function handlers(over: Partial<AcpEventHandlers> = {}): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(), onAgentImageChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(), onAvailableCommands: vi.fn(), onPlanStatus: vi.fn(), onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(), onTaskShape: vi.fn(), onTodoUpdate: vi.fn(), onClose: vi.fn(), onError: vi.fn(),
    ...over,
  };
}
const impl = (client: AcpClient) =>
  (client as unknown as { buildClientImpl: () => { extNotification: (m: string, p: unknown) => Promise<void> } }).buildClientImpl();

const TASK = { sessionId: 'ses_root', ownerSessionId: 'ses_kid', jobId: 'shell-c1', kind: 'shell', title: 'bun test --watch', status: 'running', startedAt: 1000 };
const row = (id: string, parentId: string, depth: number) => ({ id, parentId, depth, title: id, agent: 'explore', status: 'running' as const, created: 1, updated: 2, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: null, context: null });

describe('origami/backgroundTask on the wire', () => {
  it('reaches its handler decoded', async () => {
    const onBackgroundTask = vi.fn();
    const client = new AcpClient(handlers({ onBackgroundTask }));
    await impl(client).extNotification('_origami/backgroundTask', TASK);
    expect(onBackgroundTask).toHaveBeenCalledWith({ ownerSessionId: 'ses_kid', jobId: 'shell-c1', kind: 'shell', title: 'bun test --watch', status: 'running', startedAt: 1000 });
  });

  it('a frame with no owner, an unknown status or no start is dropped, not guessed', () => {
    expect(backgroundTaskFrom({ ...TASK, ownerSessionId: '' })).toBeNull();
    expect(backgroundTaskFrom({ ...TASK, status: 'paused' })).toBeNull();
    expect(backgroundTaskFrom({ ...TASK, startedAt: 'soon' })).toBeNull();
  });
});

describe('the per-chat agent tree', () => {
  it('a stop replaces its own start, and other jobs stay', () => {
    const tree = newAgentTree();
    noteBackgroundTask(tree, backgroundTaskFrom(TASK)!);
    noteBackgroundTask(tree, backgroundTaskFrom({ ...TASK, jobId: 'shell-c2' })!);
    noteBackgroundTask(tree, backgroundTaskFrom({ ...TASK, status: 'cancelled', endedAt: 9000 })!);
    expect(tree.background.map((t) => [t.jobId, t.status])).toEqual([['shell-c2', 'running'], ['shell-c1', 'cancelled']]);
  });

  it('the roster replaces the rows whole, grandchildren included, and the post carries both', () => {
    const tree = newAgentTree();
    adoptTreeRoster(tree, { sessionId: 'ses_root', rows: [row('a', 'ses_root', 1)], truncated: false });
    adoptTreeRoster(tree, { sessionId: 'ses_root', rows: [row('a', 'ses_root', 1), row('a1', 'a', 2)], truncated: false });
    const post = agentTreePost('chat-1', tree);
    expect(post.type).toBe('agentTree');
    expect(post.sessionId).toBe('chat-1');
    expect((post.rows as Array<{ id: string; parentId: string; depth: number }>).map((r) => [r.id, r.parentId, r.depth])).toEqual([['a', 'ses_root', 1], ['a1', 'a', 2]]);
  });
});
