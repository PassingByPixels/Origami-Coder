// replaySession.ts — what one freshly attached view is told about one chat, extracted from
// DashboardPanel.replaySessionsTo.
// The phone gets the same attach burst minus what costs bytes and buys nothing (agentArt,
// mode/effort options); todoUpdate replay is new for both and fixes a bug where a reopened chat
// (tab or phone) showed an empty task strip.

import { configSelectorMessages, type SelectorClient } from './configSelectors';
import { postPeerName } from './peerNamePost';
import { claudeCodeKind } from './claudeCodeManager';
import { needsFirstFold } from './firstFold';
import { readAgentArt } from '../workspace/WorkspaceReader';
import { remoteRestore } from '../remote/remoteDelta';
import type { SessionMessage } from './sessionLog';
import { historyStatePost, type HostHistory } from './historyHost';

/** The last `todoUpdate` a chat posted, held so it can be replayed. */
export interface TodoSnapshot {
  source: string;
  todos: unknown[];
}

/** The slice of `DashboardPanel`'s own `Session` this file reads. */
export interface ReplaySession {
  id: string;
  number: number;
  agentName: string;
  title?: string;
  botGlyph?: string;
  /** True while this chat's engine is still starting (DashboardPanel.ts). A tab that
   *  attaches inside that window learns it HERE — the live `sessionStarting` post that
   *  clears it can arrive before the tab's wire exists, and a pane stuck on "starting"
   *  would be the same lost-post defect this replay exists to close. */
  starting?: boolean;
  messageLog: SessionMessage[];
  /** t-ucnp7t: a recalled chat's older pages, cursor and roster (historyHost.ts). */
  history?: HostHistory;
  todoSnapshot?: TodoSnapshot;
  client?: SelectorClient & { peerName?: string };
}

export interface ReplayContext {
  /** True for `RemoteView`'s webview — see `remote/phoneView.ts`. */
  remote: boolean;
  /** True only when this phone declared it can inflate `restoreMessagesZ`. Defaults to plain so a
   *  page that hasn't learned the type still shows most of the tail rather than an empty
   *  transcript. */
  compress: boolean;
  /** Rows the phone says it still holds, from its snapshot cursor. Undefined means send the whole
   *  tail. */
  since?: number;
  /** `findWorkspacePath()`, read once for the whole loop. */
  wsPath: string | null;
  /** The panel's own cwd, the fallback `needsFirstFold` is asked about. */
  cwd: string;
  /** This session's own resolved context window (`sessionValidWindow`). */
  contextWindow: number;
  /** `sessionActivityFields(session)` — last activity and row count. */
  activity: object;
  /** Rows this chat's sub-agent drawer has already retired (subagentDismissed.ts). */
  dismissedSubagents: readonly string[];
}

/** Post one session's attach burst to one view, in the sidebar's established order. */
export function replaySessionTo(
  post: (msg: object) => void,
  session: ReplaySession,
  ctx: ReplayContext,
): void {
  post({
    type: 'sessionCreated',
    sessionId: session.id,
    sessionNumber: session.number,
    agentName: session.agentName,
    // The stored name arrives via loadSession's session_info_update, which lands before this view
    // attaches — carry it here or the tab renders the agent name alone.
    title: session.title,
    // The bot's ASCII art is a few KB per session and the phone never draws it.
    agentArt: ctx.remote || !ctx.wsPath ? null : readAgentArt(ctx.wsPath, session.agentName),
    needsSetup: needsFirstFold(ctx.wsPath ?? ctx.cwd),
    botGlyph: session.botGlyph,
    // Only when it IS starting: an absent field reads as false on the pane
    // (sessionReplay.adoptAnnouncement), so a settled chat's burst stays byte-for-byte
    // what it was — this replay is also the phone's hydrate budget
    // (remoteHydrateBudget.test.ts).
    ...(session.starting === true ? { starting: true } : {}),
    kind: claudeCodeKind(session.id), // a cell bound to Claude Code comes back with its gates on
  });
  postPeerName(session.client?.peerName, session.id, post); // reattach replay
  // Restore visible scrollback for sessions that already have history (e.g. an archive rehydrate on
  // the primary view).
  if (session.messageLog.length > 0) {
    post(
      ctx.remote
        ? remoteRestore(session.id, session.messageLog, ctx)
        : { type: 'restoreMessages', sessionId: session.id, messages: session.messageLog },
    );
  }
  // t-ucnp7t (plan 3.5 "Late tab"): the older pages and the cursor, so a tab that attaches after a
  // scroll-up sees the same window. Not the phone: it keeps the tail of `messageLog` only.
  if (session.history && !ctx.remote) post(historyStatePost(session.id, session.history, true));
  // The drawer rows this chat has already retired (t-fiszlv R9), read by the caller off the
  // workspace memento that survives a reload (subagentDismissed.ts). Sent only when there is
  // something to say — an empty set is the webview's own default.
  if (ctx.dismissedSubagents.length > 0) {
    post({ type: 'subagentDismissed', sessionId: session.id, keys: ctx.dismissedSubagents });
  }
  // Seed the context gauge with this session's own window so it isn't blank until the next turn.
  post({
    type: 'contextUpdate',
    sessionId: session.id,
    tokensUsed: 0,
    contextWindow: ctx.contextWindow,
    ...ctx.activity,
  });
  // The task strip holds only what the host last pushed; seed it here or a reopened chat (tab or
  // phone) shows an empty strip over a live plan.
  if (session.todoSnapshot) {
    post({ type: 'todoUpdate', sessionId: session.id, ...session.todoSnapshot });
  }
  // The composer's Effort/Session-Mode/Approve controls likewise hold only the last push — seed per
  // session like the context gauge above. The phone keeps only approveUpdate.
  for (const msg of configSelectorMessages(session.id, session.client)) {
    if (!ctx.remote || (msg as { type?: string }).type === 'approveUpdate') post(msg);
  }
}

/** Hold a todoUpdate on its session as it is broadcast, from the one place every poster goes
 *  through (`DashboardPanel.post`), covering the engine, firstfold and the Claude Code translator
 *  with one line. */
export function noteTodoSnapshot(
  sessions: ReadonlyMap<string, { todoSnapshot?: TodoSnapshot }>,
  msg: object,
): void {
  const m = msg as { type?: unknown; sessionId?: unknown; source?: unknown; todos?: unknown };
  if (m.type !== 'todoUpdate' || typeof m.sessionId !== 'string') return;
  const session = sessions.get(m.sessionId);
  if (!session) return;
  session.todoSnapshot = {
    source: typeof m.source === 'string' ? m.source : '',
    todos: Array.isArray(m.todos) ? m.todos : [],
  };
}
