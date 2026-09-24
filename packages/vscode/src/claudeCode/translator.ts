// translator.ts — Claude Code stream events → the webview messages the chat transcript already
// understands. Pure: an event and a state bag in, posts out. A passthrough cell must not invent a
// second rendering path, so almost every message here is one ChatPane already reduces for engine
// sessions. Two are new because the harness has no engine equivalent: `passthroughMeter`
// (funding/headroom) and `passthroughCommands` (this session's own `/` rows). Two asymmetries
// versus the engine path: agentText carries no messageId (rewind is capability-gated off), and tool
// arguments come from the whole `assistant` event rather than accumulated deltas.

import type { ClaudeEvent } from './protocol';
import { isSubagentEvent, resultUsage, sessionIdOf } from './protocol';
import { UNRESOLVED_TOOL_NOTE, settleOpenTools } from './cellState';
import { resetClause, resultErrorText, resultPlanLimited } from './childFailure';
import { beatPosts, openAgent } from './subagentBeat';
import { closeAgent, taskSystemPosts } from './subagentClose';
import { toolKind, toolTitle } from './toolCards';
import { taskResultPosts, taskUsePosts } from './taskStrip';
import {
  controlResponsePosts, rateLimitPosts, systemPosts,
  type TranslatorState, type WebviewPost,
} from './sessionState';
import { todosFromUpdate } from '../acpTodoWrite';

// The state bag and its constructor live in cellState.ts, the session-level posts in
// sessionState.ts; both re-exported so every existing import path still works. Card NAMING lives in
// toolCards.ts, re-exported for the same reason.
export { newTranslatorState, settleOpenTools, CRASHED_TOOL_NOTE, INTERRUPTED_TOOL_NOTE, UNRESOLVED_TOOL_NOTE } from './sessionState';
export type { TranslatorState, WebviewPost } from './sessionState';
export { toolKind, toolTitle } from './toolCards';

/**
 * What a thinking block that produced no text says instead. Drawn either way, since the model did
 *  think and hiding that would be its own small lie — some models sign their reasoning without
 *  sharing the text of it.
 */
export const HIDDEN_THINKING_NOTE = 'Claude thought about this turn but did not share the text of its reasoning.';

function textOf(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
  }
  if (typeof block.content === 'string') return block.content;
  return '';
}

function blocksOf(ev: ClaudeEvent): Array<Record<string, unknown>> {
  const message = ev.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
}

/** stream_event — the streaming half: text and thinking deltas, and the START
 *  of a tool block (so the card appears the instant the model commits to it,
 *  before its arguments have finished streaming). */
function fromStreamEvent(ev: ClaudeEvent, st: TranslatorState): WebviewPost[] {
  const sessionId = st.sessionId;
  const inner = (ev.event ?? {}) as Record<string, unknown>;
  const kind = typeof inner.type === 'string' ? inner.type : '';
  const index = typeof inner.index === 'number' ? inner.index : -1;
  if (kind === 'message_start') {
    const msg = (inner.message ?? {}) as Record<string, unknown>;
    if (typeof msg.model === 'string') st.model = msg.model;
    return [];
  }
  if (kind === 'content_block_start') {
    const block = (inner.content_block ?? {}) as Record<string, unknown>;
    // A thinking block is TRACKED, not drawn: the row opens on its first
    // non-empty delta, and if none ever comes the stop below says so.
    if (block.type === 'thinking') { st.openThinking.set(index, 0); return []; }
    if (block.type !== 'tool_use') return [];
    const id = typeof block.id === 'string' ? block.id : '';
    const name = typeof block.name === 'string' ? block.name : '';
    if (!id) return [];
    st.openToolBlocks.set(index, id);
    st.toolTitles.set(id, name);
    st.openTools.add(id);
    return [{ type: 'toolCall', sessionId, toolCallId: id, toolName: name, title: name, kind: toolKind(name), status: 'in_progress' }];
  }
  if (kind === 'content_block_delta') {
    const delta = (inner.delta ?? {}) as Record<string, unknown>;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ type: 'agentText', text: delta.text, sessionId }];
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      // An empty delta opens nothing: `content_block_start` for a thinking block carries `thinking:
      // ""`, and an empty delta used to open a "Thought process" expando with no text in it.
      if (!delta.thinking) return [];
      st.openThinking.set(index, (st.openThinking.get(index) ?? 0) + delta.thinking.length);
      return [{ type: 'agentThought', text: delta.thinking, sessionId }];
    }
    // input_json_delta (args arrive whole on the `assistant` event) and
    // signature_delta (no user-visible content) are deliberately silent.
    return [];
  }
  if (kind === 'content_block_stop') {
    st.openToolBlocks.delete(index);
    const thoughtChars = st.openThinking.get(index);
    if (thoughtChars === undefined) return [];
    st.openThinking.delete(index);
    return thoughtChars > 0 ? [] : [{ type: 'agentThought', text: HIDDEN_THINKING_NOTE, sessionId }];
  }
  return [];
}

