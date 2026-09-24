// cellState.ts — one passthrough cell's translation state and turn bookkeeping.
// A tool card can be opened by one event and never closed by another (a dead child, an interrupt);
// settleOpenTools is the one place a turn end closes every open card.

import type { TaskRow } from './taskStrip';

/** One `postMessage` payload for the dashboard webview. */
export interface WebviewPost {
  type: string;
  [key: string]: unknown;
}

/** One sub-agent's tally. `tool` is the launcher (`Task` or `Agent`); `background` and `agentId`
 *  are set only once an `Agent` launch is confirmed, since it can outlive the turn. */
export interface AgentBeat {
  name: string; tools: number; msgs: number; startedAt: number; postedAt: number;
  tool?: string; background?: boolean; agentId?: string;
}

/** Per-session translation state, mutated in place by `translate`. One instance per chat cell,
 *  reached only through that cell's own closure. */
export interface TranslatorState {
  /** The Origami chat cell id every post is tagged with. */
  readonly sessionId: string;
  /** The CLI's own session id, adopted from the first event that carries one.
   *  This is what `--resume` takes. */
  providerSessionId?: string;
  /** Resolved model id, from system/init or message_start. */
  model?: string;
  /** content-block index → tool_use id, for the open blocks of this message. */
  openToolBlocks: Map<number, string>;
  /** tool_use id → the card title we opened it with, so a later update keeps
   *  the same label instead of relabelling mid-run. */
  toolTitles: Map<string, string>;
  /** Tool cards this cell has OPENED and not yet closed. The turn-close path
   *  drains it (`settleOpenTools`), which is what stops a missed or mismatched
   *  `tool_result` from leaving a spinner up forever. */
  openTools: Set<string>;
  /** content-block index → characters of thinking text seen. A block that ends with none means the
   *  model signed its reasoning without sharing it. */
  openThinking: Map<number, number>;
  /** Sub-agents out, by parent `Task`/`Agent` tool_use id. Their frames are
   *  DROPPED and only COUNTED — the drawer's live count, with no second
   *  conversation drawn. */
  agents: Map<string, AgentBeat>;
  /** The todo strip's rows, in creation order. The CLI's Task tools ARE the
   *  todo system on 2.1.198 — TodoWrite is not shipped any more — so this is
   *  what feeds the strip; the fold is taskStrip.ts's. */
  tasks: TaskRow[];
  /** Turns completed in this binding, one per `result` — the composer's own turn counter never
   *  updates for a bound cell otherwise. */
  turns: number;
  /** Last rate-limit status surfaced, so a warning is shown once per change
   *  rather than on every event the CLI repeats it in. */
  lastRateLimitStatus?: string;
  /** True until `system/init` says otherwise. A turn whose funding we have not
   *  been told about must not be priced — see sessionFacts.onSubscription. */
  subscription: boolean;
  /** Latest headroom badge, so the meter post can carry it alongside a later
   *  `subscription` change without waiting for the next rate-limit frame. */
  pill?: RateLimitPillLike;
  /** Where `pill` came from. A live `rate_limit_event` is this session's OWN
   *  measurement and WINS over the account-wide OAuth read that fills the badge
   *  in before the first warning frame arrives (planUsage.ts). */
  pillSource?: 'event' | 'account';
  /** `origami.claudeCode.slashSkills`. Off ⇒ the `/` palette is never told
   *  about this session's commands and the connected line does not count them. */
  slashSkills: boolean;
  /** name → one-line prose, from the `initialize` control_response. */
  commandHelp: Map<string, string>;
  /** `init.slash_commands`, kept so a control_response arriving AFTER init can
   *  re-emit the palette rows with their descriptions filled in. */
  commandNames: readonly string[];
  /** The last "connected" line shown. A respawned child re-inits and would say
   *  it again — sessionFacts.connectedPosts owns that rule. */
  lastConnected?: string;
  /** How this binding started, fixed at bind time: "a new session in <cwd>" or "resuming your last
   *  session in <cwd>". Never rewritten, so a respawn does not repeat it. */
  readonly origin: string;
}

/** The pill shape the state holds. Declared structurally so this leaf imports
 *  nothing — usagePill.ts owns the real `RateLimitPill` and is compatible. */
export interface RateLimitPillLike {
  status: string;
  window: string;
  pct: number;
  resetsAt: number;
  title: string;
  /** Every window this reading carries — optional so a `RateLimitPill` from
   *  before this field existed still satisfies the structural shape. */
  windows?: readonly { label: string; pct: number; resetsAt: number }[];
}

export interface CellStateOptions {
  slashSkills?: boolean;
  /** The connected line's origin clause. Empty ⇒ the line says nothing about
   *  how the binding started, which is what a host that predates it gets. */
  origin?: string;
}

export function newTranslatorState(sessionId: string, options: CellStateOptions | boolean = {}): TranslatorState {
  // `boolean` is phase 1's positional `slashSkills` argument, kept so the
  // existing callers and their tests read unchanged.
  const opts = typeof options === 'boolean' ? { slashSkills: options } : options;
  return {
    sessionId,
    openToolBlocks: new Map(),
    toolTitles: new Map(),
    openTools: new Set(),
    openThinking: new Map(),
    agents: new Map(),
    tasks: [],
    turns: 0,
    subscription: true,
    slashSkills: opts.slashSkills !== false,
    commandHelp: new Map(),
    commandNames: [],
    origin: opts.origin ?? '',
  };
}

/** What an unresolved card is told when its turn ends without a result.
 *  It is not an ERROR — the tool may well have run — so it says exactly what is
 *  known: the turn closed and the harness never reported an outcome. */
export const UNRESOLVED_TOOL_NOTE = 'The turn ended before Claude Code reported this tool’s result.';

/** What an INTERRUPTED card is told. Separate wording because the cause is
 *  known and is the user's own action. THE USER'S OWN ACTION IS THE ONLY THING THAT MAY SAY THIS:
 *  a child that died on its own says CRASHED_TOOL_NOTE, and the row beside it says why. */
export const INTERRUPTED_TOOL_NOTE = 'Interrupted before Claude Code reported this tool’s result.';

/** What a card is told when the CHILD went away under it. The owner's report that started
 *  t-d94nra was this case wearing the interrupt's wording: a one-prompt session, no interrupt, and
 *  a Write card that claimed the user had stopped it. */
export const CRASHED_TOOL_NOTE = 'Claude Code stopped before reporting this tool’s result.';

/** Close every card this cell still has open, and empty the set. Status 'failed': a card must not
 *  claim an outcome nobody measured, and a spinner left open is the defect this exists to avoid.
 *  Called from the translator's result path, the manager's cancel, and the driver's unexpected-exit
 *  handler. */
export function settleOpenTools(st: TranslatorState, note: string): WebviewPost[] {
  // Ends every foreground tally; a background agent is deliberately kept since it outlives the turn
  // and a turn close is not news about it (subagentClose.ts settles it).
  for (const [id, beat] of [...st.agents]) if (!beat.background) st.agents.delete(id);
  if (st.openTools.size === 0) return [];
  const posts: WebviewPost[] = [];
  for (const id of st.openTools) {
    posts.push({
      type: 'toolResult', sessionId: st.sessionId, toolCallId: id,
      status: 'failed', content: note,
      ...(st.toolTitles.has(id) ? { toolName: st.toolTitles.get(id) } : {}),
    });
  }
  st.openTools.clear();
  return posts;
}
