// historyFlavour.test.ts — t-d94ywq: a history recall must rebuild the SAME row
// the live stream showed for an agent-to-agent message (a peer/collab handoff,
// or a sub-agent's task card), not a plain text line.
//
// FIXTURE PROVENANCE (historyFlavour.fixture.json): a REAL `session/load` replay,
// captured the same way reloadReplay.fixture.json was — a live engine subprocess,
// speaking real ACP — except pointed at a COPY of this machine's OWN production
// database (`~/.local/share/origami/origami.db`, never opened for write) instead
// of a throwaway one, so the session is a genuine recorded one: three background
// sub-agents launched from a real chat, plus a real cross-session peer handoff
// (`send_message` to another Origami window) that answered it. Free-text bodies
// (the sub-agents' multi-page wiki dump, real file paths) were replaced with a
// short placeholder — the riders under test (`_meta.origami_peer`,
// `_meta.origami_task_*`) and the envelope tags (`<peer_message ...>`,
// `<task id="..." state="...">`) are byte-identical to what the engine sent.
//
// The defect: `src/dashboard/peerMessages.ts`'s `peerLogEntry` used to flatten
// the peer rider into prose ("Message from agent X (reply to Y):\n<body>") under
// `kind: 'system'` — `SessionMessage` had no `'peer'` kind to carry it losslessly
// (sessionLog.ts:16, pre-fix). `webview/dashboard/panes/chatRestore.ts`'s
// `restoreLog` then had no branch to rebuild anything from a `'system'` entry but
// a generic text row (chatRestore.ts:58-71, pre-fix) — so a recalled chat showed
// the operator's own bubble style for a stranger's words, with no PeerMessageRow,
// no badge, no reply address. A sub-agent's `task` card was NOT affected — its
// full call/result payload already survives via `ToolLogCard` (sessionLog.ts) and
// restores through the SAME `applyToolCall`/`applyToolResult` merge rules the
// live stream uses — this file proves that with real captured data rather than
// assuming it from the synthetic fixture in reloadReplay.test.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { logToolCall, logToolResult, logSubagentDone, type SessionMessage } from '../../../src/dashboard/sessionLog';
import { peerLogEntry, type PeerOrigin } from '../../../src/dashboard/peerMessages';
import { restoreLog, type RestoredEntry } from '../panes/chatRestore';
import PeerMessageRow from '../components/PeerMessageRow.svelte';
import { restoredRow } from '../panes/restoredRow';

type Notification = { sessionId: string; update: Record<string, unknown> };

const REPLAY: Notification[] = JSON.parse(
  readFileSync(path.join(__dirname, 'historyFlavour.fixture.json'), 'utf8'),
);

afterEach(() => cleanup());

