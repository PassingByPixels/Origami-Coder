// Origami Remote — WHICH HOST MESSAGES ARE WORTH A FRAME, AND FOR WHICH CHAT.
// The tables only; `remoteOutbound.ts` owns the buffering and the clock.
// THE PHONE IS SOLO: `ChatView.svelte` renders exactly ONE session's ChatPane,
// so every other open chat was streaming its whole turn up the relay.
//
// This is a SCOPING table, not a default-deny gate, and that is deliberate. The
// phone's InputBar and ModelPicker alone consume 25 further host types, and
// `remoteView.ts` exists so a message the sidebar gets, the phone gets. A
// default-deny list over 60+ control types would fail SILENTLY, one dead
// control at a time, and buy nothing.

/**
 * The four streamed types, and WHICH field separates two live streams of the
 * same type inside one session. Getting this wrong joins two agents' words into
 * one bubble:
 *   `agentText` messageId · `agentThought` one per session ·
 *   `compactionChunk` one per session · `subagentChunk` per `childSessionId`.
 */
export const DELTA_STREAM_FIELD = new Map<string, string | null>([
  ['agentText', 'messageId'],
  ['agentThought', null],
  ['compactionChunk', null],
  ['subagentChunk', 'childSessionId'],
  // t-gvz8t0. Thought arrives a token at a time like the prose above it, so it
  // buffers the same way and on the same key — a 7k-token thought is 7k frames
  // up the relay otherwise. Its own stream key: joining it to `subagentChunk`
  // would concatenate a child's thought INTO its prose.
  ['subagentThinking', 'childSessionId'],
]);

/**
 * GROUP 3 — never sent. Each is heavy and none has a surface on the phone:
 * `browserSnapshot` (an image data URL plus the whole page text, the largest
 * message the host has), `agentImage`, and `glidepathData` / `feedMessage`,
 * read only by panes solo mode never mounts.
 */
const NEVER = new Set(['browserSnapshot', 'agentImage', 'glidepathData', 'feedMessage']);

/**
 * GROUP 2 — sent only for the chat the phone is ON. A member with NO
 * `sessionId` still passes, because a scoping table must not swallow a message
 * it cannot scope.
 *
 * GROUP 1 is everything absent from both lists, and it is absent ON PURPOSE. The
 * session and turn types keep the switcher and the waiting dots true;
 * `requestPermission` / `permissionAudit` are the one thing that must NOT wait for
 * the owner to have the right chat open. Hydration always passes, because the burst
 * names the active chat LAST and filtering it would drop the transcript it is about
 * to ask for; the model types stay unscoped because a stale picker is worse than
 * ~200 bytes. `permModeUpdate` is absent and NOT dropped: only the host's inline
 * HTML reads it, which the phone never renders.
 *
 * `subagentTodos` sits beside `todoUpdate` for the same reason and with the
 * same effect: the phone MOUNTS THE DASHBOARD'S ChatPane, so its Todo panel
 * already renders the per-sub-agent tab strip the desk shows — it was simply
 * receiving every OTHER chat's children too. Scoped, never dropped: those tabs
 * are the only place a phone can see a delegated plan at all.
 */
const FOCUSED_ONLY = new Set([
  'agentText', 'agentThought', 'compactionChunk', 'subagentChunk',
  'compactionStart', 'compactionEnd', 'subagentDone', 'subagentTokens',
  // t-gvz8t0. The phone mounts the dashboard's own ChatPane, so the sub-agent
  // row it draws is the desk's row — without this it is the row that showed
  // NOTHING for a two-minute first step of pure thought. Scoped like every
  // other per-child signal beside it, never dropped.
  'subagentThinking',
  'toolCall', 'toolResult',
  'echoUser', 'peerMessage', 'revertDone', 'revertUndone', 'interjected',
  'planStatus', 'planReady', 'todoUpdate', 'subagentTodos', 'contextUpdate', 'approveUpdate', 'error',
  // t-fiszlv R9. The drawer rows this chat has retired, replayed on attach.
  // Scoped exactly like `subagentTodos` above it and for the same reason: the
  // phone mounts the dashboard's own ChatPane, so it draws the desk's drawer and
  // must not resurrect rows the desk swept — but it has no use for any chat's set
  // but the one it is on.
  'subagentDismissed',
  'arbiterDecision', 'turnVerdict', 'taskShape', 'bestOfNComplete',
  'firstfoldStart', 'firstfoldDone', 'sessionStatus', 'system',
  // t-f89g49. The ONE host message that writes text into a composer, so it is
  // scoped harder than most: it must reach the phone (the shared bundle mounts
  // the same InputBar, and a side quest started at the desk should show its
  // brief there) but only for the chat the phone is actually on. The exact
  // session match in composerPrefill.ts is the second lock; this is the first.
  'composerPrefill',
]);

/** What to do with one host message. `buffer` is `send` for a delta. */
export type Scope = 'send' | 'buffer' | 'drop';

/**
 * `focus` is the chat the phone is showing, or null while this side does not
 * know — which is why an unknown focus scopes nothing rather than everything.
 */
export function scopeOf(type: string, sessionId: string | undefined, focus: string | null): Scope {
  if (NEVER.has(type)) return 'drop';
  if (sessionId && focus !== null && sessionId !== focus && FOCUSED_ONLY.has(type)) return 'drop';
  return sessionId && DELTA_STREAM_FIELD.has(type) ? 'buffer' : 'send';
}
