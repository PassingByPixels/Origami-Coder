// childTodoRoad.test.ts — t-gyp8fj. The HOST half of a sub-agent's todo road,
// driven with the frames the engine really sends.
//
// THE DEFECT. Owner, 0.4.146: two sub-agents each wrote a todo list, both lists
// were in the engine's database, and the Todo panel showed `Main` alone with no
// tab strip at all. Every piece on this road had a test; the road did not.
//
// The fixtures below are NOT invented. They are the recorded output of
// packages/engine/test/acp/child-todo-road.test.ts, which drives the real
// processor, the real event bus and the real ACP subscription over a child
// session that thinks and then calls `todowrite`: three `agent_message_chunk`
// frames, and the `subagent_transcript` projection read on the third one. Docs
// Part 6 rule 3 — a fixture for something external is derived from that thing.
//
// What this covers that the per-file tests do not: the frames go through the
// REAL acpClient decode, the chunk handler is wired the way DashboardPanel wires
// it (saysTodoWrite -> the real puller -> the real transcript payload mapper),
// and the post lands in the REAL ChatPane, whose strip must end up with a tab.

import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { makeSubagentTodoPuller, saysTodoWrite } from '../../../src/dashboard/subagentTodos';
import { subagentTranscriptPayload } from '../../../src/dashboard/subagentTranscript';

afterEach(() => cleanup());

const SESSION = 'sess-1';
const CHILD = 'ses_f5489efe0ffefjhxbdXiOyCNiF';

/** VERBATIM from the engine rig's recording connection: what the parent's
 *  connection received for the child, in order. The reasoning riders are
 *  0.4.146's (t-gvz8t0); the third frame is the host's only todo signal. */
const FRAMES = [
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'weighing the plan' },
      _meta: { origami_child_session: CHILD, origami_task_part: 'reasoning' },
    },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: ' a little longer' },
      _meta: { origami_child_session: CHILD, origami_task_part: 'reasoning' },
    },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '> todowrite\n' },
      _meta: { origami_child_session: CHILD },
    },
  },
] as const;

/** VERBATIM from the same run: what `subagent_transcript` answered when it was
 *  read ON the third frame. `status: in_progress` and a populated `rawInput` —
 *  the todowrite is still running, which is the ordinary case for this read. */
const TRANSCRIPT = {
  sessionId: CHILD,
  found: true,
  running: true,
  truncated: false,
  entries: [
    { type: 'text', role: 'user', messageId: 'msg_a', text: 'go' },
    { type: 'reasoning', messageId: 'msg_b', text: 'weighing the plan a little longer' },
    {
      type: 'tool',
      messageId: 'msg_b',
      toolCall: {
        toolCallId: 'call_1',
        title: 'todowrite',
        kind: 'other',
        status: 'in_progress',
        locations: [],
        rawInput: {
          todos: [
            { content: 'read the ticket', status: 'in_progress', priority: 'high' },
            { content: 'write the test', status: 'pending', priority: 'high' },
          ],
        },
        _meta: { origami_tool_name: 'todowrite' },
      },
    },
  ],
};

const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

function handlers(over: Partial<AcpEventHandlers>): AcpEventHandlers {
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
    onFlockMailbox: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...over,
  } as AcpEventHandlers;
}

/** DashboardPanel's own wiring, at the two seams a test can reach: the chunk
 *  handler (DashboardPanel.ts `onSubagentChunk`) and the puller it builds
 *  (`pullSubagentTodos`), both over the real modules. The `read` is the real
 *  `subagentTranscriptPayload` over a client that answers with the recorded
 *  engine projection. */
function hostSide(transcript: unknown, reads: string[]) {
  const client = {
    getSubagentTranscript: async (sessionId: string) => {
      reads.push(sessionId);
      return transcript as never;
    },
  };
  const pull = makeSubagentTodoPuller({
    read: (child) => subagentTranscriptPayload(client, child),
    post: (childSessionId, todos) => post({ type: 'subagentTodos', childSessionId, todos, sessionId: SESSION }),
  });
  return handlers({
    onSubagentChunk: ({ childSessionId, text }: { childSessionId: string; text: string }) => {
      post({ type: 'subagentChunk', childSessionId, text, sessionId: SESSION });
      if (saysTodoWrite(text)) pull(childSessionId);
    },
    onSubagentThought: ({ childSessionId, text }: { childSessionId: string; text: string }) => {
      post({ type: 'subagentThinking', childSessionId, text, sessionId: SESSION });
    },
  } as Partial<AcpEventHandlers>);
}

