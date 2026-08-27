// chatToolMsg.ts — the transcript's TOOL-message merge rules, extracted from
// ChatPane's message router when it sat one line under its architecture cap:
// 'toolCall' appends the card message, 'toolResult' merges the update into it
// by toolCallId (or falls back to a detached result row). Pure array-in /
// array-out so the rules unit-test without a DOM; the caller owns the side
// effects around them (scroll, closing the open agent-text message).
//
// The per-field SHAPING of the wire's untyped payloads lives in chatToolMeta.ts
// (re-exported here, so every card keeps its existing import); the collapsed
// row's LABEL rules — the "Edit: " prefix, the one-line guarantee, adopt vs
// freeze — live in chatToolTitle.ts. Both were split off at this file's cap.

import { browserOut, isShellName, readLines, shellIn, shellOut, str, toolImages } from './chatToolMeta';
import type { ToolShell, ToolLines, ToolBrowser } from './chatToolMeta';
import { toolCardTitle, updatedToolTitle } from './chatToolTitle';
import { mergeTaskRiders } from './taskRiders';
import type { SubagentSpan } from './subagentTiming';

export type { ToolShell, ToolLines, ToolBrowser } from './chatToolMeta';

/** The tool-related slice of ChatPane's Message. Everything optional there is
 *  optional here; the four required fields match. `SubagentSpan` adds the
 *  engine's own start/end for a `task` card (subagentTiming.ts). */
export interface ToolCardMsg extends SubagentSpan {
  id: number;
  kind: string;
  label: string;
  text: string;
  timestamp?: number;
  toolCallId?: string;
  toolKind?: string;
  toolName?: string;
  toolStatus?: string;
  toolResult?: string;
  toolPath?: string;
  toolDiff?: { path: string; oldText: string; newText: string };
  taskSessionId?: string;
  taskResumed?: boolean;
  /** The sub-agent runs DETACHED: this card completing means "spawned", not
   *  "finished". The drawer keeps such a row until its terminal marker. */
  taskBackground?: boolean;
  /** `provider/model` the sub-agent was routed to — a flock binding or the
   *  chat's sub-agent override routinely differs from the parent's model. */
  taskModel?: string;
  /** How a DETACHED sub-agent ended, from the engine's terminal marker (the
   *  card's own status settled at spawn). Set by the pane, not by these rules. */
  taskDone?: 'completed' | 'error';
  toolShell?: ToolShell;
  toolLines?: ToolLines;
  /** Screenshots the tool returned, as data: URIs — the `browser` tool only. */
  toolImages?: string[];
  /** The `browser` tool's own ok/action/url verdict — the only honest status
   *  for a call the engine always completes. */
  toolBrowser?: ToolBrowser;
}

/** The webview's per-card result budget. Bash gets more headroom: its output
 *  IS the payload (the engine already tail-truncated it to sane limits), and
 *  25 lines of a build log answers nothing. A chart gets the same headroom for
 *  a stricter reason: its output is the SPEC the card re-renders, so a cut of
 *  it is not a shortened chart, it is JSON that no longer parses and therefore
 *  no chart at all — a year of daily points is ~5.7k characters. */
const RESULT_CAP = 2000;
const BASH_RESULT_CAP = 8000;
const CHART_RESULT_CAP = 8000;

function resultCap(toolName: unknown): number {
  if (isShellName(toolName)) return BASH_RESULT_CAP;
  if (toolName === 'chart') return CHART_RESULT_CAP;
  return RESULT_CAP;
}

/** 'toolCall': append the card. Mirrors the old case body verbatim, plus the
 *  toolShell stamp. The `as M` cast is the one deliberate unsoundness: every
 *  field of the caller's message type beyond ToolCardMsg is optional. */