function noopHandlers(over: Partial<AcpEventHandlers>): AcpEventHandlers {
  return {
    onAgentMessageChunk: vi.fn(),
    onAgentImageChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onAvailableCommands: vi.fn(),
    onPlanStatus: vi.fn(),
    onPlanReady: vi.fn(),
    onBestOfNComplete: vi.fn(),
    onTaskShape: vi.fn(),
    onTodoUpdate: vi.fn(),
    onArbiterDecision: vi.fn(),
    onTurnEnd: vi.fn(),
    onAssessmentUpdate: vi.fn(),
    onFeedMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

/** Drive the captured stream through the REAL acpClient decode, twice: once
 *  recording exactly what a LIVE webview would have been posted, once wired the
 *  way DashboardPanel.ts wires a history recall (into `session.messageLog`). */
async function replay() {
  const livePeers: (PeerOrigin & { text: string })[] = [];
  const liveToolStarts: Record<string, unknown>[] = [];
  const liveToolUpdates: Record<string, unknown>[] = [];
  const log: SessionMessage[] = [];

  const handlers = noopHandlers({
    onPeerMessage: (peer) => {
      livePeers.push(peer);
      log.push(peerLogEntry(peer));
    },
    onToolCallStart: (args) => {
      liveToolStarts.push(args as unknown as Record<string, unknown>);
      logToolCall(log, args as unknown as Record<string, unknown>);
    },
    onToolCallUpdate: (args) => {
      liveToolUpdates.push(args as unknown as Record<string, unknown>);
      logToolResult(log, args as unknown as Record<string, unknown>);
    },
    onSubagentDone: (args) => logSubagentDone(log, args.taskSessionId, args.state, args.endedAt),
  });
  const client = new AcpClient(handlers);
  const impl = (client as unknown as { buildClientImpl: () => { sessionUpdate: (p: unknown) => Promise<void> } })
    .buildClientImpl();
  for (const notification of REPLAY) await impl.sessionUpdate(notification);
  return { livePeers, liveToolStarts, liveToolUpdates, log };
}

describe('the fixture really is a real recorded session (guards the capture)', () => {
  it('carries a real peer rider and a real background task-launcher rider', () => {
    const peerUpdate = REPLAY.find((n) => (n.update._meta as { origami_peer?: unknown })?.origami_peer);
    expect(peerUpdate, 'no peer_message in the fixture').toBeDefined();
    const taskUpdate = REPLAY.find((n) => (n.update._meta as { origami_task_session?: unknown })?.origami_task_session
      && n.update.sessionUpdate === 'tool_call');
    expect(taskUpdate, 'no task tool_call in the fixture').toBeDefined();
    expect((taskUpdate!.update._meta as { origami_task_background?: unknown }).origami_task_background).toBe(true);
  });
});

describe('a recalled peer message renders the SAME row as the live one', () => {
  it('restores kind "peer" with the sender, reply address and raw text — not a system line', async () => {
    const { livePeers, log } = await replay();
    expect(livePeers.length, 'the fixture should contain at least one peer handoff').toBeGreaterThan(0);
    const live = livePeers[0];

    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const row = restored.find((m) => m.kind === 'peer' && m.label === live.from);
    expect(row, 'the replayed peer message must come back as a peer row, not text').toBeDefined();

    // RED before the fix: kind was 'system', label 'system', and the sender/reply
    // address/raw envelope were gone — flattened into one prose sentence.
    expect(row.text).toBe(live.text);
    expect(row.peerReplyTo).toBe(live.replyTo);
    expect(restored.some((m) => m.kind === 'system' && m.text.startsWith('Message from agent'))).toBe(false);
  });

  it('the restored row mounts the exact live component — same class, same badge', async () => {
    const { livePeers, log } = await replay();
    const live = livePeers[0];
    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const row = restored.find((m) => m.kind === 'peer' && m.label === live.from);

    // What ChatTranscript.svelte does for kind === 'peer' (PeerMessageRow),
    // driven by the RESTORED row's own props — proving the restore path lands
    // on the identical component the live path renders.
    const { container } = render(PeerMessageRow, {
      from: row.label, replyTo: row.peerReplyTo, text: row.text, flock: row.peerFlock,
    });
    expect(container.querySelector('.peer-row')).not.toBeNull();
    expect(container.querySelector('.peer-badge')!.textContent).toBe(`from ${live.from}`);
    expect(container.querySelector('.peer-row')!.getAttribute('data-peer-from')).toBe(live.from);
  });

  it('restores EVERY peer message in the session, not just the first', async () => {
    // This real session has three — a live agent answering back and forth.
    // Silently keeping only one would look identical to a demo with one row.
    const { livePeers, log } = await replay();
    expect(livePeers.length).toBe(3);
    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const peerRows = restored.filter((m) => m.kind === 'peer');
    expect(peerRows).toHaveLength(3);
    for (const row of peerRows) {
      expect(row.label).toBe('Origami UAT');
      expect(row.peerReplyTo).toBe('Origami UAT#ses_008f1372cffeZ7Bxq5m98gMD72');
    }
  });
});

describe('restoredRow — fail-closed and the flock variant (acpPeerMeta.ts philosophy)', () => {
  it('a malformed rider (missing replyTo) restores as a plain system row, not a broken peer one', () => {
    const row = restoredRow({ kind: 'peer', text: 'hello', timestamp: 1, peer: { from: 'reviewer' } as any }, 'Tsuru');
    expect(row.kind).toBe('system');
    expect(row.label).toBe('system');
  });

  it('a peer entry with NO rider at all restores as plain system, same as before the fix', () => {
    const row = restoredRow({ kind: 'peer', text: 'hello', timestamp: 1 }, 'Tsuru');
    expect(row.kind).toBe('system');
  });

  it('a flock rider restores as kind "peer" with the flock field intact', () => {
    const row = restoredRow({
      kind: 'peer', text: 'section 4', timestamp: 1,
      peer: { from: 'Macbook', replyTo: 'macbook@abc', flock: { contact: 'Macbook', thread: 'flq_1', kind: 'reply' } },
    }, 'Tsuru');
    expect(row.kind).toBe('peer');
    expect((row as any).peerFlock).toEqual({ contact: 'Macbook', thread: 'flq_1', kind: 'reply' });

    const { container } = render(PeerMessageRow, {
      from: (row as any).label, replyTo: (row as any).peerReplyTo, text: row.text, flock: (row as any).peerFlock,
    });
    expect(container.querySelector('.peer-badge')!.classList.contains('flock')).toBe(true);
  });
});

describe('a recalled sub-agent task card renders the SAME card as the live one', () => {
  it('restores with the identical toolName + task riders the live path decoded', async () => {
    const { liveToolStarts, log } = await replay();
    const liveTask = liveToolStarts.find((a) => a.taskBackground === true);
    expect(liveTask, 'the fixture should contain a background task launcher').toBeDefined();

    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const card = restored.find((m) => m.toolCallId === liveTask!.toolCallId);
    expect(card, 'the replayed task call must come back as a tool card, not text').toBeDefined();

    // RED before ANY reload fix: 'system' + no tool fields — asserted here
    // against REAL captured riders, not the synthetic ones reloadReplay.test.ts uses.
    expect(card.kind).toBe('tool');
    expect(card.toolName).toBe('task');
    expect(card.taskSessionId).toBe(liveTask!.taskSessionId);
    expect(card.taskBackground).toBe(true);
    expect(card.taskModel).toBe(liveTask!.taskModel);
  });

  it('the real terminal marker retires the card exactly as it did live', async () => {
    const { log } = await replay();
    const restored = restoreLog<any>([], log as RestoredEntry[], (() => { let n = 1; return () => n++; })(), 'Tsuru');
    const backgroundCards = restored.filter((m) => m.taskBackground === true);
    expect(backgroundCards.length).toBeGreaterThan(0);
    // Every background launcher in this real session settled before the capture
    // ended — the fixture's own `origami_task_state: completed` markers.
    for (const card of backgroundCards) expect(card.taskDone).toBe('completed');
  });
});
