<script lang="ts">
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import PermissionBar from '../components/PermissionBar.svelte';
  import QuestionModal from '../components/QuestionModal.svelte';
  import InputBar from '../components/InputBar.svelte';
  import type { VisionState } from '../components/visionPinState';
  import ConfirmModal from '../components/ConfirmModal.svelte';
  import PlanPanel from '../components/PlanPanel.svelte';
  import TodoOverlay from '../components/TodoOverlay.svelte';
  import SubagentDock from '../components/SubagentDock.svelte';
  import { dropScrollAnchor, isNearBottom, markScrollAnchor, stickToBottom } from './chatScroll';
  import { applyToolCall, applyToolResult } from './chatToolMsg';
  import { restoreLog, type RestoredEntry } from './chatRestore';
  import { subagentRows } from './subagentRows';
  import { cardForChild, cappedStream, childId, makeDropLog } from './subagentInbox';
  import { pickAllowOption, isQuestionShaped } from '../components/permissionOptions';
  import { openAsk, closeAsk, visibleAsk, answerPost, cancelPost, type QuestionAsks } from './questionAsks';
  import { isTabWaiting } from './tabWaiting';
  import { sealsOpenBubble } from './agentStreamSeal';
  import PinnedUserMessage from '../components/PinnedUserMessage.svelte';
  import { pinnedMirrorText } from '../components/pinnedUser';
  import ThinkingGlyph from '../components/ThinkingGlyph.svelte';
  import LoadingCycler from '../components/LoadingCycler.svelte';
  import CraneMark from '../../shared/CraneMark.svelte';
  import ChatEmptyState from '../components/ChatEmptyState.svelte';
  import { hasOpenWork, todoOverlayVisible } from './todoScratchbook';
  import { flushQueuedSend } from './queuedFlush';
  import { rewindSlice } from './rewindSlice';
  import { aggregateSessionChanges } from './sessionChanges';
  import { echoTextFor, consumeEcho } from './userEcho';
  import { armInterject, drainInterject, resolveInterject } from './interjectSplit';
  import { retryAsPrompt } from './interjectRetry';
  import { adoptAnnouncement, acceptsReplayedLog, glyphOf } from './sessionReplay';
  import { verdictForStopReason, verdictLabel } from './turnVerdict';
  import ImageLightbox from '../components/ImageLightbox.svelte';
  import ChatFind from '../components/ChatFind.svelte';
  // The per-message rows themselves. EXTRACTED into ChatTranscript.svelte so a
  // read-only transcript can later render them through the SAME renderer; the
  // Message/TodoInfo shapes went to chatMessage.ts for the same reason (a type
  // declared inside this <script> could not be named by the second component).
  import ChatTranscript from '../components/ChatTranscript.svelte';
  import type { Message, TodoInfo } from './chatMessage';

  interface PlanScoreView {
    feasibility: number;
    specificity: number;
    riskCoverage: number;
    total: number;
    notes: string;
  }

  interface PlanCandidateView {
    index: number;
    title: string;
    planId: string;
    textPreview: string;
    score: PlanScoreView | null;
  }

  interface BestOfNVerdictView {
    winnerIndex: number;
    rationale: string;
    fallback: boolean;
  }

  interface PlanInfo {
    planId: string;
    title: string;
    filePath: string;
    status: string;
    revisionCount: number;
    alternatives: PlanCandidateView[];
    verdict: BestOfNVerdictView | null;
  }

  interface PermissionAsk {
    toolCallId: string;
    title: string;
    options: { optionId: string; name: string; kind: string }[];
    /** Ground-truth target (path / dir / url / command) + action kind, shown
     *  on the bar so the user approves with context, not a bare title. */
    target?: string;
    action?: string;
    /** The literal shell command for an execute ask, shown verbatim (monospace,
     *  wrap/scroll) so the user sees exactly what they're approving. */
    command?: string;
  }

  interface ChatSession {
    id: string;
    number: number;
    agentName: string;
    /** Peer-broker name from the engine ('peerName' message) — the address send_message resolves `to` against; agentName is only a display default. */
    peerName?: string;
    /** Display task name (slug of first message, then engine title). */
    title?: string;
    /**
     * S8 V16 (bright-muffin) — banner ASCII art for the agent. Read
     * from `<workspace>/agents/<agentName>/profile/art.txt` by the
     * extension at session-creation time. `null` when the file is
     * missing/empty; ChatPane skips the banner in that case.
     */
    agentArt: string | null;
    /** t-r7c757 round 2 — true while this workspace has never been folded; pins
     *  the firstfold tip instead of the rotation. Set from sessionCreated,
     *  flipped live by firstfoldDone. `botGlyph` rides the same message: the
     *  creature a bot chat's empty state opens under (sessionReplay.glyphOf). */
    needsSetup: boolean; botGlyph?: string;
    modelName: string;
    messages: Message[];
    inFlight: boolean;
    currentAgentMsgId: number | null;
    /** Open reasoning ('thought') message being streamed, separate from the
     *  prose stream so the two interleave cleanly (thought -> text -> thought). */
    currentThoughtMsgId: number | null;
    /** Lines typed during this session's turn are with the host, unanswered.
     *  Cleared by `interjected`/`error`/`closed` per line, and drained by
     *  turnDone, so a reply that never arrives cannot leave the chip up. */
    interjecting?: boolean;
    /** Their text, oldest first, held from the keypress until the host answers —
     *  each row is drawn where its answer lands (interjectSplit.ts). */
    pendingInterject?: string[];
    /** Text of the user row drawn at SEND, until `echoUser` confirms it (userEcho.ts). */
    pendingEcho?: string | null;
    /** The ask currently ON the permission bar — the HEAD of the queue below. */
    permission: PermissionAsk | null;
    /**
     * Asks that arrived while another was still on the bar, in arrival order.
     * A sub-agent's ask is forwarded under its registered ANCESTOR's session
     * (engine acp/permission.ts), so N concurrent children all land on ONE chat
     * session. This used to be a single overwritten field: the last ask won and
     * the displaced ones became permanently invisible, so N-1 children hung at
     * zero tokens forever. Answering the head promotes the next one.
     */
    permissionQueue: PermissionAsk[];
    /** Text queued from a plan-mode "Revise" choice — the turn is still in
     *  flight when the user submits it, so it's sent as a fresh prompt once
     *  the turn ends (flushed in `turnDone`). */
    pendingSend?: string;
    plan: PlanInfo | null;
    /**
     * Iter-25.11 — live todo snapshot rendered as a sticky strip
     * above the chat thread. Updated on every `todoUpdate` message
     * from the extension; cleared to `[]` when the session resets.
     */
    todos: TodoInfo[];
    /** Provenance of the current snapshot — surfaces in the strip's
     * title tooltip. `''` while no snapshot has landed yet. */
    todoSource: string;
    /** Tweak 3 — the run-time todo overlay's collapsed state, owned here so the
     *  choice persists across the overlay re-mounting each turn (per-session). */
    todosCollapsed?: boolean;
    /** The LEFT sub-agent drawer's open state. Collapsed by default (undefined
     *  = shut): a background roster is consulted, not imposed. */
    subagentsOpen?: boolean;
    /** Sub-agent roster keys (subagentRows.ts) retired from the drawer — a
     *  manual dismiss (x) on a failed row, OR the auto-clear a fresh turn
     *  performs on whatever failed rows are still showing (see
     *  handleSendForSession). A failed entry never settles on its own
     *  (subagentEntry.ts), so this is the only way one ever leaves the
     *  roster; the transcript's own card is untouched either way. */
    subagentsDismissed?: string[];
    openThoughtIds?: number[]; // user-opened thought ids; survives stream deltas (thoughtOpenState.ts)
    /** Focus view for THIS cell — transcript down to the conversation, composer
     *  eye lit (chatFocus.ts). Per-cell: a grid focuses one chat, not all twelve.
     *  NOT persisted, because a view that hides work by default hides mistakes. */
    focusMode?: boolean;
    /**
     * Does this transcript FOLLOW the stream? `undefined` = yes, so no session
     * construction site has to remember to set it and a recalled session
     * behaves like a fresh one. Set false the moment the user scrolls away from
     * the bottom, true again when they return or send a message of their own.
     */
    stuckToBottom?: boolean;
    /**
     * Handle for the post-turn linger timer. At `turnDone` we keep the
     * live overlay up for a short window (so a late all-at-once todowrite
     * still visibly flashes) before clearing `todos`. Tracked so a new
     * send can cancel a still-pending clear and not have it wipe the next
     * turn's freshly-written todos. `null` when no clear is scheduled.
     */
    todoLingerTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Pillar 3 dashboard upgrade (2026-05-22) — latest cumulative
     * token count reported by `contextUpdate`. Pushed onto the next
     * `turnDone`'s agent message so users can hover to see "at this
     * point in history, the conversation had used N tokens".
     */
    latestTokensUsed: number;
    /** B9 — latest context fill % + the cumulative-token mark of the
     *  previous turn, used to derive per-turn spend at `turnDone`. */
    latestContextPct: number;
    prevTokensStamped: number;
    /**
     * Phase 1 dashboard upgrade (2026-05-22) — Phase 6.5 task
     * decomposition rendered alongside TodoStrip. `null` until the
     * runtime emits one for this session. Closes the long-standing
     * `taskShape` drop-on-floor at DashboardPanel.ts:1035.
     */
    taskShape: TaskShapeInfo | null;
    /**
     * M1 followable surface — the SINGLE per-turn arbiter decision
     * (Done | Continue | AskUser) from the first-class
     * `origami/arbiterDecision` notification. Replaced wholesale each
     * turn (never appended), so the dashboard shows exactly ONE
     * coherent decision per turn — the opposite of the donor's "10
     * gates firing into one turn" with no coherent UI signal (F3).
     * `null` until the bridge emits one for this session.
     */
    arbiterDecision: ArbiterDecisionInfo | null;
    /**
     * A staged "rewind to here": the tail of messages optimistically removed
     * from the view when the user rewound, kept so the Undo banner can restore
     * them (engine `unrevert`). Cleared once the next user message finalises the
     * rewind server-side. Undefined = no rewind pending.
     */
    revertStash?: Message[];
  }

  interface ArbiterDecisionInfo {
    // `incomplete` is the honest verdict for error/park terminals — it
    // is NOT a value the bridge's arbiterDecision wire carries (that
    // collapses errors to `continue`); the per-turn `turnVerdict`
    // (from the real stop_reason) upgrades the chip to `incomplete`.
    // `unknown` is an unrecognised raw label, surfaced literally rather
    // than masked as the benign `continue`.
    decision: 'done' | 'continue' | 'ask_user' | 'incomplete' | 'unknown';
    reason: string;
  }

  interface TaskShapeInfo {
    source: string;
    truncatedExtra: number;
    subTasks: Array<{
      id: number;
      description: string;
      status: string;
    }>;
  }

  // `soloSessionId` non-empty ⇒ this ChatPane is a popped-out editor tab
  // dedicated to ONE session: it renders only that session and hides the
  // multi-chat tab strip + history/grid chrome. Empty ⇒ the normal sidebar.
  let { soloSessionId = '' }: { soloSessionId?: string } = $props();

  const vscode = getVsCodeApi();
  let sessions: ChatSession[] = $state([]);
  let activeSessionId: string | null = $state(null);
  // Which session (if any) is awaiting a branded compaction confirm. Set when
  // its gauge is clicked; the modal resolves it into a compactContext post.
  let compactConfirmId: string | null = $state(null);
  // The image the lightbox is showing, or null when it is shut. A PLAIN local
  // object of two strings — it is never posted to the host, so the $state proxy
  // never reaches structuredClone, and the `data:` URL it holds is already the
  // whole picture (nothing to fetch, nothing to fail).
  let lightbox: { src: string; alt: string } | null = $state(null);
  const openLightbox = (src: string, alt: string) => (lightbox = { src, alt });
  function confirmCompact() {
    if (compactConfirmId) vscode.postMessage({ type: 'compactContext', sessionId: compactConfirmId });
    compactConfirmId = null;
  }

  // Question modal. ONE engine ask carries ALL of its questions (the engine puts
  // them on `_meta.questions`; acpClient parses them out), so an entry is a single
  // ask holding N questions — NOT a queue of asks. It was a queue, and it could
  // never hold more than one, because the engine blocks on each answer before it
  // sends the next question: the modal always said "1 of 1".
  // Keyed BY CHAT (questionAsks.ts): the batch belongs to the session that asked,
  // so it renders over that session's own cell and never over the one being read,
  // and a second asker cannot overwrite the first. The draft lives in the entry
  // because leaving the tab unmounts the modal — hidden is not dismissed.
  let questionAsks = $state<QuestionAsks>({});

  function handleQuestionSubmit(answers: { optionId: string; answerText?: string }[]) {
    const ask = activeAsk;
    if (!ask) return;
    questionAsks = closeAsk(questionAsks, ask.sessionId);
    vscode.postMessage(answerPost(ask, answers));
  }

  function closeQuestionModal() {
    // Cancel = ONE cancellation for the ONE ask. It must reach the engine:
    // clearing this state alone would leave the engine blocked on an answer
    // that is never coming, and the turn would hang forever.
    const ask = activeAsk;
    if (!ask) return;
    questionAsks = closeAsk(questionAsks, ask.sessionId);
    vscode.postMessage(cancelPost(ask));
  }

  // "Rewind to here": rollback to before an assistant turn. Trims the transcript
  // (which slice: rewindSlice.ts) and stashes the tail for Undo; the engine
  // restores the tree + prunes (finalised on the next prompt; unrevert till then).
  function rewindTo(sid: string, engineMsgId?: string) {
    const s = engineMsgId ? getSession(sid) : null;
    if (!s || s.inFlight) return;
    const cut = rewindSlice(s.messages, engineMsgId!);
    if (!cut) return;
    s.revertStash = cut.removed;
    s.messages = cut.keep;
    s.currentAgentMsgId = null;
    s.currentThoughtMsgId = null;
    vscode.postMessage({ type: 'revertToMessage', messageId: engineMsgId, sessionId: sid });
  }

  function undoRewind(sid: string) {
    const s = getSession(sid);
    if (!s || !s.revertStash) return;
    // Restore is deferred to `revertUndone(ok)` so a failed unrevert never leaves
    // the view out of sync with the (still-reverted) engine.
    vscode.postMessage({ type: 'undoRevert', sessionId: sid });
  }
  let nextMsgId = 0;
  let messagesEl: HTMLDivElement | undefined = $state();

  // In-webview history dropdown (replaces the native QuickPick). The list
  // is requested from the host on open and filtered client-side.
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let historyQuery = $state('');
  interface HistoryItem { sessionId: string; title: string; folder: string; updatedAt: string }
  let historyItems = $state<HistoryItem[]>([]);
  let historyFiltered = $derived.by(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return historyItems;
    return historyItems.filter(h => `${h.title} ${h.folder}`.toLowerCase().includes(q));
  });
  function openHistoryDropdown() {
    historyOpen = true;
    historyLoading = true;
    historyItems = [];
    historyQuery = '';
    vscode.postMessage({ type: 'requestHistory' });
  }
  function toggleHistory() {
    if (historyOpen) historyOpen = false;
    else openHistoryDropdown();
  }
  function recallSession(sessionId: string) {
    historyOpen = false;
    vscode.postMessage({ type: 'recallSession', sessionId });
  }
  function fmtHistoryDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }
  function popOutSession(sid: string) {
    vscode.postMessage({ type: 'popOutSession', sessionId: sid });
  }

  // Two-mode chat layout: `single` (one chat fills the pane) or `grid`
  // (every open chat tiled, uncapped). Each cell hosts a fully independent
  // agent chat — its own InputBar / PermissionBar / PlanPanel
  // mounted inside the cell that owns the session. The
  // `activeSessionId` survives as the image-paste source and persistence
  // target; clicking a cell promotes it for that purpose.
  type ChatLayout = 'single' | 'grid';
  let chatLayout: ChatLayout = $state('single');
  // `single` shows the active session full-width; `grid` shows ALL
  // sessions (UNCAPPED) in an auto-fit grid that wraps + scrolls. The old
  // single/two-up/quadrant 4-cell cap was a pure layout artifact — the
  // sessions Map itself has no max — so it's gone: open as many chats as
  // you like and `grid` tiles all of them.
  let visibleCells = $derived<ChatSession[]>(
    soloSessionId
      ? sessions.filter(s => s.id === soloSessionId)
      : chatLayout === 'grid'
        ? sessions
        : (activeSession ? [activeSession] : sessions.slice(-1))
  );
  // The one question batch the modal may show: owned by a chat whose cell is on
  // screen, active cell first. Declared here because it reads `visibleCells`.
  let activeAsk = $derived(visibleAsk(questionAsks, activeSessionId, visibleCells.map(s => s.id)));

  // A sub-agent side-channel event that found no card — counted and said out
  // loud rather than dropped in silence (why, and the throttle: subagentInbox.ts).
  const dropLog = makeDropLog();
  function warnSubagentDrop(kind: string, child: string) {
    const line = dropLog(kind, child);
    if (line) console.warn(line);
  }

  function cycleChatLayout() {
    chatLayout = chatLayout === 'single' ? 'grid' : 'single';
  }
  function chatLayoutGlyph(l: ChatLayout): string {
    return l === 'single' ? '☐' : '▦';
  }
  // S7 — tell the extension when the SIDEBAR (not a solo tab) is in grid layout: grid
  // tiles every session visibly, so a background agent's permission ask must forward to
  // its cell instead of auto-deciding (DashboardPanel.isSessionMounted honours this).
  $effect(() => {
    if (!soloSessionId) vscode.postMessage({ type: 'chatGridMode', grid: chatLayout === 'grid' });
  });

  // S7 V10 (bright-muffin) — broadcast active-session changes to the
  // extension so DashboardPanel can stash the id in workspaceState and
  // restore it after a reload. Skip the initial null so we don't
  // overwrite a real saved value before the first chat opens.
  let lastBroadcastSessionId: string | null = null;
  $effect(() => {
    // A popped-out solo tab must NOT drive the shared active-session (that
    // would clobber the sidebar's focus / image-paste target). It pins
    // itself to its own session below instead.
    // One-time: ask the host for each session's own model so every cell (incl. a
    // solo tab, which never posts activeSessionChanged) shows its own model.
    if (!requestedSessionModels) {
      requestedSessionModels = true;
      vscode.postMessage({ type: 'requestSessionModels' });
    }
    if (soloSessionId) return;
    if (activeSessionId !== lastBroadcastSessionId) {
      lastBroadcastSessionId = activeSessionId;
      if (activeSessionId !== null) {
        vscode.postMessage({ type: 'activeSessionChanged', sessionId: activeSessionId });
      }
    }
  });

  // Solo tab: once its session has arrived (replayed on attach), pin the
  // local active-session to it so the single cell + image-paste target
  // resolve correctly, regardless of which session the host considers
  // active. visibleCells is solo-filtered, so there's no flash.
  $effect(() => {
    if (
      soloSessionId &&
      activeSessionId !== soloSessionId &&
      sessions.some(s => s.id === soloSessionId)
    ) {
      activeSessionId = soloSessionId;
    }
  });

  // Model connectivity — reported by the extension after probing LM Studio.
  let modelName = $state('');
  let modelOnline = $state(false);
  // Each session's OWN selected model (per-session in the engine), so every
  // visible chat cell shows ITS model, not the globally-loaded one. Keyed by
  // sessionId; falls back to the global `modelName` when a cell has no entry yet.
  let modelBySession = $state<Record<string, string>>({});
  // Strip the provider prefix (the provider is implied by the model) for display.
  function prettyModel(v: string | undefined): string {
    if (!v) return '';
    const parts = v.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : v;
  }
  let requestedSessionModels = false;
  // Whether the loaded model is vision-capable (LM Studio type:vlm), read live
  // from the connection — drives the InputBar vision indicator.
  let isVlm = $state(false);
  // ...and whether that answer is DETECTED or PINNED by the owner. Separate from
  // `isVlm` because they come from different places: isVlm is the live engine
  // fact, visionState is config + the globalState pin the Vision control writes.
  let visionState = $state<VisionState>('auto-off');
  let modelReason = $state('');
  // Per-session model connectivity, keyed by sessionId, so a model op in ONE chat
  // can't flip another chat's online state / offline banner / vision. A modelStatus
  // now carries the sessionId it was computed for; a status without one (boot/older
  // host) falls back to the globals above.
  let onlineBySession = $state<Record<string, boolean>>({});
  let reasonBySession = $state<Record<string, string>>({});
  let isVlmBySession = $state<Record<string, boolean>>({});
  let visionStateBySession = $state<Record<string, VisionState>>({});
  // Per-session model NAME + provider identity (label + local?) from the same
  // tagged statuses — the offline banner must name the RIGHT server ("start LM
  // Studio" vs "check the Spark") and a tagged status for one chat must never
  // stomp another chat's displayed model.
  let nameBySession = $state<Record<string, string>>({});
  let providerLabelBySession = $state<Record<string, string>>({});
  let providerLocalBySession = $state<Record<string, boolean>>({});
  // Phase 8 of the 2026-04-26 collapse — active mode (Normal / Game) +
  // per-mode default models, surfaced in the dashboard header.
  let activeMode = $state<'normal' | 'game'>('normal');
  let defaultModelNormal = $state('');
  let defaultModelGame = $state('');

  let activeSession = $derived(sessions.find(s => s.id === activeSessionId) ?? null);

  function scrollToBottom(sessionId?: string) {
    // V17 close (cozy-lantern): in multi-up modes the messages
    // scroller for each cell is keyed by data-session-id. Targeting
    // the active cell directly avoids the bind:this-overwrite race
    // where the last-rendered cell would otherwise capture the ref.
    const targetSid = sessionId ?? activeSessionId;
    // STICK GATE. A user who scrolled up is READING; snapping them back on
    // every streamed chunk is what made a live transcript unusable. Their own
    // send re-arms it, as does scrolling back down. Read INSIDE the frame, not
    // when it was queued: a chunk landing just before the user scrolls away
    // would otherwise leave a snap in flight that fires after their scroll.
    requestAnimationFrame(() => {
      if (targetSid) {
        const s = getSession(targetSid);
        if (s?.stuckToBottom === false) return;
        const cell = document.querySelector<HTMLDivElement>(
          `.cell-messages[data-session-id="${targetSid}"]`,
        );
        // No cell means this session is not on screen (single layout renders the
        // active one only). Nothing to scroll — falling through to messagesEl
        // would scroll a DIFFERENT chat, the one the user is reading, past a
        // stick gate that was never asked about it.
        if (cell && !stickToBottom(cell) && s) s.stuckToBottom = false;
        return;
      }
      if (messagesEl && !stickToBottom(messagesEl) && activeSession) activeSession.stuckToBottom = false;
    });
  }

  function getSession(sid: string): ChatSession | undefined {
    return sessions.find(s => s.id === sid);
  }

  /** Re-read the stick from where the scroller actually IS. Not "did they
   *  scroll up?" — this also runs for scrollToBottom's own programmatic scroll,
   *  which lands at the bottom and so re-arms the follow instead of fighting it. */
  function onMessagesScroll(s: ChatSession, ev: Event) {
    const el = ev.currentTarget as HTMLDivElement;
    markScrollAnchor(el);
    s.stuckToBottom = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  }

  function onMessagesWheel(s: ChatSession, ev: WheelEvent) {
    if (ev.deltaY < 0) s.stuckToBottom = false;
  }

  // Empty-state gate. A session "has a real conversation" once the user
  // or the agent has actually said something. The initial system
  // "Connected. Session …" line (and any tool/verdict/error/system rows)
  // do NOT count — they're scaffolding, not a turn. So the empty state
  // (crane + hint) shows until the first user/assistant turn arrives, then
  // the thread renders as normal.
  function hasConversation(s: ChatSession): boolean {
    return s.messages.some(m => m.kind === 'user' || m.kind === 'agent');
  }

  function addMessage(sid: string, kind: Message['kind'], label: string, text: string, images?: string[], engineMsgId?: string, extra?: Partial<Message>): number {
    const id = nextMsgId++;
    const s = getSession(sid);
    if (s) {
      // A fresh user turn finalises any staged rewind (the engine deletes the
      // reverted tail on the next prompt) — the Undo window is over, drop the stash.
      if (kind === 'user' && s.revertStash) s.revertStash = undefined;
      // A user row SEALS whatever the agent had open. Same rule `toolCall`
      // applies below and for the same reason: prose the model streams AFTER
      // this row must open a FRESH message BELOW it, not append back into the
      // one above and render out of sequence. `handleSendForSession` already
      // did this for its own send; here it also covers an INTERJECTION (live —
      // interjectSplit.ts — and replayed through `echoUser`), which is the case
      // where the stream is genuinely still running underneath the new row.
      if (kind === 'user') { s.currentAgentMsgId = null; s.currentThoughtMsgId = null; }
      s.messages = [...s.messages, { id, kind, label, text, images, engineMsgId, timestamp: Date.now(), ...extra }];
      // V17 close (cozy-lantern): scroll the cell that owns this
      // session, regardless of which cell is "active". In single
      // mode there's only one cell so the active gate didn't matter;
      // in multi-up modes every cell now auto-scrolls its own feed.
      scrollToBottom(sid);
    }
    return id;
  }

  function appendToMessage(sid: string, msgId: number, text: string) {
    const s = getSession(sid);
    if (s) {
      s.messages = s.messages.map(m =>
        m.id === msgId ? { ...m, text: m.text + text } : m
      );
      scrollToBottom(sid);
    }
  }

  // V17 close (cozy-lantern) — handlers take a target session so
  // per-cell components can dispatch independently. Wrapper variants
  // preserve the original active-session-bound signatures for any
  // callers that still rely on them.
  function handleSendForSession(s: ChatSession, text: string, mode = '') {
    // /compose may start with no args (it opens an interview), so empty text is
    // allowed when a mode is set; every other send still requires text.
    if (!s || s.inFlight || (!text.trim() && !mode)) return;
    // Sending is an explicit "I want to watch this": whatever the user was
    // reading further up, their own message re-arms the follow. Drop the
    // anchor too — a stated intent outranks one inferred from a position.
    s.stuckToBottom = true;
    const sendingCell = document.querySelector<HTMLDivElement>(
      `.cell-messages[data-session-id="${s.id}"]`,
    );
    if (sendingCell) dropScrollAnchor(sendingCell);
    s.inFlight = true;
    s.currentAgentMsgId = null;
    s.currentThoughtMsgId = null;
    // Fresh turn → cancel any still-pending linger-clear from the last turn.
    // The task list itself SURVIVES the send: it is a scratchbook, and the work
    // in it outlives the turn that wrote it (todoScratchbook.ts).
    clearTodoLinger(s);
    // t-kgryh1 — a failed sub-agent spawn is a fact about the turn that asked
    // for it; carrying it into an unrelated new turn is noise. Auto-dismiss
    // every failed row still showing at the moment THIS turn starts — the
    // same effect a manual (x) click has (subagentRows.ts's dismissedKeys).
    // Chosen over clearing at `turnDone`: turnDone fires while the turn that
    // PRODUCED the failure is still the one on screen, and would erase the
    // denial before the user has read the reply that follows it — the NEXT
    // turn's start is the earliest moment a stale failure is safe to drop.
    const staleFailedKeys = subagentRows(s.messages, Date.now())
      .filter((r) => r.state === 'failed')
      .map((r) => r.key);
    if (staleFailedKeys.length > 0) {
      s.subagentsDismissed = [...new Set([...(s.subagentsDismissed ?? []), ...staleFailedKeys])];
    }
    // The row goes up NOW, not on the host's echo round trip (why: userEcho.ts).
    s.pendingEcho = echoTextFor(text, mode);
    addMessage(s.id, 'user', 'You', s.pendingEcho);
    vscode.postMessage({ type: 'send', text: text.trim(), sessionId: s.id, mode: mode || undefined });
    sessions = [...sessions];
  }
  function handleCancelForSession(s: ChatSession) {
    if (!s) return;
    vscode.postMessage({ type: 'cancel', sessionId: s.id });
    // Cancel must release EVERY parked ask, not just the one on the bar — a
    // queued ask left unanswered is a tool call hanging on a prompt the user can
    // no longer reach.
    for (const ask of [...(s.permission ? [s.permission] : []), ...s.permissionQueue]) {
      vscode.postMessage({ type: 'permission', toolCallId: ask.toolCallId, optionId: null, sessionId: s.id });
    }
    s.permission = null;
    s.permissionQueue = [];
    // Cancel must visibly release the turn even if the backend is wedged
    // (e.g. a self-review sub-agent that never returns). Drop inFlight and
    // any in-progress plan banner immediately so the user isn't left
    // staring at a "Self-reviewing plan…" spinner forever.
    s.inFlight = false;
    clearInProgressPlan(s);
    sessions = [...sessions];
  }

  // Clear a plan banner that's mid-flight (drafting / self-review /
  // refining) but keep one that's already presented and awaiting the
  // user's approve/reject. Used on cancel + error + disconnect so an
  // interrupted plan turn doesn't leave a forever-spinning banner.
  function clearInProgressPlan(s: ChatSession) {
    if (s.plan && s.plan.status !== 'awaiting_user') {
      s.plan = null;
    }
  }

  // Cancel a pending post-turn overlay-clear timer (see turnDone). Called
  // on a new send / error / disconnect so a stale linger can't wipe the
  // todos of a turn that started before it fired.
  function clearTodoLinger(s: ChatSession) {
    if (s.todoLingerTimer !== null) {
      clearTimeout(s.todoLingerTimer);
      s.todoLingerTimer = null;
    }
  }
  // --- permission queue -------------------------------------------------
  // The bar shows ONE ask at a time; everything else waits its turn instead of
  // overwriting (and silently losing) the ask in front of it.

  /** Park a newly-arrived ask: straight onto the bar if it's free, else queued.
   *  Re-delivery of an ask already known (same toolCallId) is ignored, so a
   *  repeat can't stack a second copy of a prompt the user still hasn't answered. */
  function enqueuePermission(s: ChatSession, ask: PermissionAsk) {
    if (s.permission?.toolCallId === ask.toolCallId) return;
    if (s.permissionQueue.some((q) => q.toolCallId === ask.toolCallId)) return;
    if (s.permission) s.permissionQueue = [...s.permissionQueue, ask];
    else s.permission = ask;
  }

  /** Clear the answered ask and promote the next one — never leave the bar empty
   *  while asks are still waiting, which is the whole stall. */
  function promoteNextPermission(s: ChatSession) {
    s.permission = s.permissionQueue[0] ?? null;
    s.permissionQueue = s.permissionQueue.slice(1);
  }

  function handlePermissionChoiceForSession(
    s: ChatSession,
    toolCallId: string,
    optionId: string | null,
    reviseText?: string,
    answerText?: string,
  ) {
    if (!s) return;
    // answerText rides the reply only when the user typed one into a question's
    // "Other" box; omitted otherwise, so an ordinary approval is unchanged.
    vscode.postMessage({ type: 'permission', toolCallId, optionId, sessionId: s.id, ...(answerText ? { answerText } : {}) });
    promoteNextPermission(s);
    // Plan-mode "Revise": the engine declines the build-switch (stays in plan);
    // queue the user's revision to fire as a fresh plan-mode turn once THIS
    // turn ends (it's still in flight now, so a direct send would be dropped).
    if (reviseText && reviseText.trim()) s.pendingSend = reviseText.trim();
    sessions = [...sessions];
  }
  /** YOLO: stop asking in THIS chat, and answer the ask on screen.
   *
   *  Both halves are the feature. `bypass` is the mode the Approve toggle
   *  already cycles to and it only applies from the NEXT message, so a button
   *  that set it alone would leave the current prompt sitting there — a control
   *  that visibly did nothing. Answering with pickAllowOption's choice (the
   *  host's own preference order: allow_once before allow_always) makes the
   *  click mean what it says without granting more than Approve would have. */
  function handleYoloForSession(s: ChatSession) {
    if (!s?.permission) return;
    const optionId = pickAllowOption(s.permission.options);
    vscode.postMessage({ type: 'setApproveMode', mode: 'bypass', sessionId: s.id });
    // No permissive option at all ⇒ leave the ask alone rather than invent
    // consent or deny on the user's behalf; the mode change still lands.
    if (optionId) handlePermissionChoiceForSession(s, s.permission.toolCallId, optionId);
  }
  function handlePlanActionForSession(s: ChatSession, action: 'approve' | 'reject') {
    if (!s) return;
    vscode.postMessage({
      type: 'planAction',
      action,
      sessionId: s.id,
      planId: s.plan?.planId,
    });
    if (action === 'approve') {
      addMessage(s.id, 'system', 'System', '[plan approved] Switching to execution mode.');
    } else {
      addMessage(s.id, 'system', 'System', '[plan rejected] Plan discarded.');
    }
    s.plan = null;
    sessions = [...sessions];
  }
  function handlePlanRefineForSession(s: ChatSession, feedback: string) {
    if (!s) return;
    vscode.postMessage({
      type: 'planAction',
      action: 'refine',
      feedback,
      sessionId: s.id,
      planId: s.plan?.planId,
    });
    if (s.plan) {
      s.plan.status = 'refining';
      sessions = [...sessions];
    }
  }

  // Phase 6.6 Wave D — user clicked "Pick this plan instead" on a
  // non-winner alternative. Swap the runtime's plan_state.plan to
  // the chosen candidate so subsequent approve/reject targets it.
  function handlePlanSelectAlternativeForSession(s: ChatSession, altIndex: number) {
    if (!s) return;
    vscode.postMessage({
      type: 'planAction',
      action: 'select_alternative',
      altIndex,
      sessionId: s.id,
      planId: s.plan?.planId,
    });
    if (s.plan) {
      const picked = s.plan.alternatives.find(a => a.index === altIndex);
      if (picked) {
        s.plan.title = picked.title;
        s.plan.planId = picked.planId;
      }
      if (s.plan.verdict) {
        s.plan.verdict = { ...s.plan.verdict, winnerIndex: altIndex };
      }
      sessions = [...sessions];
    }
  }

  function requestNewSession() {
    vscode.postMessage({ type: 'newSession' });
  }

  function closeSession(sid: string) {
    vscode.postMessage({ type: 'closeSession', sessionId: sid });
  }

  // Inline tab rename: double-click a tab label to edit; Enter/blur commits,
  // Escape cancels. The engine echoes the new title back via 'sessionTitle',
  // so the committed label reconciles even without an optimistic update.
  let editingTabId: string | null = $state(null);
  let tabDraft = $state('');
  function startRenameTab(s: ChatSession) {
    editingTabId = s.id;
    tabDraft = s.title ?? '';
  }
  function commitRenameTab(s: ChatSession) {
    const title = tabDraft.trim();
    editingTabId = null;
    if (title && title !== (s.title ?? '')) {
      vscode.postMessage({ type: 'renameSession', sessionId: s.id, title });
    }
  }
  function tabRenameKey(e: KeyboardEvent, s: ChatSession) {
    if (e.key === 'Enter') { e.preventDefault(); commitRenameTab(s); }
    else if (e.key === 'Escape') { e.preventDefault(); editingTabId = null; }
  }
  function autofocusInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /**
   * Pillar 3 dashboard upgrade (2026-05-22) — ship the active
   * session's messageLog to the extension host for markdown
   * rendering + Save dialog. Strips image data URLs (big base64
   * payloads bloat the export and aren't useful in markdown) and
   * preserves tool cards so the transcript stays faithful.
   */
  function exportSession(s: ChatSession) {
    const stripped = s.messages.map(m => ({
      kind: m.kind,
      label: m.label,
      text: m.text,
      toolName: m.toolName,
      toolStatus: m.toolStatus,
      toolResult: m.toolResult,
    }));
    vscode.postMessage({
      type: 'exportSession',
      sessionId: s.id,
      agentName: s.agentName,
      messages: stripped,
    });
  }

  // Listen for messages from extension host
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    const sid = msg.sessionId as string | undefined;

    switch (msg.type) {
      case 'sessionCreated': {
        // A catch-up replay re-announces a chat this pane already holds: take
        // what it carries, never a second entry under the same id — the rule,
        // and what it costs to get it wrong, are in sessionReplay.ts.
        const known = getSession(msg.sessionId);
        if (known) { adoptAnnouncement(known, msg); sessions = [...sessions]; activeSessionId = msg.sessionId; break; }
        const newSession: ChatSession = {
          id: msg.sessionId,
          number: msg.sessionNumber,
          agentName: msg.agentName || 'Agent',
          title: typeof msg.title === 'string' && msg.title ? msg.title : undefined,
          agentArt: typeof msg.agentArt === 'string' && msg.agentArt.length > 0
            ? msg.agentArt
            : null,
          needsSetup: !!msg.needsSetup, botGlyph: glyphOf(msg),
          modelName: '',
          messages: [],
          inFlight: false,
          currentAgentMsgId: null,
          currentThoughtMsgId: null,
          permission: null,
          permissionQueue: [],
          plan: null,
          todos: [], todoSource: '', todoLingerTimer: null, taskShape: null, arbiterDecision: null,
          latestTokensUsed: 0, latestContextPct: 0, prevTokensStamped: 0,
        };
        sessions = [...sessions, newSession];
        activeSessionId = msg.sessionId;
        break;
      }
      case 'sessionTitle': {
        const t = typeof msg.title === 'string' && msg.title ? msg.title : undefined;
        sessions = sessions.map(s => s.id === msg.sessionId ? { ...s, title: t } : s);
        break;
      }
      case 'restoreActiveSession': {
        // A solo tab pins its own session (see the $effect); ignore the
        // host's shared active-session pointer here so it can't switch the
        // popped tab to a different chat.
        if (soloSessionId) break;
        // S7 V10 — extension replays the persisted session id on
        // dashboard activation. Only honour it once a matching session
        // has actually been re-created (sessionCreated above), which
        // races; the extension may need to re-send after reattaching
        // sessions. Do nothing if we've never heard of this id.
        if (msg.sessionId && sessions.some(s => s.id === msg.sessionId)) {
          activeSessionId = msg.sessionId;
        }
        break;
      }
      case 'setChatLayout': {
        // Feature 2 — the host restores the persisted sidebar layout (solo vs grid)
        // after reopening the open-set. A solo tab keeps its own single view.
        if (!soloSessionId) chatLayout = msg.grid ? 'grid' : 'single';
        break;
      }
      case 'restoreMessages': {
        // V23 close (cozy-lantern): bulk-replay a saved messageLog
        // into the session's messages array. The rebuild rules live in
        // chatRestore.ts (extracted so they assert without a render) —
        // an entry that kept its tool payload comes back as a real
        // CARD, which is what a RELOADED chat used to lose. Skip when
        // the target session isn't registered yet (race with
        // sessionCreated; extension always posts sessionCreated first
        // so this path is tolerant rather than load-bearing on ordering).
        if (msg.sessionId && Array.isArray(msg.messages)) {
          const idx = sessions.findIndex(s => s.id === msg.sessionId);
          if (idx !== -1 && acceptsReplayedLog(sessions[idx])) { // a log replayed under rows already on screen says the same things twice (sessionReplay.ts)
            sessions[idx].messages = restoreLog(
              sessions[idx].messages,
              msg.messages as RestoredEntry[],
              () => nextMsgId++,
              sessions[idx].agentName,
            );
            sessions = [...sessions];
            scrollToBottom(msg.sessionId);
          }
        }
        break;
      }
      case 'sessionModels': {
        modelBySession = (msg.models && typeof msg.models === 'object') ? msg.models : {};
        break;
      }
      case 'modelStatus': {
        const statusSid = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        if (statusSid) {
          // Per-session: only THIS chat's connectivity/name/provider update.
          onlineBySession = { ...onlineBySession, [statusSid]: !!msg.ok };
          reasonBySession = { ...reasonBySession, [statusSid]: msg.ok ? '' : (msg.reason || '') };
          isVlmBySession = { ...isVlmBySession, [statusSid]: !!msg.isVlm };
          // Guarded: an older host sends no visionState, and defaulting it to
          // 'auto-off' there would paint every model as blind-by-detection.
          if (typeof msg.visionState === 'string') visionStateBySession = { ...visionStateBySession, [statusSid]: msg.visionState as VisionState };
          nameBySession = { ...nameBySession, [statusSid]: msg.ok ? (msg.modelName || '') : '' };
          if (typeof msg.providerLabel === 'string') providerLabelBySession = { ...providerLabelBySession, [statusSid]: msg.providerLabel };
          if (typeof msg.providerIsLocal === 'boolean') providerLocalBySession = { ...providerLocalBySession, [statusSid]: msg.providerIsLocal };
          // The panel-level globals track the ACTIVE session only (header/status
          // bar); a tagged status for a background chat must not stomp them.
          if (statusSid === activeSessionId) {
            modelOnline = !!msg.ok;
            modelReason = msg.ok ? '' : (msg.reason || '');
            isVlm = !!msg.isVlm;
            if (typeof msg.visionState === 'string') visionState = msg.visionState as VisionState;
            modelName = msg.ok ? (msg.modelName || '') : '';
          }
        } else {
          // No sessionId (boot / older host): keep driving the legacy globals.
          modelOnline = !!msg.ok;
          modelReason = msg.ok ? '' : (msg.reason || '');
          isVlm = !!msg.isVlm;
          if (typeof msg.visionState === 'string') visionState = msg.visionState as VisionState;
          modelName = msg.ok ? (msg.modelName || '') : '';
        }
        // Phase 8 of the 2026-04-26 collapse — pick up mode-centric
        // header fields when the extension supplies them. Falls back
        // to existing values when an older extension build sends a
        // modelStatus without these keys.
        if (msg.activeMode === 'normal' || msg.activeMode === 'game') {
          activeMode = msg.activeMode;
        }
        if (typeof msg.defaultModelNormal === 'string') {
          defaultModelNormal = msg.defaultModelNormal;
        }
        if (typeof msg.defaultModelGame === 'string') {
          defaultModelGame = msg.defaultModelGame;
        }
        break;
      }
      case 'sessionClosed': {
        const closing = getSession(msg.sessionId);
        if (closing) clearTodoLinger(closing);
        sessions = sessions.filter(s => s.id !== msg.sessionId); questionAsks = closeAsk(questionAsks, msg.sessionId);
        if (activeSessionId === msg.sessionId) {
          activeSessionId = sessions.length > 0 ? sessions[sessions.length - 1].id : null;
        }
        break;
      }
      case 'showHistory': {
        // The host (palette command / title-bar button) asked to open the
        // history dropdown. Solo tabs have no tab strip, so ignore there.
        if (!soloSessionId) openHistoryDropdown();
        break;
      }
      case 'historyList': {
        historyItems = Array.isArray(msg.sessions) ? msg.sessions : [];
        historyLoading = false;
        break;
      }
      case 'system':
        if (sid) addMessage(sid, 'system', 'System', msg.text || '');
        break;
      case 'busy':
        // Host-driven in-flight: a /loop scheduled run starts outside the send
        // path, so the host flips the composer busy (turnDone clears it as usual).
        if (sid) { const s = getSession(sid); if (s && !s.inFlight) { s.inFlight = true; sessions = [...sessions]; } }
        break;
      case 'firstfoldStart': {
        // /firstfold drives the SAME live todo overlay as a tool turn. Mark the
        // session in-flight so the slide-in shows, and clear any old todos.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        clearTodoLinger(s);
        s.todos = [];
        s.todoSource = 'firstfold';
        s.inFlight = true;
        sessions = [...sessions];
        break;
      }
      case 'firstfoldDone': {
        // Mirror turnDone's todo handling: leave a collapsed one-liner summary
        // inline, linger the overlay briefly, then clear + end in-flight.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        s.inFlight = false;
        if (s.todos.length > 0) {
          const summaryId = nextMsgId++;
          s.messages = [...s.messages, {
            id: summaryId, kind: 'todoSummary', label: 'firstfold', text: '',
            summaryTodos: [...s.todos], timestamp: Date.now(),
          }];
          clearTodoLinger(s);
          s.todoLingerTimer = setTimeout(() => {
            s.todoLingerTimer = null;
            s.todos = [];
            sessions = [...sessions];
          }, 1800);
        }
        // t-r7c757 round 2 — "folded" is workspace-wide: flip EVERY open
        // chat's pinned tip back to rotation live, not just this session's.
        if (typeof msg.needsSetup === 'boolean') {
          for (const x of sessions) x.needsSetup = msg.needsSetup;
        }
        sessions = [...sessions];
        scrollToBottom(sid);
        break;
      }
      case 'echoUser': {
        const echoImages = Array.isArray(msg.images) ? msg.images as string[] : undefined;
        // Confirmation of the row drawn at send ⇒ nothing to draw (userEcho.ts).
        if (sid && consumeEcho(getSession(sid), msg.text || '')) break;
        if (sid) addMessage(sid, 'user', 'You', msg.text || '', echoImages);
        break;
      }
      case 'peerMessage': {
        // Another agent's handoff. The reply address is provenance, not
        // decoration: an agent that cannot see it cannot answer.
        if (sid) addMessage(sid, 'peer', String(msg.from || 'agent'), String(msg.text || ''),
          undefined, undefined, { peerReplyTo: String(msg.replyTo || '') });
        break;
      }
      case 'revertDone': {
        // The engine rejected the rewind — un-trim (restore the optimistic stash).
        if (!sid) break;
        const s = getSession(sid);
        if (s && msg.ok === false && s.revertStash) {
          s.messages = [...s.messages, ...s.revertStash];
          s.revertStash = undefined;
        }
        break;
      }
      case 'revertUndone': {
        // unrevert confirmed — bring the stashed tail back into the transcript.
        if (!sid) break;
        const s = getSession(sid);
        if (s && msg.ok !== false && s.revertStash) {
          s.messages = [...s.messages, ...s.revertStash];
          s.revertStash = undefined;
        }
        break;
      }
      case 'agentText': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        // Prose starting closes any open reasoning stream so a later thinking
        // burst opens a fresh block below this answer, not appended to it.
        s.currentThoughtMsgId = null;
        const engineMsgId = typeof msg.messageId === 'string' ? msg.messageId : undefined;
        // A delta for a DIFFERENT engine message SEALS the open bubble (agentStreamSeal.ts).
        if (sealsOpenBubble(s.messages, s.currentAgentMsgId, engineMsgId)) s.currentAgentMsgId = null;
        if (s.currentAgentMsgId === null) {
          s.currentAgentMsgId = addMessage(sid, 'agent', s.agentName, msg.text || '', undefined, engineMsgId);
        } else {
          appendToMessage(sid, s.currentAgentMsgId, msg.text || '');
          // Late-arriving id (first chunk lacked it): stamp the streaming bubble
          // so its rewind anchor is set once the engine id is known.
          if (engineMsgId) {
            s.messages = s.messages.map(mm =>
              mm.id === s.currentAgentMsgId && !mm.engineMsgId ? { ...mm, engineMsgId } : mm
            );
          }
        }
        break;
      }
      case 'agentThought': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        // Reasoning is its own stream. Close any open prose message so the
        // thought renders as a standalone collapsed block, then accumulate
        // deltas into the current thought message (one per thinking burst).
        s.currentAgentMsgId = null;
        if (s.currentThoughtMsgId === null) {
          s.currentThoughtMsgId = addMessage(sid, 'thought', 'Thinking', msg.text || '');
        } else {
          appendToMessage(sid, s.currentThoughtMsgId, msg.text || '');
        }
        break;
      }
      case 'compactionStart': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        // Posted by DashboardPanel the instant /compact is clicked — so the
        // marker ALWAYS appears, even when the summary streams no text (a tiny
        // session that compacts to nothing). Close open streams so it stands
        // alone; its carried-forward body fills from the compactionChunk deltas.
        s.currentAgentMsgId = null;
        s.currentThoughtMsgId = null;
        const cid = addMessage(sid, 'compacted', 'Compacting', '');
        s.messages = s.messages.map((m) => (m.id === cid ? { ...m, compacting: true } : m));
        break;
      }
      case 'compactionChunk': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        // The /compact summary streams here (engine-tagged _meta.origami_compaction).
        // Collapse it into ONE "Compaction Completed" marker: its chunks arrive
        // contiguously, so the last message already being 'compacted' means the
        // same compaction is still streaming — append; otherwise open a fresh
        // marker. Close any open prose/thought stream so the marker stands alone.
        s.currentAgentMsgId = null;
        s.currentThoughtMsgId = null;
        const last = s.messages[s.messages.length - 1];
        if (last && last.kind === 'compacted') {
          appendToMessage(sid, last.id, msg.text || '');
        } else {
          // Open the marker in its LIVE state so it reads as a compaction event
          // in progress; turnDone settles it to "Compaction Completed".
          const cid = addMessage(sid, 'compacted', 'Compacting', msg.text || '');
          s.messages = s.messages.map((m) => (m.id === cid ? { ...m, compacting: true } : m));
        }
        break;
      }
      case 'compactionEnd': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        if (msg.ok === false) {
          // Compaction failed — drop the live marker (error toast surfaces
          // separately) rather than leave a phantom "Completed" row.
          s.messages = s.messages.filter((m) => !(m.kind === 'compacted' && m.compacting));
        } else {
          // Settle the marker the MOMENT compaction finishes — the manual
          // /compact turn emits no turnDone, so this (not the next real turn's
          // turnDone) is what flips "Compacting…" to "Compaction Completed".
          s.messages = s.messages.map((m) =>
            m.kind === 'compacted' && m.compacting ? { ...m, compacting: false } : m,
          );
        }
        break;
      }
      case 'agentImage': {
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        const dataUrl = `data:${msg.mimeType || 'image/png'};base64,${msg.data || ''}`;
        // Add image as a special agent message with an img tag
        addMessage(sid, 'agent', s.agentName, `![image](${dataUrl})`);
        break;
      }
      case 'toolCall': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // Append + shell-detail shaping live in chatToolMsg.ts (extracted
          // when this file sat at its cap); the side effects stay here.
          s.messages = applyToolCall(s.messages, msg, nextMsgId++);
          // Close the open agent-text message so any prose the model
          // streams AFTER this tool starts a FRESH message appended below
          // the card — preserving the real text→tool→text interleave.
          // Without this, post-tool text appended back into the pre-tool
          // message and rendered ABOVE the card (the out-of-sequence bug).
          s.currentAgentMsgId = null;
          s.currentThoughtMsgId = null;
          scrollToBottom(sid);
        }
        break;
      }
      case 'toolResult': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // Merge by toolCallId — or a detached fallback row when the result
          // beat its call. Rules + shell facts: chatToolMsg.ts.
          s.messages = applyToolResult(s.messages, msg, nextMsgId++);
          scrollToBottom(sid);
        }
        break;
      }
      case 'subagentChunk': {
        // Live output from a sub-agent, forwarded under the parent session and
        // tagged with the CHILD's id. Where it lands (and what a drop means)
        // is subagentInbox.ts.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        const child = childId(msg.childSessionId);
        const card = cardForChild(s.messages, child);
        if (!card) { warnSubagentDrop('chunk', child); break; }
        card.taskStream = cappedStream(card.taskStream, msg.text || '');
        s.messages = [...s.messages]; // trigger reactivity
        break;
      }
      case 'subagentDone': {
        // A DETACHED sub-agent finished. Its launcher card reached `completed`
        // the moment it was spawned, so this marker is the only thing that
        // retires the drawer row. Stamp the card the row is derived from — one
        // source of truth, same as every other field here.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        const child = childId(msg.taskSessionId);
        const card = cardForChild(s.messages, child);
        // A LOST marker is a row that never retires, so this drop is the one
        // that has to be loud.
        if (!card) { warnSubagentDrop('done', child); break; }
        card.taskDone = msg.state === 'error' ? 'error' : 'completed';
        // The child's only honest END (its launcher's own ended at spawn), so
        // the row can print a settled total instead of ageing off the wall
        // clock for as long as a SIBLING agent keeps the drawer's tick alive.
        // First marker wins — the injected turn can re-emit (taskRiders.ts).
        if (typeof msg.endedAt === 'number' && card.taskEndedAt === undefined) card.taskEndedAt = msg.endedAt;
        s.messages = [...s.messages]; // trigger reactivity
        break;
      }
      case 'requestPermission': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // Question-shaped asks bypass the permission queue entirely and open
          // the modal. `msg.questions` is the whole batch; without it (an engine
          // that predates batching) title+options ARE the one question.
          if (isQuestionShaped(msg.options || [])) {
            questionAsks = openAsk(questionAsks, sid, msg.toolCallId,
              msg.questions?.length ? msg.questions : [{ title: msg.title, options: msg.options || [] }]);
          } else {
            enqueuePermission(s, {
              toolCallId: msg.toolCallId,
              title: msg.title,
              options: msg.options || [],
              target: msg.target,
              action: msg.kind,
              command: msg.command,
            });
            sessions = [...sessions];
          }
        }
        break;
      }
      case 'planStatus': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // 'turn_end' (or any empty/non-plan status) is the backend's
          // end-of-turn marker, NOT a real plan phase. Clear an
          // in-progress banner rather than inventing a 'self_review'.
          // This was the phantom-banner bug: an empty status used to
          // default to 'self_review', so every turn (even "hello")
          // showed "Self-reviewing plan…".
          if (!msg.status || msg.status === 'turn_end' || msg.status === 'ended') {
            clearInProgressPlan(s);
            break;
          }
          if (s.plan) {
            s.plan.status = msg.status;
            s.plan.revisionCount = msg.revisionCount ?? s.plan.revisionCount;
          } else {
            s.plan = {
              planId: msg.planId || '',
              title: '',
              filePath: '',
              status: msg.status,
              revisionCount: msg.revisionCount ?? 0,
              alternatives: [],
              verdict: null,
            };
          }
        }
        break;
      }
      case 'todoUpdate': {
        // Live todo snapshot mirroring the harness-owned tracker.
        // Wholesale replacement (the bridge sends the full list each
        // time), so we overwrite `s.todos` rather than diffing.
        // Reactive $state assignment triggers the TodoStrip re-render.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          s.todos = Array.isArray(msg.todos) ? msg.todos : [];
          s.todoSource = msg.source ?? '';
          // Belt-and-suspenders: re-trigger the {#each visibleCells}
          // derived so the overlay {#if} re-evaluates on EVERY cycle, not
          // just the first (deep-proxy mutation should suffice, but a
          // fresh array reference guarantees the slide-in re-mounts).
          sessions = [...sessions];
        }
        break;
      }
      case 'arbiterDecision': {
        // M1 followable surface — the SINGLE per-turn arbiter verdict.
        // Wholesale replacement: exactly one decision is shown at a
        // time (the latest), never a stack of gate firings.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          const raw = String(msg.decision ?? '');
          // Honest mapping: a recognised decision is kept; an
          // UNRECOGNISED label is surfaced as `unknown` (rendered
          // literally), NEVER silently promoted to the benign
          // `continue`. That false-green collapse is the exact
          // dishonesty the arbiter exists to prevent.
          const decision =
            raw === 'done' || raw === 'continue' || raw === 'ask_user' || raw === 'incomplete'
              ? raw
              : 'unknown';
          s.arbiterDecision = { decision, reason: String(msg.reason ?? '') };
        }
        break;
      }
      case 'turnVerdict': {
        // First-class `origami/turnEnd` stop_reason → the honest
        // per-turn TERMINAL verdict. Two surfaces, both anchored to
        // THIS turn:
        //   1) upgrade the floating arbiter chip to `incomplete` when
        //      the terminal was an error/park (the bridge's
        //      arbiterDecision collapses those to `continue`; the real
        //      stop_reason corrects that lie).
        //   2) append an inline verdict row at the end of the turn's
        //      messages so the history shows what each turn actually
        //      resolved to — not a single replaced-in-place chip.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          const verdict = verdictForStopReason(String(msg.stopReason ?? ''));
          // (1) chip upgrade — only sharpen toward honesty (an error
          // terminal must not read as Continue); never downgrade a
          // recognised non-error decision.
          if (verdict.kind === 'incomplete') {
            s.arbiterDecision = { decision: 'incomplete', reason: verdict.reason };
          } else if (verdict.kind === 'done' && !s.arbiterDecision) {
            s.arbiterDecision = { decision: 'done', reason: verdict.reason };
          }
          // (2) inline verdict row, anchored at the end of the turn.
          const id = nextMsgId++;
          s.messages = [...s.messages, {
            id,
            kind: 'verdict',
            label: 'verdict',
            text: verdictLabel(verdict),
            verdict,
            timestamp: Date.now(),
          }];
        }
        break;
      }
      case 'taskShape': {
        // Phase 1 dashboard upgrade (2026-05-22) — Phase 6.5 task
        // decomposition. Closes the long-standing drop-on-floor
        // wire. Same wholesale-replacement pattern as todoUpdate.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          const subs = Array.isArray(msg.subTasks) ? msg.subTasks : [];
          s.taskShape = {
            source: msg.source ?? 'heuristic',
            truncatedExtra: Number(msg.truncatedExtra ?? 0),
            subTasks: subs,
          };
        }
        break;
      }
      case 'contextUpdate': {
        // Pillar 3 dashboard upgrade (2026-05-22) — track cumulative
        // tokens per session so `turnDone` can stamp the value onto
        // the just-completed agent message. InputBar listens to the
        // same message independently for its gauge. The session
        // payload arrives once at create-time + after every turn.
        if (!sid) break;
        const s = getSession(sid);
        if (s && typeof msg.tokensUsed === 'number') {
          s.latestTokensUsed = msg.tokensUsed;
        }
        // B9 — capture context fill % from the same event the InputBar
        // gauge uses, so we can stamp it per-turn.
        if (s && typeof msg.contextUsed === 'number' && typeof msg.contextTotal === 'number' && msg.contextTotal > 0) {
          s.latestContextPct = Math.round((msg.contextUsed / msg.contextTotal) * 100);
        }
        break;
      }
      case 'planReady': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // Phase 6.6 Wave D — preserve any alternatives/verdict from
          // a prior bestOfNComplete that arrived first. Critic verdict
          // fires slightly before planReady, so the alternatives may
          // already be populated.
          const existingAlts = s.plan?.alternatives ?? [];
          const existingVerdict = s.plan?.verdict ?? null;
          s.plan = {
            planId: msg.planId || '',
            title: msg.title || '',
            filePath: msg.filePath || '',
            status: msg.status || 'awaiting_user',
            revisionCount: msg.revisionCount ?? 0,
            alternatives: existingAlts,
            verdict: existingVerdict,
          };
          s.inFlight = false;
        }
        scrollToBottom(sid);
        break;
      }
      case 'bestOfNComplete': {
        // Phase 6.6 Wave D — critic verdict + scored alternatives
        // land on the active plan so PlanPanel can render the tab
        // bar. If the plan isn't staged yet (planReady hasn't fired)
        // we stash them on a placeholder so planReady picks them up.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        const rawAlts = Array.isArray(msg.alternatives)
          ? (msg.alternatives as unknown[])
          : [];
        const alternatives: PlanCandidateView[] = rawAlts
          .map(raw => {
            const a = raw as Record<string, unknown>;
            const rawScore = a.score as Record<string, unknown> | null | undefined;
            const score: PlanScoreView | null = rawScore
              ? {
                  feasibility: Number(rawScore.feasibility ?? 0),
                  specificity: Number(rawScore.specificity ?? 0),
                  riskCoverage: Number(rawScore.riskCoverage ?? rawScore.risk_coverage ?? 0),
                  total: Number(rawScore.total ?? 0),
                  notes: String(rawScore.notes ?? ''),
                }
              : null;
            return {
              index: Number(a.index ?? 0),
              title: String(a.title ?? ''),
              planId: String(a.planId ?? a.plan_id ?? ''),
              textPreview: String(a.textPreview ?? a.text_preview ?? ''),
              score,
            };
          });
        const verdict: BestOfNVerdictView = {
          winnerIndex: Number(msg.winnerIndex ?? 0),
          rationale: String(msg.rationale ?? ''),
          fallback: Boolean(msg.fallback),
        };
        if (s.plan) {
          s.plan.alternatives = alternatives;
          s.plan.verdict = verdict;
        } else {
          s.plan = {
            planId: '',
            title: '',
            filePath: '',
            status: 'self_review',
            revisionCount: 0,
            alternatives,
            verdict,
          };
        }
        sessions = [...sessions];
        break;
      }
      case 'turnDone': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          s.currentAgentMsgId = null;
          s.currentThoughtMsgId = null;
          // A /compact turn just ended — settle its live "Compacting" marker
          // into the "Compaction Completed" state.
          if (s.messages.some((m) => m.kind === 'compacted' && m.compacting)) {
            s.messages = s.messages.map((m) =>
              m.kind === 'compacted' && m.compacting ? { ...m, compacting: false } : m,
            );
          }
          s.inFlight = false; s.pendingEcho = null; // turn over: no echo still owed (interjections are resolved at the END of this case)
          // A plan-mode "Revise" revision was waiting on this turn — the defer
          // that keeps it off the old turn lives in queuedFlush.ts.
          flushQueuedSend(s, handleSendForSession);
          // COMPLETION retires the list, not the turn boundary: leave the
          // collapsed one-liner in history, hold the panel for a short LINGER
          // (so a turn whose model wrote its todos all-at-once at the very end
          // still flashes rather than appearing for ~0ms), then clear. A list
          // with work OUTSTANDING is left alone — it stays on screen across the
          // turn end, and a second snapshot per turn would only spam history.
          if (s.todos.length > 0 && !hasOpenWork(s.todos)) {
            const summaryId = nextMsgId++;
            s.messages = [...s.messages, {
              id: summaryId,
              kind: 'todoSummary',
              label: 'todos',
              text: '',
              summaryTodos: [...s.todos],
              timestamp: Date.now(),
            }];
            clearTodoLinger(s);
            s.todoLingerTimer = setTimeout(() => {
              s.todoLingerTimer = null;
              s.todos = [];
              sessions = [...sessions];
            }, 1800);
          }
          // Pillar 3 — stamp the cumulative token count onto the
          // last agent message of this turn so the user can hover
          // historical messages and see how expensive the
          // conversation was at each point.
          if (s.latestTokensUsed > 0) {
            for (let i = s.messages.length - 1; i >= 0; i--) {
              const m = s.messages[i];
              if (m.kind === 'agent') {
                m.tokensAtTurn = s.latestTokensUsed;
                // B9 — per-turn spend = cumulative delta since last turn.
                const delta = s.latestTokensUsed - s.prevTokensStamped;
                if (delta > 0) m.tokensThisTurn = delta;
                if (s.latestContextPct > 0) m.ctxPctAtTurn = s.latestContextPct;
                s.prevTokensStamped = s.latestTokensUsed;
                s.messages = [...s.messages];
                break;
              }
              // Stop scanning past the most recent user message —
              // we want the agent of THIS turn, not the previous.
              if (m.kind === 'user') break;
            }
          }
          // The turn ended with interjections still unanswered — the host round
          // trip lost the race. They were typed, so they keep their rows, here
          // at the end, which is as far into the turn as they ever got. LAST in
          // this case on purpose: the token stamp above walks back to the turn's
          // final agent row and stops at the first user one, so a row added
          // before it would hide the message it means to stamp.
          for (const late of drainInterject(s)) addMessage(sid, 'user', 'You', late);
        }
        break;
      }
      case 'error':
        if (sid) {
          const s = getSession(sid);
          // A REJECTED interjection still gets its row, drawn immediately above
          // the failure that explains it: the user's words stay in the
          // transcript where they were typed, and the split they caused is
          // annotated rather than silent (interjectSplit.ts). UNLESS the line
          // never reached the engine at all (interjectRetry.ts) — then there is
          // no split to annotate and the words are owed a turn, so they go out
          // as a fresh prompt. LAST, and NOT deferred: this case releases the
          // old turn below, and a `setTimeout` would let two refusals land back
          // to back and the second retry find the first one's turn already in
          // flight — which handleSendForSession drops without a word.
          const line = s ? resolveInterject(s) : null;
          const retry = !!line && retryAsPrompt(msg.message || '');
          if (line && !retry) addMessage(sid, 'user', 'You', line);
          addMessage(sid, 'error', 'Error', msg.message || '');
          if (s) { s.inFlight = false; clearInProgressPlan(s); clearTodoLinger(s); }
          if (retry) handleSendForSession(s!, line!);
        }
        break;
      case 'imageError':
        // Phase 1 dashboard upgrade (2026-05-22) — pair with the toast
        // shown by DashboardPanel.ts so the failure persists in chat
        // history after the toast dismisses. No inFlight flag flip:
        // image errors fire from InputBar paste/drop, not from a
        // turn-in-flight, so the session is already idle.
        if (sid) {
          addMessage(sid, 'system', '[image]', msg.message || 'Image error');
        }
        break;
      case 'agentSwitched': {
        if (!sid) break;
        const s = getSession(sid);
        if (s && msg.agentName) {
          s.agentName = String(msg.agentName);
          sessions = [...sessions]; // trigger reactivity
        }
        break;
      }
      case 'peerName': {
        if (!sid) break;
        const s = getSession(sid);
        if (s && typeof msg.peerName === 'string' && msg.peerName) {
          s.peerName = msg.peerName;
          sessions = [...sessions]; // trigger reactivity
        }
        break;
      }
      case 'closed':
        if (sid) {
          const s = getSession(sid);
          if (s) for (const line of drainInterject(s)) addMessage(sid, 'user', 'You', line); // the engine is gone: every outstanding line keeps its place
          addMessage(sid, 'error', 'Disconnected', msg.reason || '');
          if (s) { s.inFlight = false; clearInProgressPlan(s); clearTodoLinger(s); }
        }
        break;
      // The host confirmed the interjection reached the running turn (turnMessages.ts).
      // The row goes in HERE, not at the click: this is the point in the stream
      // the turn actually took the line, and drawing it here is what seals the
      // bubble above it so the deltas that follow open a fresh one BELOW
      // (addMessage + interjectSplit.ts).
      case 'interjected': { const s = sid ? getSession(sid) : null; if (s) { const line = resolveInterject(s); if (line) addMessage(sid!, 'user', 'You', line); sessions = [...sessions]; } break; }
    }
  });
