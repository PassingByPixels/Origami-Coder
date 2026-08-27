// The SHAPES a collab host leaf answers a webview in — extracted out of
// collabData.ts, which sat exactly on its 250-line cap with the `notice` field
// still to add. Types only: nothing here runs, nothing here imports `vscode`,
// and collabData.ts re-exports every name so no importer had to move.
//
// The rule every payload below follows, and the reason they are worth naming
// together: a refusal arrives as an `error` FIELD, never as a rejected promise.
// A caller that forgot to catch would otherwise turn a dead engine into an
// unhandled rejection somewhere far from the collab that caused it.
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
  /** Echoed back so a webview can tell a FULL snapshot (0) from an increment.
   *  The host is stateless — it cannot remember what it last sent whom — and
   *  `post` fans every reply out to EVERY view, so without this echo a pane
   *  cannot know whether an arriving `messages` array replaces its stream or
   *  appends to it. */
  sinceSeq: number;
  collab: CollabSummary | null;
  participants: CollabParticipant[];
  messages: CollabMessage[];
  /** Wave 1's per-agent retained `activity` rides HERE, on the status itself
   *  (acpExtTypes: CollabAgentStatus) — collabData passes the array through
   *  whole rather than mapping it field by field, so a new optional field needs
   *  no second declaration on this payload. Checked, not assumed. */
  agents: CollabAgentStatus[];
  suspended: boolean;
  /**
   * W3-L1: does this room need the USER right now — collabAttention.ts's
   * `collabNeedsUser` verdict, carried rather than left to each surface.
   *
   * It rides the payload because the Collabs overview pane is a WEBVIEW module
   * and tsconfig.webview.json pins rootDir to `webview/`, so it cannot import a
   * `src/` leaf. The alternative was a second copy of the rule webview-side, and
   * two copies of "is this room stuck" is exactly how the tab badge and the
   * overview row start disagreeing in front of the user.
   *
   * Always a boolean, never absent: a refusal answers `false`, so no surface can
   * read a dead engine as a summons.
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