export function applyToolCall<M extends ToolCardMsg>(
  messages: M[],
  msg: Record<string, unknown>,
  id: number,
): M[] {
  const taskSessionId = str(msg.taskSessionId);
  const title = toolCardTitle(msg.toolName, msg.title);
  const card: ToolCardMsg = {
    id,
    kind: 'tool',
    label: title,
    text: title,
    toolCallId: str(msg.toolCallId),
    toolKind: str(msg.kind) ?? 'other',
    toolName: str(msg.toolName) ?? '',
    toolStatus: str(msg.status) ?? 'in_progress',
    // Stamped like every other message: for a `task` card this is what the
    // sub-agent drawer ages a still-running child from.
    timestamp: Date.now(),
    toolPath: str(msg.path),
    taskSessionId,
    taskResumed: !!taskSessionId && messages.some((mm) => mm.taskSessionId === taskSessionId),
    taskBackground: msg.taskBackground === true ? true : undefined,
    taskModel: str(msg.taskModel),
    toolShell: shellIn(msg.toolName, msg.rawInput),
  };
  return [...messages, card as M];
}

/** 'toolResult': merge the update into its card by toolCallId; with no match,
 *  fall back to a detached result row (a result that beat its call). Returns a
 *  NEW array either way — the caller assigns it to trigger reactivity. */
export function applyToolResult<M extends ToolCardMsg>(
  messages: M[],
  msg: Record<string, unknown>,
  fallbackId: number,
): M[] {
  const tcId = str(msg.toolCallId);
  const existing = tcId ? messages.find((m) => m.toolCallId === tcId) : undefined;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!existing) {
    // replay-toolcards: the engine stamps toolName on this update too, so an
    // orphaned result (beat its call) still routes to the right card instead
    // of always landing on GenericCard.
    const row: ToolCardMsg = {
      id: fallbackId,
      kind: 'tool',
      label: 'result',
      text: content.slice(0, 500),
      toolStatus: 'completed',
      toolResult: content.slice(0, RESULT_CAP),
      toolName: str(msg.toolName),
    };
    return [...messages, row as M];
  }
  existing.toolStatus = str(msg.status) ?? 'completed';
  existing.toolResult = content.slice(0, resultCap(existing.toolName));
  // A LATER update can carry the rider too (replay-toolcards) — apply it, but
  // never overwrite an already-known name with an absent/empty one.
  const toolName = str(msg.toolName);
  if (toolName) existing.toolName = toolName;
  const input = shellIn(existing.toolName, msg.rawInput); if (input) existing.toolShell = { ...existing.toolShell, ...input };
  const title = updatedToolTitle(existing.toolName, msg.title, input);
  if (title) { existing.label = title; existing.text = title; }
  const path = str(msg.path); if (path) existing.toolPath = path;
  // Session id, background flag, model and the terminal marker all arrive on an
  // UPDATE rather than the call, and all are write-if-present. taskRiders.ts
  // owns those rules — the reload replay runs through them too.
  mergeTaskRiders(messages, existing, msg);
  const d = msg.diff as { path?: unknown; oldText?: unknown; newText?: unknown } | undefined;
  if (d && typeof d === 'object') {
    existing.toolDiff = {
      path: String(d.path ?? ''),
      oldText: String(d.oldText ?? ''),
      newText: String(d.newText ?? ''),
    };
  }
  const out = shellOut(msg.rawOutputMeta);
  if (out) {
    existing.toolShell = { ...existing.toolShell, ...out };
    if (out.state !== 'foreground' && out.jobId && out.exit === null && msg.status === 'completed') {
      existing.toolStatus = 'in_progress';
    }
  }
  const lines = readLines(msg.rawOutputMeta);
  if (lines) existing.toolLines = lines;
  // Same rule as the screenshot below: a later update with no metadata must not
  // erase the verdict an earlier one carried.
  const browser = browserOut(existing.toolName, msg.rawOutputMeta);
  if (browser) existing.toolBrowser = browser;
  // A later update carrying no image must not erase the screenshot an earlier
  // one delivered — the engine sends the image once, on the completed frame.
  const images = toolImages(msg.images);
  if (images) existing.toolImages = images;
  return [...messages];
}
