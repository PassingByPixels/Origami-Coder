// toolCardFields.ts — the tool-card slice of a transcript row's shape.
//
// Split out of chatMessage.ts on that file's own cap. `Message extends
// ToolCardFields`, so every consumer keeps the flat shape; this file only
// names the slice. Types only, no runtime.
//
// A .ts leaf under webview/ deliberately: it may not import from src/, and
// doesn't — the tool-fact types come from chatToolMsg.ts, a webview-side leaf.

import type { ToolShell, ToolLines, ToolBrowser, ToolReadImage } from './chatToolMsg';
import type { PassthroughCard } from './subagentPassthrough';
import type { SubagentTokens } from './subagentTokens';
import type { SubagentThinking } from './subagentThinking';

/** Tool card metadata (only for kind === 'tool'), moved verbatim from
 *  chatMessage.ts. `PassthroughCard` adds `taskBeat`: the sub-agent tally a
 *  Claude passthrough `Task` card carries in place of a child session id,
 *  since that path spawns no engine session at all. Extended rather than
 *  re-declared, since a field named in two places is a field that drifts. */
export interface ToolCardFields extends PassthroughCard {
  toolCallId?: string;
  toolKind?: string;
  /** Actual tool name from runtime (`grep`, `read_file`, `bash`, `task`,
   *  etc.), used by ToolCard to dispatch to per-tool renderers. Optional
   *  since older sessions / non-Origami ACP servers may not supply it. */
  toolName?: string;
  toolStatus?: string;
  toolResult?: string;
  /** File path the tool acted on, from ACP locations, shown so "write" says
   *  where it wrote. */
  toolPath?: string;
  /** Structured before/after diff for edit tools, threaded from the ACP
   *  `{type:'diff'}` content block. When present, ToolCard's EditCard
   *  renders a real line diff instead of a `<pre>` of the edit summary. */
  toolDiff?: { path: string; oldText: string; newText: string };
  /** For a `task` call: the sub-agent session it spawned. The join key that
   *  routes a forwarded `subagentChunk` to this card. */
  taskSessionId?: string;
  /** Shell (bash) facts off the wire — command/cwd/timeout in, exit/
   *  truncation out. Shaped by chatToolMsg.ts; rendered by BashCard. */
  toolShell?: ToolShell;
  /** Actual clamped line range a read tool returned. Shaped by
   *  chatToolMsg.ts; rendered by ToolCard as a suffix after the path. */
  toolLines?: ToolLines;
  /** `browser` only: screenshots as data: URIs, and the tool's own ok verdict. */
  toolImages?: string[]; toolBrowser?: ToolBrowser;
  /** `read` of an image file: the FILE the model read, plus this surface's own
   *  `<img src>` for it. Never base64 — src/dashboard/toolImageCard.ts. */
  toolReadImage?: ToolReadImage;
  /** True when this chat already showed a card for the same task session,
   *  i.e. the model resumed a sub-agent rather than spawning a fresh one. */
  taskResumed?: boolean;
  /** Detached child + the model it was routed to + how it ended, once the
   *  engine's terminal marker lands. A background card completes at spawn,
   *  so only `taskDone` retires its drawer row. */
  taskBackground?: boolean; taskModel?: string; taskDone?: 'completed' | 'error';
  /** WHO the sub-agent is: the model's own 3-5 word brief and the agent type it
   *  asked for, both read off the `task` call's input (subagentLabel.ts). Every
   *  surface names the agent from these; the card's own header is `task`. */
  taskDescription?: string; taskAgentType?: string;
  /** The child's token spend so far. Re-sent per child step, so the LATEST
   *  wins (taskRiders.ts) — unlike the run span, which is write-once. */
  taskTokens?: SubagentTokens;
  /** Live output streamed by that sub-agent while it works. Capped (see
   *  SUBAGENT_STREAM_CAP), or a fan-out streaming unbounded into the
   *  webview turns a transcript into a memory leak. */
  taskStream?: string;
  /** The child's CURRENT run of reasoning (subagentThinking.ts), cleared by the
   *  next prose or tool line. Never folded into `taskStream`: that string is the
   *  row's activity tail and this card's reply text. */
  taskThinking?: SubagentThinking;
}
