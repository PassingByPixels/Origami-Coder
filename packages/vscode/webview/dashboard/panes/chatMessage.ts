// chatMessage.ts: the shape of one row in a chat transcript.
//
// ChatPane.svelte and ChatTranscript.svelte both render these rows, so the
// shape is one declaration, not two copies drifting apart. The tool-card
// slice lives in toolCardFields.ts. This leaf may not import from src/
// (rootDir: "webview"), so TurnVerdict etc. come from webview-side leaves.

import type { TurnVerdict } from './turnVerdict';
import type { SubagentSpan } from './subagentTiming';
import type { ToolCardFields } from './toolCardFields';
import type { StreamDropRow } from './streamDropNotice';
import type { EngineNotice } from './engineNotice';

/** `SubagentSpan` carries the engine's own start/end for a `task` card. */
export interface Message extends SubagentSpan, ToolCardFields {
  id: number;
  kind: 'user' | 'agent' | 'system' | 'tool' | 'error' | 'verdict' | 'todoSummary' | 'thought' | 'compacted' | 'peer' | 'secondOpinion' | 'streamDrop' | 'engine';
  label: string;
  text: string;
  /** kind === 'streamDrop' — the dropped-stream alert card (SystemAlertRow).
   *  Data, never prose: the engine names the facts, streamDropNotice.ts holds
   *  the rules, and nothing anywhere matches the old text form. */
  streamDrop?: StreamDropRow;
  /** kind === 'engine' — the chat's engine is starting, failed or stopped (engineNotice.ts). */
  engine?: EngineNotice;
  /** kind === 'peer' — where a reply goes; sender is `label` (PeerMessageRow). */
  peerReplyTo?: string;
  /** kind === 'peer', sender is a flock contact rather than another of this
   *  owner's sessions. Mirrors src/acpPeerMeta.ts FlockOrigin. */
  peerFlock?: { contact: string; thread: string; kind: string; icon?: string };
  /** kind === 'peer', sender is one of this chat's own sub-agents asking a
   *  question. Mirrors src/acpPeerMeta.ts SubagentOrigin. */
  peerSubagent?: { label: string; requestID: string; sessionID: string };
  /** Engine assistant-message id; the revert anchor for "rewind to here". Agent msgs only. */
  engineMsgId?: string;
  /** kind === 'verdict' — the honest per-turn terminal verdict. */
  verdict?: TurnVerdict;
  /** kind === 'secondOpinion': which model reviews, and how far it's got. */
  secondOpinion?: SecondOpinionInfo;
  /** kind === 'todoSummary': the task-list snapshot left inline at turn end. */
  summaryTodos?: TodoInfo[];
  /** kind === 'compacted': true while streaming, false once compaction completes. */
  compacting?: boolean;
  images?: string[];     // data URLs for pasted images
  timestamp?: number;    // epoch ms
  /** Session-cumulative token count when this message arrived, set on the
   *  last agent message per turn; MessageRow shows it as a hover tooltip. */
  tokensAtTurn?: number;
  /** Work + context spend for this turn, stamped at `turnDone`. `tokensThisTurn`
   *  is the delta since the previous turn; `ctxPctAtTurn` is context fullness. */
  tokensThisTurn?: number;
  ctxPctAtTurn?: number;
}

/** One second-opinion card's own state. Lives on the row rather than the
 *  session: a chat may hold several reviews, each answering for itself. */
export interface SecondOpinionInfo {
  /** The host's correlation id, routes an answer to the card waiting for it. */
  id: string;
  /** `<provider>/<id>`. What "Hand chat to …" hands the chat to. */
  modelId: string;
  /** The reviewing model's display name, as the picker showed it. */
  modelLabel: string;
  state: 'pending' | 'ok' | 'error';
  /** state === 'error' — the engine's or host's own wording, never a paraphrase. */
  error?: string;
  /** How this review was produced: engine reviewers read real file diffs; a
   *  Claude Code reviewer reads the visible transcript with no diffs. */
  attribution?: string;
  /** What the user did with the review, kept on the message (not component
   *  state) so a re-render can't resurrect the action buttons. */
  resolution?: 'handed' | 'dismissed';
}

export interface TodoInfo {
  id: number;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Wire nesting level; the pane never reads it, only forwards it to TodoStrip. */
  depth?: number;
}
