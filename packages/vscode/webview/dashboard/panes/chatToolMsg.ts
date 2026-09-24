// chatToolMsg.ts — the transcript's TOOL-message merge rules: 'toolCall'
// appends the card message, 'toolResult' merges the update into it by
// toolCallId (or falls back to a detached result row). Pure array-in /
// array-out so the rules unit-test without a DOM.
//
// Per-field SHAPING of the wire's untyped payloads lives in chatToolMeta.ts;
// the collapsed row's LABEL rules live in chatToolTitle.ts.

import { browserOut, isShellName, readLines, shellIn, shellOut, str, toolImages } from './chatToolMeta';
import { readImage, type ToolReadImage } from './toolReadImage';
import type { ToolShell, ToolLines, ToolBrowser } from './chatToolMeta';
import { toolCardTitle, updatedToolTitle } from './chatToolTitle';
import { mergeTaskRiders } from './taskRiders';
import { passthroughBeat, type PassthroughCard } from './subagentPassthrough';
import { taskIdentity } from './subagentLabel';
import { spawnStamp, type SubagentSpan } from './subagentTiming';

export type { ToolShell, ToolLines, ToolBrowser } from './chatToolMeta';
export type { ToolReadImage } from './toolReadImage';

/** The tool-related slice of ChatPane's Message. Everything optional there is
 *  optional here; the four required fields match. `SubagentSpan` adds the
 *  engine's own start/end for a `task` card (subagentTiming.ts). */
export interface ToolCardMsg extends SubagentSpan, PassthroughCard {
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
  /** `provider/model` the sub-agent was routed to; often differs from the parent's model. */
  taskModel?: string;
  /** How a DETACHED sub-agent ended, from the engine's terminal marker; set by the pane. */
  taskDone?: 'completed' | 'error';
  /** WHO the sub-agent is — the model's own brief and the agent type it asked
   *  for, read off this call's `rawInput` (subagentLabel.ts). */
  taskDescription?: string;
  taskAgentType?: string;
  toolShell?: ToolShell;
  toolLines?: ToolLines;
  /** Screenshots the tool returned, as data: URIs — the `browser` tool only. */
  toolImages?: string[];
  /** The `browser` tool's ok/action/url verdict — the only honest status for the call. */
  toolBrowser?: ToolBrowser;
  /** The image file a `read` card shows, and this surface's src for it. */
  toolReadImage?: ToolReadImage;
}

/** The webview's per-card result budget. Bash gets more headroom since its
 *  output is already tail-truncated by the engine. A chart gets the same
 *  headroom because its output is the SPEC the card re-renders — a cut
 *  turns it into JSON that no longer parses, not just a shorter chart. */
const RESULT_CAP = 2000;
const BASH_RESULT_CAP = 8000;
const CHART_RESULT_CAP = 8000;

function resultCap(toolName: unknown): number {
  if (isShellName(toolName)) return BASH_RESULT_CAP;
  if (toolName === 'chart') return CHART_RESULT_CAP;
  return RESULT_CAP;
}

/** 'toolCall': append the card. The `as M` cast is deliberate: every field
 *  of the caller's message type beyond ToolCardMsg is optional. */
export function applyToolCall<M extends ToolCardMsg>(
  messages: M[],
  msg: Record<string, unknown>,
  id: number,
): M[] {
  const taskSessionId = str(msg.taskSessionId);
  const title = toolCardTitle(msg.toolName, msg.title);
  const now = Date.now();
  const card: ToolCardMsg = {
    id,
    kind: 'tool',
    label: title,
    text: title,
    toolCallId: str(msg.toolCallId),
    toolKind: str(msg.kind) ?? 'other',
    toolName: str(msg.toolName) ?? '',
    toolStatus: str(msg.status) ?? 'in_progress',
    // Stamped like every message, from ONE clock read the spawn stamp below shares —
    // two Date.now() calls for one card can straddle a millisecond.
    timestamp: now,
    ...spawnStamp(str(msg.toolName), now),
    toolPath: str(msg.path),
    taskSessionId,
    taskResumed: !!taskSessionId && messages.some((mm) => mm.taskSessionId === taskSessionId),
    taskBackground: msg.taskBackground === true ? true : undefined,
    taskModel: str(msg.taskModel),
    ...taskIdentity(msg.toolName, msg.rawInput),
    toolShell: shellIn(msg.toolName, msg.rawInput),
  };
  return [...messages, card as M];
}

/** 'toolResult': merge the update into its card by toolCallId, or fall back
 *  to a detached row. Returns a NEW array — the caller assigns it to trigger reactivity. */
export function applyToolResult<M extends ToolCardMsg>(
  messages: M[],
  msg: Record<string, unknown>,
  fallbackId: number,
): M[] {
  const tcId = str(msg.toolCallId);
  const existing = tcId ? messages.find((m) => m.toolCallId === tcId) : undefined;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!existing) {
    // replay-toolcards: the engine stamps toolName on this update too, so
    // an orphaned result still routes to the right card, not GenericCard.
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
  // Same write-if-present rule the riders follow: the RUNNING frame carries the
  // task's input too, and a later frame that carries none must not blank a name
  // the pending one already knew.
  Object.assign(existing, taskIdentity(existing.toolName, msg.rawInput));
  const title = updatedToolTitle(existing.toolName, msg.title, input);
  if (title) { existing.label = title; existing.text = title; }
  const path = str(msg.path); if (path) existing.toolPath = path;
  // Session id, background flag, model and the terminal marker all arrive
  // on an update; taskRiders.ts owns those write-if-present rules.
  mergeTaskRiders(messages, existing, msg);
  // The PASSTHROUGH heartbeat is kept out of taskRiders.ts: a Claude
  // sub-agent never has an engine session to learn riders from.
  const beat = passthroughBeat(msg.taskBeat); if (beat) existing.taskBeat = beat;
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
  // Same rule as below: a later update with no metadata must not erase the verdict.
  const browser = browserOut(existing.toolName, msg.rawOutputMeta);
  if (browser) existing.toolBrowser = browser;
  // A later update with no image must not erase an earlier screenshot (sent once).
  const images = toolImages(msg.images);
  if (images) existing.toolImages = images;
  // Same write-if-present rule: a later update with no rider must not blank the picture.
  const picture = readImage(msg.readImage);
  if (picture) existing.toolReadImage = picture;
  return [...messages];
}