/** `assistant` — one COMPLETED content block, re-sent whole. Text and thinking
 *  already streamed, so only tool_use blocks produce anything: the card's real
 *  arguments, and the todo strip for TodoWrite. */
function fromAssistant(ev: ClaudeEvent, st: TranslatorState, now: number): WebviewPost[] {
  const sessionId = st.sessionId;
  const posts: WebviewPost[] = [];
  for (const block of blocksOf(ev)) {
    if (block.type !== 'tool_use') continue;
    const id = typeof block.id === 'string' ? block.id : '';
    const name = typeof block.name === 'string' ? block.name : (st.toolTitles.get(id) ?? '');
    const input = (block.input && typeof block.input === 'object' && !Array.isArray(block.input))
      ? (block.input as Record<string, unknown>) : {};
    if (!id) continue;
    if (name === 'TodoWrite') {
      const todos = todosFromUpdate({ rawInput: { todos: (input as { todos?: unknown }).todos } });
      if (todos) posts.push({ type: 'todoUpdate', sessionId, source: 'claude-code', todos });
    }
    // The SAME strip, from the tools that replaced TodoWrite on 2.1.198. One
    // task per call, so it is a fold rather than a snapshot — taskStrip.ts.
    posts.push(...taskUsePosts(st, id, name, input));
    // A block whose `content_block_start` was never seen (a stream that dropped
    // it, or a non-streaming build) still opens a card here, so it has to join
    // the open set here too — otherwise a turn-close cannot settle it.
    st.openTools.add(id);
    if (!st.toolTitles.has(id)) st.toolTitles.set(id, name);
    posts.push({
      type: 'toolResult', sessionId, toolCallId: id, toolName: name,
      title: toolTitle(name, input), status: 'in_progress', content: '', rawInput: input,
      // A `Task` opens its tally here — the frame with the child's brief on it.
      ...openAgent(st, id, name, input, now),
    });
  }
  return posts;
}

/** `user` — the CLI echoing a tool RESULT back into the conversation. This is
 *  the only place a tool card learns it finished (or was denied). */
function fromUser(ev: ClaudeEvent, st: TranslatorState, now: number): WebviewPost[] {
  const posts: WebviewPost[] = [];
  for (const block of blocksOf(ev)) {
    if (block.type !== 'tool_result') continue;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    if (!id) continue;
    // This card is resolved. Anything left in the set when the turn closes is
    // a card the harness never reported an outcome for.
    st.openTools.delete(id);
    const content = textOf(block);
    // The create result is the ONLY frame carrying the CLI's own task id, which
    // is what every later TaskUpdate addresses — and an ERRORED one means the
    // task was never created, so its provisional row goes. taskStrip.ts.
    posts.push(...taskResultPosts(st, id, content, block.is_error === true));
    posts.push({
      type: 'toolResult', sessionId: st.sessionId, toolCallId: id,
      status: block.is_error === true ? 'failed' : 'completed',
      content,
      ...(st.toolTitles.has(id) ? { toolName: st.toolTitles.get(id) } : {}),
      // A `Task`'s result IS its sub-agent coming home — the tally closes here.
      // An `Agent`'s is only the launch, which is why the text goes with it.
      ...closeAgent(st, id, now, content),
    });
  }
  return posts;
}