/** The real decode: an AcpClient bound to the parent session, fed frames. */
function wire(hs: AcpEventHandlers) {
  const client = new AcpClient(hs);
  (client as unknown as { sessionId: string }).sessionId = SESSION;
  return (client as unknown as { buildClientImpl: () => { sessionUpdate: (p: unknown) => Promise<void> } })
    .buildClientImpl();
}

/** A chat with one background sub-agent out, exactly as the drawer sees it.
 *  `own` is the chat's OWN todo list — present in the owner's screenshot
 *  (`Main 2/3 done · 1 active`), and empty for the case below it. */
async function paneWithTaskCard(own: string[] = ['the chat’s own plan']) {
  render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  if (own.length > 0) {
    post({
      type: 'todoUpdate', sessionId: SESSION, source: 'model_write',
      todos: own.map((content, id) => ({ id, content, activeForm: content, status: 'pending' })),
    });
    await tick();
  }
  post({
    type: 'toolCall', sessionId: SESSION, toolCallId: 'call_1', title: 'task', kind: 'think',
    status: 'in_progress', toolName: 'task', taskSessionId: CHILD,
    rawInput: { description: 'write story 1', subagent_type: 'general', prompt: 'go' },
  });
  await tick();
}

const tabs = () => [...document.querySelectorAll('.todo-listtab-label')].map((t) => t.textContent);

describe('the child todo road, host end — engine frames to a tab on the strip', () => {
  it('turns the `> todowrite` frame into a tab carrying the child’s list', async () => {
    const reads: string[] = [];
    const impl = wire(hostSide(TRANSCRIPT, reads));
    await paneWithTaskCard();

    for (const frame of FRAMES) await impl.sessionUpdate(frame);

    // The signal was recognised and answered with ONE read of that child.
    await vi.waitFor(() => expect(reads).toEqual([CHILD]));
    await vi.waitFor(async () => {
      await tick();
      expect(tabs()).toEqual(['Main', 'T1']);
    });

    // And the tab really holds the child's list, not an empty one.
    const tab = [...document.querySelectorAll('.todo-listtab')]
      .find((b) => b.querySelector('.todo-listtab-label')?.textContent === 'T1') as HTMLElement;
    await fireEvent.click(tab);
    await tick();
    expect([...document.querySelectorAll('.todo-content')].map((t) => t.textContent?.trim()))
      .toEqual(['read the ticket', 'write the test']);
  });

  it('offers the child’s tab even when the chat keeps NO list of its own', async () => {
    // Found by the case above while it was red. `todoOverlayVisible` counts the
    // children, so the panel comes up for a chat with no list of its own — and
    // TodoStrip's empty branch dropped the tab row, leaving "Todos: none yet"
    // with the child's list one unreachable tab away.
    const reads: string[] = [];
    const impl = wire(hostSide(TRANSCRIPT, reads));
    await paneWithTaskCard([]);

    for (const frame of FRAMES) await impl.sessionUpdate(frame);
    await vi.waitFor(() => expect(reads).toEqual([CHILD]));
    await vi.waitFor(async () => {
      await tick();
      expect(tabs()).toEqual(['Main', 'T1']);
    });
  });

  it('draws NO tab when the read lands on a todowrite whose input has not arrived', async () => {
    // The 0.4.146 defect, as the host experienced it. The engine forwarded the
    // signal off the PENDING tool part, whose stored input is the `{}` the
    // processor seeds (session/processor.ts `ensureToolCall`) — so the pull
    // answered an empty list, and the dedupe in acp/event.ts meant no second
    // signal ever came. Nothing errors anywhere: the strip simply never appears.
    const empty = {
      ...TRANSCRIPT,
      entries: [
        TRANSCRIPT.entries[0],
        TRANSCRIPT.entries[1],
        {
          ...TRANSCRIPT.entries[2],
          toolCall: { ...(TRANSCRIPT.entries[2] as { toolCall: object }).toolCall, status: 'pending', rawInput: {} },
        },
      ],
    };
    const reads: string[] = [];
    const impl = wire(hostSide(empty, reads));
    await paneWithTaskCard();

    for (const frame of FRAMES) await impl.sessionUpdate(frame);
    await vi.waitFor(() => expect(reads).toEqual([CHILD]));
    await tick();
    await tick();
    expect(tabs()).toEqual([]);
  });
});