</script>

<div class="chat-pane">
  <!-- Session tabs -->
  {#if sessions.length > 0 && !soloSessionId}
    <div class="session-tabs">
      {#each sessions as s (s.id)}
        <div
          class="session-tab"
          class:active={s.id === activeSessionId} class:tab-waiting={isTabWaiting(!!questionAsks[s.id], !!s.permission || s.permissionQueue.length > 0)}
          role="tab"
          tabindex="0"
          aria-selected={s.id === activeSessionId}
          onclick={() => activeSessionId = s.id}
          ondblclick={(e) => { e.stopPropagation(); startRenameTab(s); }}
          title="Double-click to rename"
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activeSessionId = s.id; } }}><span class="tab-crane" aria-hidden="true"><CraneMark size={11} /></span>
          {#if editingTabId === s.id}
            <input
              class="tab-rename"
              bind:value={tabDraft}
              use:autofocusInput
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => tabRenameKey(e, s)}
              onblur={() => commitRenameTab(s)}
              aria-label="Rename chat" />
          {:else}
            <span class="tab-label">#{s.number} {s.agentName}{s.title ? ': ' + s.title : ''}{#if s.peerName}<span class="peer-name"> · {s.peerName}</span>{/if}</span>
          {/if}
          <button class="tab-popout" onclick={(e) => { e.stopPropagation(); popOutSession(s.id); }} title="Open this chat in its own movable tab">⤢</button>
          {#if sessions.length > 1}
            <button class="tab-close" onclick={(e) => { e.stopPropagation(); closeSession(s.id); }} title="Close session">&times;</button>
          {/if}
        </div>
      {/each}
      <button class="new-tab-btn" onclick={requestNewSession} title="New session">+</button>
      <!-- History recall — opens the in-webview searchable dropdown below
           (no native QuickPick / toast). -->
      <button class="history-btn" class:active={historyOpen} onclick={toggleHistory} title="Recall a past chat">⟲</button>
      <!-- Layout cycler: single ⇄ grid (all chats tiled, uncapped).
           Disabled in single mode until a second chat exists. -->
      <button
        class="grid-toggle-btn"
        class:active={chatLayout !== 'single'}
        disabled={sessions.length < 2 && chatLayout === 'single'}
        onclick={cycleChatLayout}
        title={
          sessions.length < 2 && chatLayout === 'single'
            ? 'Open a second chat to enable the grid view'
            : chatLayout === 'single'
              ? 'Switch to grid view (all chats, tiled)'
              : 'Switch back to single-chat view'
        }
      >{chatLayoutGlyph(chatLayout)}</button>
      <!-- Pillar 3 (2026-05-22) — export the active session's
           message log as a markdown transcript. Disabled when the
           session has no messages yet so we don't write an empty
           file. The actual rendering + Save dialog happens
           extension-side; we ship the messageLog across the wire
           because the extension host doesn't keep a live mirror. -->
      {#if activeSession}
        <button
          class="export-btn"
          disabled={activeSession.messages.length === 0}
          onclick={() => activeSession && exportSession(activeSession)}
          title="Export this session as markdown"
        >⤓</button>
      {/if}
    </div>
  {/if}

  <!-- In-webview history dropdown — a searchable list of past chats,
       replacing the native QuickPick + "no past sessions" toast. Opened by
       the ⟲ button or the palette/title-bar command; a click-catching
       backdrop closes it; picking a row loadSession-recalls that chat. -->
  {#if historyOpen && !soloSessionId}
    <div class="history-backdrop" onclick={() => historyOpen = false} role="presentation"></div>
    <div class="history-dropdown" role="dialog" aria-label="Past chats">
      <input
        class="history-search"
        type="text"
        placeholder="Search past chats…"
        bind:value={historyQuery}
        use:focusOnMount
        onkeydown={(e) => { if (e.key === 'Escape') historyOpen = false; }}
      />
      <div class="history-list">
        {#if historyLoading}
          <div class="history-empty">Loading…</div>
        {:else if historyFiltered.length === 0}
          <div class="history-empty">{historyItems.length === 0 ? 'No past chats yet.' : 'No matches.'}</div>
        {:else}
          {#each historyFiltered as h (h.sessionId)}
            <button class="history-row" onclick={() => recallSession(h.sessionId)} title={h.sessionId}>
              <span class="history-title">{h.title}</span>
              {#if h.folder || h.updatedAt}
                <span class="history-meta">{[h.folder, fmtHistoryDate(h.updatedAt)].filter(Boolean).join(' · ')}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <!-- V17 close (cozy-lantern): unified cell renderer. Each cell is a
       fully-independent agent chat — its own messages stream, its own
       PermissionBar / PlanPanel mounted inline, and
       its own InputBar bound to that session's id. The active session
       gets a subtle outline so the user can still tell which one
       holds image-paste / persistence focus, but every cell accepts
       input. -->
  <div
    class="chat-grid"
    class:layout-single={chatLayout === 'single'}
    class:layout-grid={chatLayout === 'grid'}
  >
    {#each visibleCells as cellSession (cellSession.id)}
      <div
        class="chat-cell" data-session-id={cellSession.id}
        class:active={cellSession.id === activeSessionId}
        class:single={chatLayout === 'single'}
      >
        <!-- Header only shows in multi-up modes; in single-mode the session
             tabs above convey identity — except a solo popped-out tab (strip
             hidden too), which gets a quiet peer-name label instead. Click
             promotes this cell to activeSessionId for image-paste etc. -->
        {#if chatLayout !== 'single'}
          <div
            class="cell-header"
            onclick={() => activeSessionId = cellSession.id}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activeSessionId = cellSession.id; } }}
            role="button"
            tabindex="0"
          >
            <span class="cell-tag">#{cellSession.number}</span>
            <span class="cell-agent">{cellSession.agentName}{cellSession.title ? ': ' + cellSession.title : ''}</span>
            {#if cellSession.peerName}<span class="cell-peer-name">{cellSession.peerName}</span>{/if}
            {#if cellSession.inFlight}
              <span class="cell-pulse" aria-label="in flight">●</span>
            {/if}
          </div>
        {:else if cellSession.peerName}
          <div class="solo-peer-name">{cellSession.peerName}</div>
        {/if}

        <!-- Live task list (TodoOverlay.svelte owns the panel + its geometry).
             Shown while the list still has OPEN WORK — across turn boundaries, and
             on a session recalled from the engine's durable snapshot — plus while
             in flight / lingering so a late all-at-once todowrite still flashes.
             The rule and the defect it fixes live in todoScratchbook.ts. -->
        {#if todoOverlayVisible(cellSession.inFlight, cellSession.todoLingerTimer !== null, cellSession.todos)}
          <TodoOverlay
            todos={cellSession.todos}
            source={cellSession.todoSource}
            collapsed={cellSession.todosCollapsed ?? false}
            onToggleCollapse={() => { cellSession.todosCollapsed = !(cellSession.todosCollapsed ?? false); sessions = [...sessions]; }}
          />
        {/if}

        <!-- M1 followable surface — the single per-turn arbiter decision.
             Exactly one chip; a watcher reads Done | Continue | AskUser
             with its reason, never a stack of gate firings (F3). -->
        {#if cellSession.arbiterDecision}
          {@const d = cellSession.arbiterDecision}
          <div class="arbiter-chip arbiter-{d.decision}" title={d.reason}>
            <span class="arbiter-label">
              {#if d.decision === 'done'}Done
              {:else if d.decision === 'ask_user'}Ask user
              {:else if d.decision === 'incomplete'}Incomplete
              {:else if d.decision === 'continue'}Continue
              {:else}Ended{/if}
            </span>
            {#if d.reason}<span class="arbiter-reason">{d.reason}</span>{/if}
          </div>
        {/if}

        <!-- The [shape] heuristic sub-task decomposition is intentionally
             NOT rendered: it duplicates the model's own todos (TodoStrip
             above), never updates its status (always 0/N), and its labels
             leak plan/execution-directive text. It's internal scaffolding,
             not a user-facing checklist. Data still flows on taskShape for
             diagnostics; we just don't surface a confusing second list. -->

        <!-- The sub-agents this chat has out, opposite the todo overlay. Derived
             from the transcript's own `task` cards — no second wire, so it
             cannot disagree with the tool card it was read from. The rows and
             their live ages are SubagentDock.svelte's. -->
        <SubagentDock
          messages={cellSession.messages}
          dismissed={cellSession.subagentsDismissed ?? []}
          open={cellSession.subagentsOpen ?? false}
          onToggle={() => { cellSession.subagentsOpen = !(cellSession.subagentsOpen ?? false); sessions = [...sessions]; }}
          onDismiss={(key) => { cellSession.subagentsDismissed = [...(cellSession.subagentsDismissed ?? []), key]; sessions = [...sessions]; }}
        />

        <!-- Ctrl+F. Mounted OUTSIDE the scroller below, or the search would walk
             the bar's own text; it claims the key for itself (ChatFind.svelte). -->
        <ChatFind sessionId={cellSession.id} />
        <div class="cell-messages" data-session-id={cellSession.id} bind:this={messagesEl}
          onwheel={(ev) => onMessagesWheel(cellSession, ev)}
          onscroll={(ev) => onMessagesScroll(cellSession, ev)}>
          <!-- Tweak 2 — mirror the most-recent user message as a sticky header.
               NOT gated on inFlight: it persists from send through the response
               and only changes when a NEW user message replaces it. A mirror
               only — the real row stays below; empty text renders nothing. -->
          <PinnedUserMessage text={pinnedMirrorText(cellSession.messages)} />
          {#if cellSession.agentArt && chatLayout === 'single'}
            <!-- S8 V16 — agent banner art, single-mode only (no room
                 for it in multi-up cells). -->
            <pre class="agent-banner" data-agent={cellSession.agentName}>{cellSession.agentArt}</pre>
          {/if}
          <ChatTranscript
            messages={cellSession.messages}
            sessionId={cellSession.id}
            inFlight={cellSession.inFlight}
            currentThoughtMsgId={cellSession.currentThoughtMsgId}
            currentAgentMsgId={cellSession.currentAgentMsgId}
            openThoughtIds={cellSession.openThoughtIds}
            onThoughtOpenIds={(ids) => (cellSession.openThoughtIds = ids)}
            onImageClick={openLightbox}
            onRewind={rewindTo}
            focusMode={cellSession.focusMode ?? false}
          />
          {#if cellSession.revertStash && cellSession.revertStash.length > 0}
            <!-- Staged-rewind banner: the working tree is restored; the dropped
                 turns are gone on the next message. Undo (unrevert) until then. -->
            <div class="rewind-undo">
              <span class="rewind-undo-text">&#8630; Rewound — files restored. {cellSession.revertStash.length} message{cellSession.revertStash.length !== 1 ? 's' : ''} dropped; sending finalises it.</span>
              <button class="rewind-undo-btn" onclick={() => undoRewind(cellSession.id)}>Undo</button>
            </div>
          {/if}
          {#if !hasConversation(cellSession)}
            <!-- Empty state / new-workspace onboarding — shown until the first
                 real turn. ChatEmptyState.svelte owns the crane + rotating tip
                 (t-r7c757) / offline setup guidance; the HONEST online check
                 (real modelStatus broadcast) stays here since it needs
                 cellSession + the panel-level fallbacks. -->
            <ChatEmptyState
              online={onlineBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelOnline : false)}
              providerLocal={providerLocalBySession[cellSession.id] ?? true}
              providerLabel={providerLabelBySession[cellSession.id] || ''}
              needsSetup={cellSession.needsSetup} botGlyph={cellSession.botGlyph}
            />
          {/if}
          {#if cellSession.inFlight}
            <!-- B5 — driven by the per-session inFlight flag, which is
                 set on send and cleared on done/error/blocked from real
                 ACP events, so it can't out-live the turn. -->
            <div class="stream-indicator">
              <ThinkingGlyph active={cellSession.inFlight} />
              <LoadingCycler active phrases={['thinking…', 'reasoning…', 'working…', 'composing…']} />
            </div>
          {/if}
        </div>

        {#if cellSession.permission}
          <PermissionBar
              title={cellSession.permission.title}
              options={cellSession.permission.options}
              target={cellSession.permission.target}
              action={cellSession.permission.action}
              command={cellSession.permission.command}
              waiting={cellSession.permissionQueue.length}
              onChoice={(optionId, reviseText, answerText) => handlePermissionChoiceForSession(cellSession, cellSession.permission!.toolCallId, optionId, reviseText, answerText)}
              onYolo={() => handleYoloForSession(cellSession)}
            />
        {/if}

        {#if cellSession.plan}
          <PlanPanel
            planId={cellSession.plan.planId}
            title={cellSession.plan.title}
            filePath={cellSession.plan.filePath}
            status={cellSession.plan.status}
            revisionCount={cellSession.plan.revisionCount}
            alternatives={cellSession.plan.alternatives}
            verdict={cellSession.plan.verdict}
            onApprove={() => handlePlanActionForSession(cellSession, 'approve')}
            onReject={() => handlePlanActionForSession(cellSession, 'reject')}
            onRefine={(feedback) => handlePlanRefineForSession(cellSession, feedback)}
            onSelectAlternative={(altIndex) => handlePlanSelectAlternativeForSession(cellSession, altIndex)}
            onOpenFile={(path) => vscode.postMessage({ type: 'openAbsoluteFile', path })}
          />
        {/if}

        <!-- `changes` is DERIVED per cell from that cell's own transcript, never
             from a running counter: a template expression IS a $derived, so it
             recomputes when those messages change and rebuilds itself after a
             webview reload — a live tally would silently restart at zero. -->
        <InputBar
          inFlight={cellSession.inFlight}
          agentName={cellSession.agentName}
          modelName={prettyModel(modelBySession[cellSession.id]) || nameBySession[cellSession.id] || (cellSession.id === activeSessionId ? modelName : '')}
          modelOnline={onlineBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelOnline : false)}
          modelReason={reasonBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelReason : '')}
          isVlm={isVlmBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? isVlm : false)}
          visionState={visionStateBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? visionState : 'auto-off')}
          providerLabel={providerLabelBySession[cellSession.id] ?? ''}
          providerIsLocal={providerLocalBySession[cellSession.id] ?? true}
          sessionId={cellSession.id}
          onImageClick={openLightbox}
          onCompact={() => (compactConfirmId = cellSession.id)}
          onSend={(text, mode) => handleSendForSession(cellSession, text, mode)}
          onCancel={() => handleCancelForSession(cellSession)}
          onExport={() => exportSession(cellSession)}
          canExport={cellSession.messages.length > 0}
          interjecting={cellSession.interjecting ?? false}
          changes={aggregateSessionChanges(cellSession.messages)}
          focused={cellSession.focusMode ?? false}
          onToggleFocus={() => { cellSession.focusMode = !(cellSession.focusMode ?? false); }}
          onInterject={(text) => { armInterject(cellSession, text); sessions = [...sessions]; vscode.postMessage({ type: 'interject', sessionId: cellSession.id, text }); }}
        />
      </div>
    {/each}
    {#if visibleCells.length === 0}
      <div class="empty">No session</div>
    {/if}
  </div>

  <ConfirmModal
    open={compactConfirmId !== null}
    icon="🗜"
    tone="warning"
    title="Compact context?"
    body="Older turns are summarised so the model keeps room to work. This frees space but can’t be undone."
    confirmLabel="Compact"
    cancelLabel="Cancel"
    onConfirm={confirmCompact}
    onCancel={() => (compactConfirmId = null)}
  />

  {#if activeAsk}
    <QuestionModal
      questions={activeAsk.questions}
      bind:currentIndex={questionAsks[activeAsk.sessionId].currentIndex}
      bind:answers={questionAsks[activeAsk.sessionId].answers}
      onSubmit={handleQuestionSubmit}
      onClose={closeQuestionModal}
    />
  {/if}
  <!-- ONE lightbox for the whole pane, not one per cell or per row: the
       backdrop is position:fixed, so N mounts would stack N veils. Every image
       surface below (transcript rows, composer strips, in every grid cell)
       reports its click up to this single piece of state. -->
  <ImageLightbox src={lightbox?.src ?? null} alt={lightbox?.alt ?? ''} onClose={() => (lightbox = null)} />
</div>

<style>
  .chat-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative; /* anchor for the history dropdown */
  }

  /* In-webview history dropdown (replaces the native QuickPick). */
  .history-backdrop {
    position: absolute;
    inset: 0;
    z-index: 30;
  }
  .history-dropdown {
    position: absolute;
    top: 30px;
    right: 8px;
    width: min(320px, 90%);
    max-height: 60%;
    display: flex;
    flex-direction: column;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
    z-index: 31;
    overflow: hidden;
  }
  .history-search {
    flex: 0 0 auto;
    margin: 8px;
    padding: 6px 8px;
    font-size: 12px;
    font-family: inherit;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    outline: none;
  }
  .history-search:focus {
    border-color: var(--og-accent);
  }
  .history-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .history-row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    text-align: left;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .history-row:hover {
    background: var(--og-btn-bg);
  }
  .history-title {
    font-size: 12px;
    color: var(--og-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-meta {
    font-size: 10px;
    color: var(--og-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-empty {
    padding: 12px 10px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
    text-align: center;
  }
  .history-btn.active {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }

  /* Per-tab "pop out into its own movable editor tab" button. */
  .tab-popout {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
    line-height: 1;
    border-radius: 2px;
  }
  .tab-popout:hover {
    background: var(--og-btn-bg);
    color: var(--og-accent);
  }

  /* M1 followable surface — single per-turn arbiter decision chip. */
  .arbiter-chip {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 8px 0;
    padding: 4px 10px;
    font-size: 11px;
    border-radius: 6px;
    border-left: 3px solid var(--og-text-muted);
    background: var(--og-surface-alt);
  }
  .arbiter-chip.arbiter-done { border-left-color: var(--og-success); }
  .arbiter-chip.arbiter-continue { border-left-color: var(--og-chat); }
  .arbiter-chip.arbiter-ask_user { border-left-color: var(--og-warning); }
  /* The honest FAILURE/INCOMPLETE verdict — red, distinct from the
     benign "Continue". A budget-walled / no-progress / errored / parked
     turn lands here, never on Continue. */
  .arbiter-chip.arbiter-incomplete {
    border-left-color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 10%, var(--og-surface-alt));
  }
  .arbiter-chip.arbiter-unknown { border-left-color: var(--og-text-muted); }

  .arbiter-label { font-weight: 600; color: var(--og-text); flex: 0 0 auto; }
  .arbiter-reason {
    color: var(--og-text-secondary);
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .session-tabs {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 2px 8px;
    background: var(--og-surface);
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
    overflow-x: auto;
  }

  .session-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: 11px;
    background: transparent;
    color: var(--og-text-muted);
    border: none;
    cursor: pointer;
    border-radius: 3px;
    font-family: inherit;
    white-space: nowrap;
  }

  .session-tab:hover {
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
  }

  .session-tab.active {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }

  .session-tab.tab-waiting .tab-crane { color: var(--og-status-waiting); }
  .tab-label {
    pointer-events: none;
  }

  /* Peer name: explicit muted colour so tab hover/active recolours never promote it. */
  .peer-name { font-size: 10px; color: var(--og-text-muted); }
  .cell-peer-name { flex-shrink: 0; font-size: 10px; color: var(--og-text-muted); }
  .solo-peer-name { flex-shrink: 0; padding: 3px 12px 0; font-size: 10px; color: var(--og-text-muted); }

  .tab-rename {
    font: inherit;
    background: var(--vscode-input-background, #1e1e1e);
    color: var(--vscode-input-foreground, #ddd);
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 3px;
    padding: 0 4px;
    min-width: 80px;
    max-width: 220px;
  }

  .tab-close {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    line-height: 1;
    border-radius: 2px;
  }

  .tab-close:hover {
    background: var(--og-error);
    color: white;
  }

  .new-tab-btn {
    background: none;
    border: none;
    color: var(--og-chat);
    cursor: pointer;
    font-size: 16px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
  }

  .new-tab-btn:hover {
    background: var(--og-btn-bg);
  }

  /* History recall — sits right of the new-tab (+). Muted until hover. */
  .history-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
  }
  .history-btn:hover {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }

  /* Grid toggle button — sits flush right of the new-tab btn. */
  .grid-toggle-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
    margin-left: auto;
  }
  .grid-toggle-btn:hover:not(:disabled) {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }
  .grid-toggle-btn.active {
    color: var(--og-accent);
    background: color-mix(in srgb, var(--og-accent) 12%, transparent);
  }
  .grid-toggle-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* Pillar 3 — session export button. Slim sibling to grid-toggle;
     same hover affordance, no margin-left because it follows the
     grid toggle in DOM order. */
  .export-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
  }
  .export-btn:hover:not(:disabled) {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }
  .export-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  /* Two-mode chat grid (single | grid). Each cell is fully
     self-contained (its own messages scroller + InputBar +
     permission/plan/question prompts). */
  .chat-grid {
    flex: 1;
    display: grid;
    gap: 4px;
    padding: 4px;
    overflow: hidden;
    min-height: 0;
  }
  .chat-grid.layout-single {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    /* Single mode keeps the original 0-padding so it looks identical
       to pre-V17 behaviour. */
    padding: 0;
    gap: 0;
  }
  /* Uncapped grid — auto-fit as many session cells as fit at >=300px each,
     wrapping to new rows and scrolling vertically past what fits. No 4-cell
     cap; the sessions Map has no max. */
  .chat-grid.layout-grid {
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    grid-auto-rows: minmax(260px, 1fr);
    overflow-y: auto;
  }

  .chat-cell {
    display: flex;
    flex-direction: column;
    position: relative; /* anchor for the slide-in task overlay */
    background: var(--og-surface);
    border: 1px solid var(--og-border, rgba(255,255,255,0.05));
    border-radius: 4px;
    overflow: hidden;
    transition: border-color 0.1s ease, box-shadow 0.1s ease;
    min-height: 0;
  }

  /* The live task overlay's geometry went to TodoOverlay.svelte with its
     markup, alongside the left-edge SubagentDrawer.svelte it now sits opposite.

     The reasoning block's own styles went to ThoughtPill.svelte with its
     markup — Svelte scopes styles per component, so they live there now. */

  .rewind-undo {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0 8px;
    padding: 6px 10px;
    font-size: 11px;
    background: rgba(251, 191, 36, 0.1);
    border: 1px dashed var(--og-warning);
    border-radius: 4px;
    color: var(--og-text-secondary);
  }
  .rewind-undo-text { flex: 1; }
  .rewind-undo-btn {
    flex-shrink: 0;
    font-size: 11px;
    font-family: inherit;
    padding: 2px 10px;
    background: var(--og-warning);
    color: var(--og-bg);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-weight: 600;
  }
  .rewind-undo-btn:hover { filter: brightness(1.08); }

  .chat-cell.single {
    background: transparent;
    border: none;
    border-radius: 0;
  }
  .chat-cell.active:not(.single) {
    border-color: var(--og-accent);
    box-shadow: 0 0 0 1px var(--og-accent) inset;
  }

  .cell-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 11px;
    background: color-mix(in srgb, var(--og-surface) 60%, transparent);
    border-bottom: 1px solid var(--og-border, rgba(255,255,255,0.05));
    flex-shrink: 0;
    cursor: pointer;
  }
  .cell-header:hover { background: color-mix(in srgb, var(--og-surface) 75%, transparent); }
  .cell-tag {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    color: var(--og-text-muted);
  }
  .cell-agent {
    font-weight: 600;
    color: var(--og-text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cell-pulse {
    color: var(--og-warning);
    animation: cell-pulse 1.2s ease-in-out infinite;
    font-size: 8px;
  }
  @keyframes cell-pulse {
    0%, 100% { opacity: 0.3; }
    50%      { opacity: 1; }
  }

  .cell-messages {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  /* Multi-up cells get tighter padding to fit; single mode keeps the
     pre-V17 spacing. */
  .chat-cell:not(.single) .cell-messages { padding: 6px 8px; }
  .chat-cell.single .cell-messages { padding: 8px 12px; }

  .empty-small {
    color: var(--og-text-muted);
    font-style: italic;
    font-size: 11px;
    padding: 8px;
  }

  /* Chat empty state styles moved to ChatEmptyState.svelte (t-r7c757). */

  .stream-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 8px;
  }

  .empty {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 24px;
    text-align: center;
  }

  /* S8 V16 — agent banner ASCII art. Monospace + tight line height
     keeps the art legible; theme-driven colour. Border-bottom acts as
     a section divider so the first message visually starts below the
     banner. */
  .agent-banner {
    margin: 0 0 12px 0;
    padding: 8px 4px 12px;
    font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
    font-size: 11px;
    line-height: 1.05;
    color: var(--og-text-muted);
    white-space: pre;
    overflow-x: auto;
    border-bottom: 1px solid var(--og-border);
  }
</style>
