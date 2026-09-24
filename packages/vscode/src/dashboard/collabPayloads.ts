// The shapes a collab host leaf answers a webview in, extracted out of collabData.ts once it
// reached its line cap. Types only — nothing runs, nothing imports vscode.
// Rule: a refusal arrives as an `error` FIELD, never a rejected promise, so a caller that forgot to
// catch does not turn a dead engine into an unhandled rejection.
import type {
  CollabAgentInfo,
  CollabAgentStatus,
  CollabMessage,
  CollabParticipant,
  CollabPostResult,
  CollabStateResult,
  CollabSummary,
} from '../acpExtTypes';

export interface CollabAgentsPayload {
  agents: CollabAgentInfo[];
  error?: string;
}

export interface CollabListPayload {
  collabs: CollabSummary[];
  error?: string;
}

export interface CollabCreatePayload {
  /** Null when the create failed — `error` then says why. */
  collab: CollabSummary | null;
  error?: string;
}

export interface CollabPostPayload {
  collabId: string;
  /** The seq the message landed at, or null when it never landed. */
  seq: number | null;
  /** The engine's `no-lead`, carried through rather than dropped: a message
   *  that landed and woke NOBODY is not an error (nothing failed) and not a
   *  success worth silence either. Taken off CollabPostResult so the extension
   *  cannot drift from the wire contract on which notices exist. */
  notice?: CollabPostResult['notice'];
  error?: string;
}

// The M4 board fields ride the SAME reply — optional, absent wholesale on an older engine, so they come off CollabStateResult rather than being re-declared.
export interface CollabStatePayload extends Pick<CollabStateResult, 'lead' | 'objective' | 'tasks' | 'costTotals' | 'hopState'> {
  collabId: string;
  /** Echoed back so a webview can tell a full snapshot (0) from an increment — the host is
   *  stateless and `post` fans out to every view, so without this a pane can't tell whether
   *  `messages` replaces its stream or appends. */
  sinceSeq: number;
  collab: CollabSummary | null;
  participants: CollabParticipant[];
  messages: CollabMessage[];
  /** Wave 1's per-agent retained `activity` rides HERE, on the status itself — collabData passes
   *  the array through whole, so a new optional field needs no second declaration. */
  agents: CollabAgentStatus[];
  suspended: boolean;
  /**
   * W3-L1: does this room need the user right now — collabAttention.ts's `collabNeedsUser` verdict,
   *  carried on the payload because the Collabs overview pane is a webview module that cannot
   *  import a src/ leaf.
   * Always a boolean, never absent: a refusal answers false, so no surface reads a dead engine as a
   *  summons.
   */
  needsUser: boolean;
  error?: string;
}

/** The shape EVERY collab mutation answers in: set-cap and the four M2 methods
 *  all reply `{ok:true}` and nothing else, so a refusal can only arrive as an
 *  `error` FIELD here — never as a rejected promise a caller might not catch. */
export interface CollabOkPayload {
  collabId: string;
  ok: boolean;
  error?: string;
}
export type CollabSetCapPayload = CollabOkPayload;
