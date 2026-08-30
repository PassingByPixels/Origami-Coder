// chatMessage.ts — the shape of ONE row in a chat transcript.
//
// Lifted VERBATIM out of ChatPane.svelte (interface Message / interface
// TodoInfo, which lived in its <script> and so could not be named by anyone
// else) when the per-message rendering loop was extracted into
// ChatTranscript.svelte. Two components now render the same rows, so the shape
// they agree on has to be ONE declaration, not two copies drifting apart — the
// failure mode of a mirrored type is a field added on one side only, and every
// row that carries it renders blank on the other.
//
// A .ts leaf under webview/ deliberately: it may not import from src/ (TS6059,
// rootDir: "webview"), and it does not — TurnVerdict and the tool-fact types
// both come from webview-side leaves.

import type { TurnVerdict } from './turnVerdict';
import type { ToolShell, ToolLines, ToolBrowser } from './chatToolMsg';
import type { SubagentSpan } from './subagentTiming';

/** `SubagentSpan` carries the engine's own start/end for a `task` card — the
 *  only run times that survive a reload (subagentTiming.ts). */
export interface Message extends SubagentSpan {
  id: number;
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error' | 'verdict' | 'todoSummary' | 'thought' | 'compacted' | 'peer';
  label: string;
  text: string;
  /** kind === 'peer' — where a reply goes; sender is `label` (PeerMessageRow). */
  peerReplyTo?: string;
  /** Engine assistant-message id (from `agent_message_chunk`). The revert
   *  anchor for a "rewind to here" control — reverting to it rolls the working
   *  tree + transcript back to before this exchange's turn. Agent msgs only. */
  engineMsgId?: string;
  /** For kind === 'verdict' — the honest per-turn terminal verdict. */
  verdict?: TurnVerdict;
  /** For kind === 'todoSummary' — the snapshot of the task list left
   *  inline after the slide-in overlay closes at turn end. */
  summaryTodos?: TodoInfo[];
  /** For kind === 'compacted' — true while the /compact turn is still
   *  streaming (renders "Compacting context…" + a pulsing crane); flipped
   *  false at turnDone (renders the settled "Compaction Completed"). */
  compacting?: boolean;
  images?: string[];     // data URLs for pasted images
  timestamp?: number;    // epoch ms
  // Tool card metadata (only for kind === 'tool')
  toolCallId?: string;
  toolKind?: string;
  /**
   * Pillar 2 dashboard upgrade (2026-05-22) — actual tool name from
   * runtime (`grep`, `read_file`, `bash`, `task`, etc.). Used by
   * ToolCard to dispatch to per-tool specialised renderers. Optional
   * because pre-Pillar-2 sessions / non-Origami ACP servers may not
   * supply it; ToolCard falls back to the generic renderer in that
   * case.
   */
  toolName?: string;
  toolStatus?: string;
  toolResult?: string;
  /** File path the tool acted on (read/write/edit), from ACP locations —
   *  shown on the card so "write" says WHERE it wrote. */
  toolPath?: string;
  /**
   * Structured before/after diff for edit tools, threaded from the
   * ACP `{type:'diff'}` content block. When present, ToolCard's
   * EditCard renders a real line diff instead of a `<pre>` of the
   * edit summary. Undefined for non-edit tools.
   */
  toolDiff?: { path: string; oldText: string; newText: string };
  /**
   * For a `task` call: the sub-agent session it spawned
   * (`_meta.origami_task_session`). The join key that routes a forwarded
   * `subagentChunk` to THIS card rather than the parent's transcript.
   */
  taskSessionId?: string;
  /** Shell (bash) facts off the wire — command/cwd/timeout in, exit/
   *  truncation out. Shaped by chatToolMsg.ts; rendered by BashCard. */
  toolShell?: ToolShell;
  /** Actual clamped line range a read tool returned. Shaped by
   *  chatToolMsg.ts; rendered by ToolCard as a suffix after the path. */
  toolLines?: ToolLines;
  /** `browser` only: screenshots as data: URIs, and the tool's own ok verdict. */
  toolImages?: string[]; toolBrowser?: ToolBrowser;
  /** True when this chat ALREADY showed a card for the same task session — i.e.
   *  the model RESUMED a sub-agent rather than spawning a fresh one. Resumed and
   *  brand-new spawns were visually identical, which is exactly how a "multi-turn"
   *  review silently became two different agents without anyone noticing. */
  taskResumed?: boolean;
  /** Detached child (`_meta.origami_task_background`) + the model it was routed
   *  to + how it ENDED, once the engine's terminal marker lands. A background
   *  card completes at SPAWN, so only `taskDone` retires its drawer row. */
  taskBackground?: boolean; taskModel?: string; taskDone?: 'completed' | 'error';
  /**
   * Live output streamed by that sub-agent while it works — the child's prose
   * plus one line per tool it starts. Capped (see SUBAGENT_STREAM_CAP): a
   * 10-agent fan-out streaming unbounded into the webview is how you turn a
   * transcript into a memory leak.
   */
  taskStream?: string;
  /**
   * Pillar 3 dashboard upgrade (2026-05-22) — session-cumulative
   * token count at the moment this message arrived. Set on the
   * last agent message of each completed turn (when `turnDone`
   * fires) using whatever `contextUpdate.tokensUsed` last
   * reported. MessageRow renders a hover tooltip showing the
   * value so the user can scrub history and see when the
   * conversation got expensive. Optional — empty for messages
   * before this slice landed.
   */
  tokensAtTurn?: number;
  /**
   * B9 (2026-06-06) — work + context spend for THIS turn, stamped on
   * the last agent message when `turnDone` fires. `tokensThisTurn` is
   * the cumulative-token delta since the previous turn; `ctxPctAtTurn`
   * is how full the context window was at turn end. Both from the
   * `contextUpdate` event — undefined when the backend didn't report.
   */
  tokensThisTurn?: number;
  ctxPctAtTurn?: number;
}

export interface TodoInfo {
  id: number;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Nesting level as it arrived on the wire; absent means top level. Optional
   *  so a todoSummary recorded before nesting existed still type-checks. The
   *  pane never reads it — it carries the field to TodoStrip, which normalises
   *  the whole list and draws it. */
  depth?: number;
}
