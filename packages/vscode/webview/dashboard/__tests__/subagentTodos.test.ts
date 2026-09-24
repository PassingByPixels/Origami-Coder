// subagentTodos — how a SUB-AGENT's todo list reaches the host, given that it
// never arrives on the wire.
//
// The engine refuses to forward a child's tool parts as ACP tool calls and
// degrades each to one text line (`> todowrite`), dropping the list. So the
// host treats that line as a SIGNAL and pulls the child's stored session, which
// carries `rawInput` through verbatim. Three things have to be right, and each
// fails silently if it is not: the line must be RECOGNISED (or the panel stays
// empty and nothing errors), the LATEST list must win (or the panel shows a
// superseded plan), and the pulls must be COALESCED (or a model writing a list
// three times in five seconds costs three whole-transcript reads).

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSubagentTodoPuller, saysTodoWrite, todosFromTranscript } from '../../../src/dashboard/subagentTodos';
import type { SessionMessage } from '../../../src/dashboard/sessionLog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A tool entry shaped the way subagentTranscript.ts's `toolEntry` shapes one. */
const toolEntry = (toolName: string, rawInput: unknown): SessionMessage => ({
  kind: 'tool',
  text: toolName,
  timestamp: 0,
  tool: { call: { toolCallId: 'tc', toolName, rawInput }, result: { toolCallId: 'tc' } } as SessionMessage['tool'],
});

const list = (...contents: string[]) => ({ todos: contents.map((content) => ({ content, status: 'pending' })) });

describe('saysTodoWrite — reading the engine’s forwarded activity line', () => {
  it('recognises both shapes childToolLine writes', () => {
    // `> <tool>` and `> <tool>: <title>` — acp/event.ts `childToolLine`.
    expect(saysTodoWrite('> todowrite\n')).toBe(true);
    expect(saysTodoWrite('> todowrite: 3 todos\n')).toBe(true);
  });

  it('finds the line when the chunk carries more than one', () => {
    // A chunk can arrive with a preceding line and a trailing error line; an
    // unanchored-to-line match would miss it or a start-only match would.
    expect(saysTodoWrite('> read: a.ts\n> todowrite\n')).toBe(true);
  });

  it('does not fire on another tool, or on prose that mentions one', () => {
    // A false positive costs a whole transcript read per chunk.
    expect(saysTodoWrite('> read: todowrite.txt\n')).toBe(false);
    expect(saysTodoWrite('I will call todowrite next\n')).toBe(false);
    expect(saysTodoWrite('> todowriter\n')).toBe(false);
    expect(saysTodoWrite('')).toBe(false);
  });
});

describe('todosFromTranscript — the list inside a child’s stored session', () => {
  it('takes the LAST todowrite, because each one replaces the whole list', () => {
    const todos = todosFromTranscript([
      toolEntry('todowrite', list('old one', 'old two')),
      toolEntry('read', { filePath: 'a.ts' }),
      toolEntry('todowrite', list('current one', 'current two', 'current three')),
    ]);
    expect(todos.map((t) => t.content)).toEqual(['current one', 'current two', 'current three']);
  });

  it('is empty for a child that wrote no todos at all', () => {
    expect(todosFromTranscript([toolEntry('bash', { command: 'ls' })])).toEqual([]);
    expect(todosFromTranscript([])).toEqual([]);
  });

  it('skips a todowrite entry with no input and keeps looking', () => {
    // A call captured before its input landed must not blank a list that is
    // sitting one entry further back.
    const todos = todosFromTranscript([
      toolEntry('todowrite', list('the real list')),
      toolEntry('todowrite', undefined),
    ]);
    expect(todos.map((t) => t.content)).toEqual(['the real list']);
  });

  it('ignores a non-tool entry rather than throwing on it', () => {
    const plain: SessionMessage = { kind: 'agent', text: 'thinking', timestamp: 0 };
    expect(todosFromTranscript([plain, toolEntry('todowrite', list('x'))])).toHaveLength(1);
  });
});