/** `result` — the turn is over. Closes the transcript's in-flight state and
 *  feeds both meters (context fill, spend) from the CLI's own accounting. */
function fromResult(ev: ClaudeEvent, st: TranslatorState): WebviewPost[] {
  const usage = resultUsage(ev);
  if (!usage) return [];
  const sessionId = st.sessionId;
  const posts: WebviewPost[] = [];
  if (usage.isError) {
    // `errors[]` FIRST: the error half of the CLI's result union carries no `result` string at all,
    // so reading only `result` threw away the one sentence that said what went wrong.
    const detail = resultErrorText(ev) || usage.stopReason;
    posts.push({
      type: 'error', sessionId,
      // A plan refusal is not a failure to debug. Its reset time comes from the session's own last
      // `rate_limit_event`, which is the only frame that carries one.
      message: resultPlanLimited(ev)
        ? `Claude Code refused this turn: your plan's limit is spent.${resetClause(st.pill?.resetsAt ?? 0)} The CLI said: ${detail}`
        : `Claude Code ended the turn: ${detail}`,
    });
  }
  // Every still-open card is settled before the turn closes: a `result` can arrive with tool blocks
  // open (an aborted tool, a missing echo), and leaving those spinning for the rest of the session
  // was the defect this whole file exists to avoid.
  posts.push(...settleOpenTools(st, UNRESOLVED_TOOL_NOTE));
  st.turns += 1;
  posts.push({
    type: 'contextUpdate', sessionId,
    tokensUsed: usage.tokensUsed,
    contextUsed: usage.tokensUsed,
    contextTotal: usage.contextWindow,
    contextWindow: usage.contextWindow,
    // This cell's completed turns. The composer's own counter is fed by an engine-side poll a bound
    // cell never runs, so a passthrough chat sat on "0 turns" no matter how long it ran.
    turns: st.turns,
  });
  // THE SUBSCRIPTION GATE. `total_cost_usd` is real money only when an API key
  // paid for the turn; on a plan it is the API-equivalent list price of
  // something the month already covered, and posting it paints a bill in the
  // composer. The headroom pill takes that slot instead (sessionFacts.ts).
  if (usage.costUsd > 0 && !st.subscription) {
    posts.push({ type: 'usageUpdate', sessionId, used: usage.tokensUsed, size: usage.contextWindow, cost: { amount: usage.costUsd } });
  }
  // `tokens` rides the turn-closing post because that is what the mirror keys on; without it every
  // passthrough turn read as zero size in the Labyrinth. A measurement, not a price — the cost gate
  // above is unchanged.
  posts.push({ type: 'turnDone', stopReason: usage.stopReason, sessionId, tokens: usage.tokens });
  return posts;
}

/**
 * One CLI event → zero or more webview posts. Unknown event types return [].
 *
 * Sub-agent events (non-empty `parent_tool_use_id`) are dropped before anything else, since
 *  rendering them would interleave two conversations and double-count the context meter. They are
 *  counted on the way out by subagentBeat.ts.
 */
export function translate(ev: ClaudeEvent, st: TranslatorState, now: number = Date.now()): WebviewPost[] {
  const adopted = sessionIdOf(ev);
  if (adopted) st.providerSessionId = adopted;
  if (isSubagentEvent(ev)) return beatPosts(ev, st, now);
  switch (ev.type) {
    case 'stream_event': return fromStreamEvent(ev, st);
    case 'assistant': return fromAssistant(ev, st, now);
    case 'user': return fromUser(ev, st, now);
    // A `system` frame is almost always about the SESSION (sessionState.ts).
    // The task_* family is the exception: it is how a BACKGROUND agent reports
    // home, which is the only settle path the CLI actually sends us.
    case 'system': return [...taskSystemPosts(ev, st, now), ...systemPosts(ev, st)];
    case 'control_response': return controlResponsePosts(ev, st);
    case 'result': return fromResult(ev, st);
    case 'rate_limit_event': return rateLimitPosts(ev, st);
    default: return [];
  }
}