describe('makeSubagentTodoPuller — one read per child at a time', () => {
  /** A read that only resolves when the test says so. */
  function gated() {
    const gates: Array<() => void> = [];
    const reads: string[] = [];
    return {
      reads,
      release: () => gates.shift()?.(),
      read: (child: string) => {
        reads.push(child);
        return new Promise<{ entries: SessionMessage[] }>((resolve) => {
          gates.push(() => resolve({ entries: [toolEntry('todowrite', list(`list ${reads.length}`))] }));
        });
      },
    };
  }

  it('folds every signal that lands mid-read into ONE follow-up read', async () => {
    // The defect this prevents: a model writing a nine-item list emits several
    // todowrite calls in a few seconds, and each read returns a whole
    // transcript. Five signals during one read must cost two reads, not six —
    // and the second read runs AFTER the last signal, so the last state wins.
    const g = gated();
    const posts: Array<[string, number]> = [];
    const pull = makeSubagentTodoPuller({ read: g.read, post: (c, t) => posts.push([c, t.length]) });

    pull('child-1');
    expect(g.reads).toEqual(['child-1']);
    pull('child-1'); pull('child-1'); pull('child-1'); pull('child-1');
    expect(g.reads).toEqual(['child-1']); // still just the one in flight

    g.release();
    await vi.waitFor(() => expect(g.reads).toHaveLength(2));
    g.release();
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(g.reads).toEqual(['child-1', 'child-1']);
  });

  it('reads two DIFFERENT children concurrently — they do not queue behind each other', async () => {
    const g = gated();
    const pull = makeSubagentTodoPuller({ read: g.read, post: () => {} });
    pull('child-1');
    pull('child-2');
    expect(g.reads).toEqual(['child-1', 'child-2']);
  });

  it('posts an EMPTY list, which is how a tab disappears', async () => {
    const posts: Array<[string, number]> = [];
    const pull = makeSubagentTodoPuller({
      read: async () => ({ entries: [] }),
      post: (c, t) => posts.push([c, t.length]),
    });
    pull('child-1');
    await vi.waitFor(() => expect(posts).toEqual([['child-1', 0]]));
  });

  it('reports a failed read instead of throwing it at the chunk handler', async () => {
    // This runs off the live stream. One unreadable child must not take the
    // parent's output with it — and must not post a spurious empty list either,
    // which would retire a tab over a transient read error.
    const logged: string[] = [];
    const posts: unknown[] = [];
    const pull = makeSubagentTodoPuller({
      read: () => Promise.reject(new Error('engine gone')),
      post: (...a) => posts.push(a),
      log: (l) => logged.push(l),
    });
    pull('child-1');
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toContain('engine gone');
    expect(posts).toEqual([]);
  });

  // t-geo4n3 acceptance 4 — THE FAST CHILD, end to end on the host side.
  //
  // The owner's four sub-agents each did one thing: write a todo list, then
  // finish. That is the worst case for this road, because the pull is started
  // off a forwarded text line and answered asynchronously, while the child's
  // done marker lands in between. If anything about the finish cancelled or
  // pre-empted the pull, the list would never reach the panel — and the panel
  // would be blank with no error anywhere, which is exactly what was reported.
  it('a todowrite signal followed IMMEDIATELY by the done marker still posts the list', async () => {
    const posts: Array<{ child: string; items: string[] }> = [];
    let resolveRead: (v: { entries: SessionMessage[] }) => void = () => {};
    const pull = makeSubagentTodoPuller({
      read: () => new Promise((r) => { resolveRead = r; }),
      post: (child, todos) => posts.push({ child, items: todos.map((t) => t.content) }),
    });

    // 1. the engine forwards the child's tool line under the PARENT's session
    //    (acp/event.ts childToolLine) — DashboardPanel's onSubagentChunk.
    const chunk = '> todowrite: 3 todos\n';
    expect(saysTodoWrite(chunk)).toBe(true);
    if (saysTodoWrite(chunk)) pull('child-1');

    // 2. the child finishes before the transcript read comes back. The done
    //    marker retires the card and the roster row; it must not touch the
    //    read in flight.
    expect(posts).toEqual([]);

    // 3. the read lands, carrying the list the child wrote.
    resolveRead({ entries: [toolEntry('todowrite', list('read it', 'change it', 'test it'))] });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ child: 'child-1', items: ['read it', 'change it', 'test it'] });
  });

  it('the PANEL wiring matches: the chunk starts the pull and the done marker leaves it alone', () => {
    // The assertion above proves the puller; this proves DashboardPanel calls it
    // that way and that nothing on the finish path cancels it. A source read,
    // because the panel needs a live VS Code host to construct — the same
    // technique subagentTokens.test.ts's mirror guard uses.
    const src = readFileSync(
      path.resolve(__dirname, '../../../src/dashboard/DashboardPanel.ts'),
      'utf8',
    );
    const slice = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
    expect(slice('onSubagentChunk:', 'onSubagentTokens:'))
      .toMatch(/if \(saysTodoWrite\(text\)\) this\.pullSubagentTodos\(sessionId\)\(childSessionId\)/);
    // Nothing in the done handler touches the puller — no cancel, no clear, no
    // "drop what is in flight for this child".
    expect(slice('onSubagentDone:', 'onUserMessageChunk:')).not.toMatch(/SubagentTodo|subagentTodoPuller/);
  });

  it('ignores a signal with no child id rather than reading for ""', async () => {
    const reads: string[] = [];
    makeSubagentTodoPuller({ read: async (c) => { reads.push(c); return { entries: [] }; }, post: () => {} })('');
    expect(reads).toEqual([]);
  });
});
