<script lang="ts">
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { applyEngineStatus } from '../../shared/engineStatus';
  import PermissionBar from '../components/PermissionBar.svelte';
  import QuestionModal from '../components/QuestionModal.svelte';
  import InputBar from '../components/InputBar.svelte'; import NestReadOnlyGate from '../../chat/NestReadOnlyGate.svelte'; import NestAwayBlock from '../../chat/NestAwayBlock.svelte'; import { isAway } from '../../shared/nestWriteGate'; // t-sc093o: a chat another desk owns shows a read-only line in the composer's place; t-t7lfho: a chat this desk gave away ends its transcript with "Continued on <desk>"
  import type { VisionState } from '../components/visionPinState';
  import PlanPanel from '../components/PlanPanel.svelte';
  import TodoOverlay from '../components/TodoOverlay.svelte';
  import BrowserOverlay from '../components/BrowserOverlay.svelte';
  import { clearFrames, framesFor, pushFrame, type BrowserFrame, type FrameStore } from './browserFrames';
  import { fmtHistoryDate, prettyModel } from './chatLabels';
  import SubagentDock from '../components/SubagentDock.svelte';
  import SideQuestsDock from '../components/SideQuestsDock.svelte';
  import { MAIN_TAB, subagentTodoLists } from '../components/todoTabs';
  import { subagentRows } from './subagentRows';
  import { dropScrollAnchor, stickToBottom } from './chatScroll';
  import ArbiterChip from '../components/ArbiterChip.svelte';
  // ONE tooltip box for the whole pane (shared/WarmTooltip.svelte): mounted
  // once at the root, every `use:tip` control below registers against it.
  import WarmTooltip, { tip } from '../../shared/WarmTooltip.svelte';
  import { hasConversation } from './chatEmptyGate';
  import { anchorLabel } from './scrollAnchor';
  import { pinSessionCell } from './chatPin';
  import { rearmOnGrowth, rearmOnScroll } from './chatScrollRearm'; import { noteSeen } from './chatScrollSeen'; import { followOnResize, watchResize, wheelUnsticks } from './chatScrollInput';
  import { applyToolCall, applyToolResult } from './chatToolMsg';
  import { replacesRestored, restoreLog, type RestoredEntry } from './chatRestore';
  import { applyHistory, changesFor, composerHint, loadAllFirst, pinnedFor, rewindAcross, shownMessages, subagentSource, type ChatHistory } from './chatHistory'; import ChatHistoryBar from '../components/ChatHistoryBar.svelte'; // t-ucnp7t lazy loading: older pages live beside `messages`, never in it
  import { asStreamDropNotice, foldStreamDrop, lastUserText, settleStreamDrop } from './streamDropNotice'; import { asEngineNotice, foldEngineNotice, opensEngineCard, type EngineNotice } from './engineNotice'; // t-v5qn37: the chat's engine state, on the same card
  import { cardForChild, cappedStream, childId, makeDropLog, settleChild } from './subagentInbox';
  import { appendThinking } from './subagentThinking';
  import { forwardPaneDropToComposer } from './paneDrop';
  import { pickAllowOption, isQuestionShaped } from '../components/permissionOptions';
  import { openAsk, closeAsk, visibleAsk, answerPost, cancelPost, type QuestionAsks } from './questionAsks';
  import { isTabWaiting } from './tabWaiting';
  import { sealsOpenBubble } from './agentStreamSeal';
  import PinnedUserMessage from '../components/PinnedUserMessage.svelte';
  import ThinkingGlyph from '../components/ThinkingGlyph.svelte';
  import LoadingCycler from '../components/LoadingCycler.svelte';
  import CraneMark from '../../shared/CraneMark.svelte';
  import ChatEmptyState from '../components/ChatEmptyState.svelte';
  import SoloChatHeader from '../components/SoloChatHeader.svelte';
  import { hasOpenWork, todoOverlayVisible } from './todoScratchbook';
  import { withCleared } from './todoClear';
  import { flushQueuedSend } from './queuedFlush';
  import type { RawFileDiff } from './sessionChanges';
  import { exportRows } from './exportProjection';
  import { applySecondOpinion } from './secondOpinion';
  import { echoTextFor, consumeEcho } from './userEcho';
  import { armInterject, drainInterject, resolveInterject, type InterjectLine } from './interjectSplit';
  import { retryAsPrompt } from './interjectRetry';
  import { adoptAnnouncement, acceptsReplayedLog, glyphOf, kindOf, titleOf } from './sessionReplay';
  import { capabilityOn, isPassthrough } from './passthroughCaps';
  import { verdictForStopReason, verdictLabel } from './turnVerdict';
  import { chatBackdropOn, watchChatBackdrop } from './chatBackdropClass';
  import { chatDensityCompactFromGlobal } from './chatDensityClass';
  import { mountSendSpark } from '../../shared/sendSpark';
  import ImageLightbox from '../components/ImageLightbox.svelte';
  import ChatFind from '../components/ChatFind.svelte';
  // ChatTranscript.svelte renders the per-message rows so a read-only transcript
  // can reuse it; Message/TodoInfo moved to chatMessage.ts because a type declared
  // inside this <script> can't be named by a second component.
  import ChatTranscript from '../components/ChatTranscript.svelte';
  import type { Message, TodoInfo } from './chatMessage';
  import { enqueuePermission, promoteNextPermission, settlePermissionAudit, type PermissionAsk } from './permissionSettle';

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

  interface ChatSession {
    id: string;
    number: number;
    agentName: string;
    /** Peer-broker name from the engine ('peerName' message) — the address send_message resolves `to` against; agentName is only a display default. */
    peerName?: string;
    /** Display task name (slug of first message, then engine title). */
    title?: string;
    /** Banner ASCII art for the agent, read from
     *  `<workspace>/agents/<agentName>/profile/art.txt` at session creation.
     *  `null` when missing/empty; ChatPane skips the banner then. */
    agentArt: string | null;
    /** True while this workspace has never been folded; pins the firstfold tip
     *  instead of the rotation. Set from sessionCreated, flipped by firstfoldDone.
     *  `botGlyph` rides the same message (sessionReplay.glyphOf). */
    needsSetup: boolean; botGlyph?: string;
    kind?: string; // harness: absent = the Origami engine; 'claude' = passthrough (passthroughCaps.ts)
    /** The chat is on screen but its engine is still starting: the pane now opens on
     *  the click, not on the engine's answer (sessionAnnounce.ts). Says so in the
     *  composer until `sessionStarting` clears it. */
    starting?: boolean;
    modelName: string;
    messages: Message[];
    inFlight: boolean;
    engineTurn: boolean; // the running turn is one the ENGINE started: the only kind an idle status may release (shared/engineStatus.ts)
    currentAgentMsgId: number | null;
    /** Open reasoning ('thought') message being streamed, separate from the
     *  prose stream so the two interleave cleanly (thought -> text -> thought). */
    currentThoughtMsgId: number | null;
    /** Lines typed during this session's turn are with the host, unanswered.
     *  Cleared by `interjected`/`error`/`closed` per line, and drained by
     *  turnDone, so a reply that never arrives cannot leave the chip up. */
    interjecting?: boolean;
    /** Their text AND attachments, oldest first, held from the keypress until the
     *  host answers — each row is drawn where its answer lands (interjectSplit.ts). */
    pendingInterject?: InterjectLine[];
    /** Text of the user row drawn at SEND, until `echoUser` confirms it (userEcho.ts). */
    pendingEcho?: string | null;
    /** The ask currently ON the permission bar — the HEAD of the queue below. */
    permission: PermissionAsk | null;
    /** Asks that arrived while another was on the bar, in arrival order. A
     *  sub-agent's ask forwards under its ancestor's session (engine
     *  acp/permission.ts), so N concurrent children can queue on one chat
     *  session. Answering the head promotes the next one. */
    permissionQueue: PermissionAsk[];
    /** Text queued from a plan-mode "Revise" choice — the turn is still in
     *  flight when the user submits it, so it's sent as a fresh prompt once
     *  the turn ends (flushed in `turnDone`). */
    pendingSend?: string;
    plan: PlanInfo | null;
    /** Live todo snapshot rendered as a sticky strip above the chat thread;
     *  updated on `todoUpdate`, cleared to `[]` on session reset. */
    todos: TodoInfo[];
    /** Provenance of the current snapshot — surfaces in the strip's
     * title tooltip. `''` while no snapshot has landed yet. */
    todoSource: string;
    /** Run-time todo overlay's collapsed state, owned here so it persists across
     *  the overlay re-mounting each turn (per-session). */
    todosCollapsed?: boolean;
    /** Todo lists this chat's SUB-AGENTS are keeping, by child session id. A
     *  child's `todowrite` is never an ACP tool call (the engine degrades it to
     *  a text line), so these do not arrive on `todoUpdate` with the chat's own
     *  — the host pulls them per child: src/dashboard/subagentTodos.ts. */
    subagentTodos?: Record<string, TodoInfo[]>;
    /** t-j3qxbp — same problem as `subagentTodos`, for the changed-files pill:
     *  a child's edits never land in this chat's own `messages`, so the host
     *  pulls them per child (src/dashboard/subagentChanges.ts) and this holds
     *  the raw before/after pairs aggregateSessionChanges folds in. */
    subagentChanges?: Record<string, RawFileDiff[]>;
    /** Which todo tab the overlay is showing — 'main' or a child session id.
     *  Owned here for the same reason `todosCollapsed` is: the overlay is
     *  unmounted and remounted every turn. */
    todoTab?: string;
    /** "Clear completed" (t-h8gv8w): the rows each todo list has HIDDEN, keyed
     *  by todoClear.ts's content+status, per list id ('main' or a child session
     *  id). A view filter over the model's own list — held here so it survives
     *  the overlay re-mounting, and nowhere else: the host is never told, and a
     *  window reload starts clean on purpose. */
    todoHidden?: Record<string, string[]>;
    /** The LEFT sub-agent drawer's open state. Collapsed by default (undefined
     *  = shut): a background roster is consulted, not imposed. */
    subagentsOpen?: boolean;
    /** The LEFT side-quests drawer's open state, above the sub-agent one and
     *  collapsed by default for the same reason (t-f89g49): follow-up work the
     *  owner has not asked to see must never cover the reply he is reading. */
    sideQuestsOpen?: boolean;
    /** Sub-agent roster keys (subagentRows.ts) retired from the drawer, via a
     *  manual dismiss or the auto-clear a fresh turn performs (handleSendForSession).
     *  A failed entry never settles on its own (subagentEntry.ts), so dismiss is
     *  the only way off the roster; the transcript's own card is untouched either way. */
    subagentsDismissed?: string[];
    openThoughtIds?: number[]; // user-opened thought ids; survives stream deltas (thoughtOpenState.ts)
    /** Focus view for THIS cell — transcript down to the conversation, composer
     *  eye lit (chatFocus.ts). Per-cell: a grid focuses one chat, not all twelve.
     *  NOT persisted, because a view that hides work by default hides mistakes. */
    focusMode?: boolean;
    /** Does this transcript follow the stream? `undefined` = yes, so no
     *  construction site has to set it. False once the user scrolls away;
     *  true again on return or their own send. */
    stuckToBottom?: boolean;
    /** The last row the reader had seen when the transcript stopped following —
     *  the scroll-anchor pill counts everything after it (scrollAnchor.ts). */
    unseenFromId?: number | null;
    /** Post-turn linger timer: `turnDone` keeps the overlay up briefly (so a
     *  late todowrite still flashes) before clearing `todos`. Tracked so a new
     *  send can cancel a pending clear and not wipe the next turn's todos. */
    todoLingerTimer: ReturnType<typeof setTimeout> | null;
    /** Latest cumulative token count from `contextUpdate`, pushed onto the next
     *  `turnDone`'s agent message so hovering shows tokens used at that point. */
    latestTokensUsed: number;
    /** Latest context fill % and the previous turn's cumulative-token mark,
     *  used to derive per-turn spend at `turnDone`. */
    latestContextPct: number;
    prevTokensStamped: number;
    /** Task decomposition rendered alongside TodoStrip; `null` until the
     *  runtime emits one for this session. */
    taskShape: TaskShapeInfo | null;
    /** Single per-turn arbiter decision (Done | Continue | AskUser) from
     *  `origami/arbiterDecision`. Replaced wholesale each turn, never appended,
     *  so the dashboard shows exactly one coherent decision. `null` until the
     *  bridge emits one for this session. */
    arbiterDecision: ArbiterDecisionInfo | null;
    /** Staged "rewind to here": messages optimistically removed on rewind, kept
     *  so Undo can restore them (engine `unrevert`); undefined = none pending. */
    revertStash?: Message[]; history?: ChatHistory; // t-ucnp7t: older pages, cursor, roster (chatHistory.ts)
  }

  interface ArbiterDecisionInfo {
    // `incomplete` is not a value the arbiterDecision wire carries (it collapses
    // errors to `continue`); the per-turn `turnVerdict` (from stop_reason) upgrades
    // the chip to `incomplete`. `unknown` is an unrecognised raw label, surfaced
    // literally rather than masked as the benign `continue`.
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

  // origamicoder.chat.backdrop (t-qn0wj5, proposal 24), read once — same idiom as
  // __ORIGAMI_REMOTE_ENABLED__/__ORIGAMI_FLOCK_ENABLED__ above it in DashboardPanel.ts.
  let chatBackdropSetting = $state((window as unknown as { __ORIGAMI_CHAT_BACKDROP__?: boolean }).__ORIGAMI_CHAT_BACKDROP__ !== false);
  const chatBackdropReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const backdropOn = $derived(chatBackdropOn(chatBackdropSetting, chatBackdropReduced)); $effect(() => watchChatBackdrop((on) => (chatBackdropSetting = on))); // t-s9jr6u: Settings flips it live
  const densityCompact = chatDensityCompactFromGlobal(window); // t-qn0wj5, proposal 26
  // t-qn0wj5, proposal 25 — the Send click spark; a non-invasive document
  // listener (see sendSpark.ts), so InputBar.svelte itself is never touched.
  $effect(() => mountSendSpark());

  const vscode = getVsCodeApi();
  let sessions: ChatSession[] = $state([]);
  let activeSessionId: string | null = $state(null);
  // The image the lightbox is showing, or null when it is shut. A PLAIN local
  // object of two strings — it is never posted to the host, so the $state proxy
  // never reaches structuredClone, and the `data:` URL it holds is already the
  // whole picture (nothing to fetch, nothing to fail).
  let lightbox: { src: string; alt: string } | null = $state(null);
  const openLightbox = (src: string, alt: string) => (lightbox = { src, alt });
  // t-qn0lpl — "Reveal shot". A browser frame is never on disk (browserFrames.ts:
  // the ring is heap-only, deliberately), so the BYTES travel and the host writes
  // the file it then reveals. Rebuilt as a flat literal, never the frame itself:
  // a $state proxy fails postMessage's structured clone in silence.
  const revealFrame = (f: BrowserFrame) => vscode.postMessage({
    type: 'revealBrowserFrame', action: String(f.action), ts: Number(f.ts), imageDataUrl: String(f.imageDataUrl ?? ''),
  });
  // Browser screenshots, ringed per session (browserFrames.ts), webview-local
  // for their whole life; never posted back. Collapse is per session.
  let browserFrames: FrameStore = $state({});
  let browserShut: Record<string, boolean> = $state({});
  // t-okz748 — the big compaction popup is gone. The gauge pill's FuseButton
  // (InputBar.svelte) owns the arm/cancel/burn interaction itself and calls
  // this straight when the fuse burns out — no confirm step, the fuse burning
  // IS the confirm.
  function compactSession(sessionId: string) {
    vscode.postMessage({ type: 'compactContext', sessionId });
  }

  // One engine ask carries all of its questions (`_meta.questions`, parsed by
  // acpClient), so an entry is a single ask holding N questions, not a queue.
  // Keyed by chat (questionAsks.ts) so a batch renders over its own session's
  // cell and a second asker can't overwrite the first; the draft lives in the
  // entry because leaving the tab unmounts the modal.
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

  // "Rewind to here": trims the transcript (rewindSlice.ts) and stashes the tail
  // for Undo; the engine restores the tree (finalised on the next prompt).
  function rewindTo(sid: string, engineMsgId?: string) {
    const s = engineMsgId ? getSession(sid) : null;
    if (!s || s.inFlight || isAway(sid)) return; // t-t7lfho: a chat on another desk is read only (nestWriteGate.ts)
    if (!rewindAcross(s, engineMsgId!, () => rewindTo(sid, engineMsgId))) return; // trims across older pages too; a question above them loads first (chatHistory.ts, plan F4)
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
  /** Where each session's last restore STARTED, so a replacement rewinds to
   *  the same point instead of appending a second copy (chatRestore.ts). */
  const restoredAt = new Map<string, number>();
  let messagesEl: HTMLDivElement | undefined = $state();

  // In-webview history dropdown; list is requested from the host on open and
  // filtered client-side.
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
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }
  function popOutSession(sid: string) {
    vscode.postMessage({ type: 'popOutSession', sessionId: sid });
  }

  // Two-mode chat layout: `single` (one chat fills the pane) or `grid` (every
  // open chat tiled, uncapped). Each cell hosts a fully independent agent chat.
  // `activeSessionId` survives as the image-paste source and persistence
  // target; clicking a cell promotes it.
  type ChatLayout = 'single' | 'grid';
  let chatLayout: ChatLayout = $state('single');
  // `grid` shows all sessions, uncapped, in an auto-fit grid that wraps + scrolls.
  let visibleCells = $derived<ChatSession[]>(
    soloSessionId
      ? sessions.filter(s => s.id === soloSessionId)
      : chatLayout === 'grid'
        ? sessions
        : (activeSession ? [activeSession] : sessions.slice(-1))
  );
  // The cell the two LEFT drawers are keyed to (t-fiszlv R18). One dock per
  // pane, not one per cell: each mount carries a window listener and asks the
  // host for the side-quest folder and the sub-agent ceiling on every focus, so
  // an N-cell grid cost N readdirs and N setting reads per focus for N copies of
  // a drawer only the chat in focus is ever read against.
  let dockCell = $derived(visibleCells.find((s) => s.id === activeSessionId) ?? visibleCells[0]);
  // The one question batch the modal may show: owned by a chat whose cell is on
  // screen, active cell first.
  let activeAsk = $derived(visibleAsk(questionAsks, activeSessionId, visibleCells.map(s => s.id)));

  // A sub-agent side-channel event that found no card — counted and logged
  // rather than dropped silently (throttle: subagentInbox.ts).
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
  // Tell the extension when the sidebar (not a solo tab) is in grid layout: a
  // background agent's permission ask must forward to its cell instead of
  // auto-deciding (DashboardPanel.isSessionMounted honours this).
  $effect(() => {
    if (!soloSessionId) vscode.postMessage({ type: 'chatGridMode', grid: chatLayout === 'grid' });
  });

  // Broadcast active-session changes so DashboardPanel can stash the id in
  // workspaceState and restore it after a reload. Skip the initial null so we
  // don't overwrite a real saved value before the first chat opens.
  let lastBroadcastSessionId: string | null = null;
  $effect(() => {
    // A popped-out solo tab must not drive the shared active-session (would
    // clobber the sidebar's focus/image-paste target); it pins to its own
    // session below instead. One-time: ask the host for each session's own
    // model so a solo tab (which never posts activeSessionChanged) shows its model.
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

  // Solo tab: once its session has arrived, pin the local active-session to it
  // so the single cell + image-paste target resolve correctly regardless of
  // which session the host considers active.
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
  // Each session's own selected model, keyed by sessionId; falls back to the
  // global `modelName` when a cell has no entry yet.
  let modelBySession = $state<Record<string, string>>({});
  // Strip the provider prefix (implied by the model) for display.
  let requestedSessionModels = false;
  // Whether the loaded model is vision-capable (LM Studio type:vlm) — drives
  // the InputBar vision indicator.
  let isVlm = $state(false);
  // Whether that answer is detected or pinned: isVlm is the live engine fact,
  // visionState is config + the globalState pin the Vision control writes.
  let visionState = $state<VisionState>('auto-off');
  let modelReason = $state('');
  // Per-session model connectivity, keyed by sessionId, so a model op in one
  // chat can't flip another chat's online state / offline banner / vision.
  let onlineBySession = $state<Record<string, boolean>>({});
  let reasonBySession = $state<Record<string, string>>({});
  let isVlmBySession = $state<Record<string, boolean>>({});
  let visionStateBySession = $state<Record<string, VisionState>>({});
  // Per-session model name + provider identity, so the offline banner names the
  // right server and a status for one chat never stomps another's display.
  let nameBySession = $state<Record<string, string>>({});
  let providerLabelBySession = $state<Record<string, string>>({});
  let providerLocalBySession = $state<Record<string, boolean>>({});
  // Active mode (Normal / Game) + per-mode default models, surfaced in the header.
  let activeMode = $state<'normal' | 'game'>('normal');
  let defaultModelNormal = $state('');
  let defaultModelGame = $state('');

  let activeSession = $derived(sessions.find(s => s.id === activeSessionId) ?? null);

  function scrollToBottom(sessionId?: string) {
    // In multi-up modes the messages scroller for each cell is keyed by
    // data-session-id, to avoid a bind:this-overwrite race.
    const targetSid = sessionId ?? activeSessionId;
    // Stick gate: a user who scrolled up is reading, so streamed chunks must not
    // snap them back. Their own send re-arms it, as does scrolling back down.
    // Read inside the frame so a chunk landing just before a scroll-away can't
    // leave a snap in flight that fires after it.
    requestAnimationFrame(() => {
      if (targetSid) {
        const s = getSession(targetSid);
        const cell = document.querySelector<HTMLDivElement>(
          `.cell-messages[data-session-id="${targetSid}"]`,
        );
        // No cell means this session isn't on screen; falling through to
        // messagesEl would scroll a different chat the user is reading.
        if (!cell) return;
        // Growth re-arm (chatScrollRearm.ts), follow, record the frame the reader sees (chatScrollSeen.ts, t-v47ytt).
        const stuck = (s?.stuckToBottom !== false || rearmOnGrowth(cell)) && stickToBottom(cell);
        noteSeen(cell, stuck);
        if (s) { s.stuckToBottom = stuck; if (stuck) s.unseenFromId = null; }
        return;
      }
      if (messagesEl && !stickToBottom(messagesEl) && activeSession) activeSession.stuckToBottom = false;
    });
  }

  function getSession(sid: string): ChatSession | undefined {
    return sessions.find(s => s.id === sid);
  }

  /** Re-read the stick from where the scroller actually is (rule: chatScrollRearm.ts). */
  function onMessagesScroll(s: ChatSession, ev: Event) {
    s.stuckToBottom = rearmOnScroll(ev.currentTarget as HTMLDivElement, s.stuckToBottom !== false);
    s.unseenFromId = s.stuckToBottom ? null : (s.unseenFromId ?? (s.messages.at(-1)?.id ?? null));
  }

  /** The composer or the window moved the bottom with no scroll event: a follower is pinned, a reader it put on the bottom re-arms (t-v47ytt). */
  function onMessagesResize(s: ChatSession, el: Element) { if (followOnResize(el, s.stuckToBottom !== false)) { s.stuckToBottom = true; s.unseenFromId = null; } }

  function onMessagesWheel(s: ChatSession, ev: WheelEvent) {
    if (!wheelUnsticks(ev.currentTarget as HTMLDivElement, ev.deltaY, ev.target)) return; // a box inside that takes the wheel is not the transcript (chatScrollInput.ts)
    s.stuckToBottom = false;
    s.unseenFromId = s.unseenFromId ?? (s.messages.at(-1)?.id ?? null);
  }

  function addMessage(sid: string, kind: Message['kind'], label: string, text: string, images?: string[], engineMsgId?: string, extra?: Partial<Message>): number {
    const id = nextMsgId++;
    const s = getSession(sid);
    if (s) {
      // A fresh user turn finalises any staged rewind (engine deletes the
      // reverted tail on the next prompt) — the Undo window is over.
      if (kind === 'user' && s.revertStash) s.revertStash = undefined;
      // A user row seals whatever the agent had open, so prose the model streams
      // after it opens a fresh message rather than appending out of sequence.
      // Also covers a live interjection (interjectSplit.ts / userEcho), where the
      // stream is still running underneath the new row.
      if (kind === 'user') { s.currentAgentMsgId = null; s.currentThoughtMsgId = null; }
      s.messages = [...s.messages, { id, kind, label, text, images, engineMsgId, timestamp: Date.now(), ...extra }];
      // Scroll the cell that owns this session, regardless of which is "active".
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

  // Handlers take a target session so per-cell components can dispatch
  // independently.
  /** Retire ONE roster row from this chat's drawer — the single path for the
   *  row's × and the failed-spawn dismiss above, which since t-h8gv8w are the
   *  only two. The host rides the key on the session log (t-fiszlv R9), which is
   *  what a reopened chat is rebuilt from: held here alone, every removed row
   *  came back on the next reload. */
  function dismissSubagent(s: ChatSession, key: string): void {
    const held = s.subagentsDismissed ?? [];
    if (held.includes(key)) return;
    s.subagentsDismissed = [...held, key];
    sessions = [...sessions];
    vscode.postMessage({ type: 'dismissSubagent', sessionId: s.id, key });
  }
  /** Retry on a STOPPED stream-drop card: send the turn AGAIN, through the same
   *  path the composer uses — there is no separate resend wire, and inventing one
   *  would be a second way to start a turn. The turn is the last thing the user
   *  actually typed; a card with nothing above it has nothing to resend. */
  function retryTurn(sid: string): void {
    const s = getSession(sid);
    const text = s && !s.inFlight ? lastUserText(s.messages) : '';
    if (s && text) handleSendForSession(s, text);
  }
  /** t-v5qn37: the engine's state goes on the open engine card, else on a new one if there is something to say. */
  function showEngine(s: ChatSession, n: EngineNotice): void { s.starting = n.stage === 'starting'; const rows = foldEngineNotice(s.messages, n); if (rows) s.messages = rows; else if (opensEngineCard(n)) addMessage(s.id, 'engine', 'System', '', undefined, undefined, { engine: n }); sessions = [...sessions]; }

  function handleSendForSession(s: ChatSession, text: string, mode = '') {
    // /compose may start with no args (it opens an interview), so empty text is
    // allowed when a mode is set; every other send still requires text.
    if (!s || s.inFlight || (!text.trim() && !mode) || isAway(s.id)) return; // t-t7lfho: also Retry and a queued revise (nestWriteGate.ts)
    // Sending re-arms the follow: a stated intent outranks one inferred from
    // scroll position.
    s.stuckToBottom = true;
    const sendingCell = document.querySelector<HTMLDivElement>(
      `.cell-messages[data-session-id="${s.id}"]`,
    );
    if (sendingCell) dropScrollAnchor(sendingCell);
    s.inFlight = true; s.engineTurn = false;
    s.currentAgentMsgId = null;
    s.currentThoughtMsgId = null;
    // Fresh turn → cancel any still-pending linger-clear from the last turn.
    // The task list itself survives the send: it's a scratchbook that outlives
    // the turn that wrote it (todoScratchbook.ts).
    clearTodoLinger(s);
    // A failed sub-agent spawn is a fact about the turn that asked for it, so
    // auto-dismiss every failed row still showing when this NEW turn starts
    // (same effect as a manual (x) click, subagentRows.ts's dismissedKeys).
    // Not done at `turnDone`: that fires while the failing turn is still on
    // screen and would erase the denial before the user reads the reply.
    for (const row of subagentRows(s.messages, Date.now())) {
      if (row.state === 'failed') dismissSubagent(s, row.key);
    }
    // The row goes up now, not on the host's echo round trip (userEcho.ts).
    s.pendingEcho = echoTextFor(text, mode);
    addMessage(s.id, 'user', 'You', s.pendingEcho);
    vscode.postMessage({ type: 'send', text: text.trim(), sessionId: s.id, mode: mode || undefined });
    sessions = [...sessions];
  }
  function handleCancelForSession(s: ChatSession) {
    if (!s) return;
    vscode.postMessage({ type: 'cancel', sessionId: s.id });
    // Cancel must release every parked ask, not just the one on the bar — a
    // queued ask left unanswered is a tool call hanging on an unreachable prompt.
    for (const ask of [...(s.permission ? [s.permission] : []), ...s.permissionQueue]) {
      vscode.postMessage({ type: 'permission', toolCallId: ask.toolCallId, optionId: null, sessionId: s.id });
    }
    s.permission = null;
    s.permissionQueue = [];
    // Cancel must visibly release the turn even if the backend is wedged
    // (e.g. a self-review sub-agent that never returns).
    s.inFlight = false; s.engineTurn = false;
    clearInProgressPlan(s);
    sessions = [...sessions];
  }

  // Clear a plan banner that's mid-flight but keep one already awaiting the
  // user's approve/reject, so an interrupted plan turn doesn't spin forever.
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
  // Permission queue: the bar shows one ask at a time; everything else waits
  // its turn (enqueuePermission/promoteNextPermission, permissionSettle.ts).

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
  /** YOLO: stop asking in this chat, and answer the ask on screen. `bypass`
   *  only applies from the next message, so it must also answer the current
   *  prompt directly (pickAllowOption: allow_once before allow_always). */
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

  // User clicked "Pick this plan instead" on a non-winner alternative: swap
  // plan_state.plan to the chosen candidate so approve/reject targets it.
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

  /** Ships the active session's messageLog to the extension host for markdown
   *  rendering + Save. Strips image data URLs (bloat the export, unused in
   *  markdown) and preserves tool cards so the transcript stays faithful. */
  function exportSession(s: ChatSession) {
    if (loadAllFirst(s, 'export', () => exportSession(s))) return; // the whole chat first, with progress (plan F2)
    vscode.postMessage({
      type: 'exportSession',
      sessionId: s.id,
      agentName: s.agentName,
      messages: exportRows(shownMessages(s)),
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
          title: titleOf(msg),
          agentArt: typeof msg.agentArt === 'string' && msg.agentArt.length > 0
            ? msg.agentArt
            : null,
          needsSetup: !!msg.needsSetup, botGlyph: glyphOf(msg), kind: kindOf(msg),
          starting: msg.starting === true,
          modelName: '',
          messages: [],
          inFlight: false,
          engineTurn: false,
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
      // The engine answered or refused: the composer stops saying it is starting. A
      // refusal has already drawn its own error row in this pane.
      case 'sessionStarting': {
        const s = getSession(msg.sessionId);
        if (s) { s.starting = msg.starting === true; sessions = [...sessions]; }
        break;
      }
      case 'engineState': { const s = sid ? getSession(sid) : null, n = asEngineNotice(msg); if (s && n) showEngine(s, n); break; } // waiting / failed (with Retry) / ready — engineGate.ts
      case 'sessionTitle':
        sessions = sessions.map(s => s.id === msg.sessionId ? { ...s, title: titleOf(msg) } : s); break;
      // The model picker bound this cell to a Claude Code passthrough, or handed it back (claudeCodeCell.ts). Kind drives the capability gates, so it is the whole flip.
      case 'sessionKind':
        sessions = sessions.map(s => s.id === msg.sessionId ? { ...s, kind: kindOf(msg) } : s); break;
      case 'restoreActiveSession': {
        // A solo tab pins its own session (see the $effect); ignore the
        // host's shared active-session pointer here so it can't switch the
        // popped tab to a different chat.
        if (soloSessionId) break;
        // Extension replays the persisted session id on dashboard activation.
        // Only honour it once a matching session has been re-created
        // (sessionCreated above), which races with reattaching sessions.
        if (msg.sessionId && sessions.some(s => s.id === msg.sessionId)) {
          activeSessionId = msg.sessionId;
        }
        break;
      }
      // The sidebar's workspace-wide roster count was clicked: focus the chat
      // that owns the running sub-agents and pull its drawer out. A solo tab
      // still ignores the focus half (it pins its own session, like
      // restoreActiveSession above) but DOES open the drawer when the chat it
      // is pinned to is the one named.
      case 'openSubagentDrawer': {
        const target = sessions.find(s => s.id === msg.sessionId);
        if (!target) break;
        if (!soloSessionId) activeSessionId = target.id;
        else if (soloSessionId !== target.id) break;
        target.subagentsOpen = true;
        sessions = [...sessions];
        break;
      }
      // The same move for the drawer above it (t-f89g49). Its own case rather
      // than a shared one: the two drawers toggle independently, and a phone that
      // asked for side quests must not also pull out a sub-agent roster.
      case 'openSideQuestsDrawer': {
        const target = sessions.find(s => s.id === msg.sessionId);
        if (!target) break;
        if (!soloSessionId) activeSessionId = target.id;
        else if (soloSessionId !== target.id) break;
        target.sideQuestsOpen = true;
        sessions = [...sessions];
        break;
      }
      case 'setChatLayout': {
        // The host restores the persisted sidebar layout (solo vs grid) after
        // reopening the open-set. A solo tab keeps its own single view.
        if (!soloSessionId) chatLayout = msg.grid ? 'grid' : 'single';
        break;
      }
      case 'restoreMessages': {
        // Bulk-replay a saved messageLog into the session's messages array.
        // Rebuild rules live in chatRestore.ts; an entry that kept its tool
        // payload comes back as a real card. Skip when the target session
        // isn't registered yet (race with sessionCreated).
        if (msg.sessionId && Array.isArray(msg.messages)) {
          const idx = sessions.findIndex(s => s.id === msg.sessionId);
          const replaces = replacesRestored(msg); // the phone shell repainting its cached transcript (webview/remote/cache.ts)
          if (idx !== -1 && (acceptsReplayedLog(sessions[idx]) || replaces)) { // a log replayed under rows already on screen says the same things twice (sessionReplay.ts)
            // A replacement rewinds to where the LAST restore started, so what
            // it rebuilds is those same rows and never a second copy of them.
            const at = replaces ? (restoredAt.get(msg.sessionId) ?? sessions[idx].messages.length) : sessions[idx].messages.length;
            restoredAt.set(msg.sessionId, at);
            sessions[idx].messages = restoreLog(
              sessions[idx].messages.slice(0, at),
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
        // Pick up mode-centric header fields when the extension supplies them;
        // falls back to existing values for an older extension build.
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
        browserFrames = clearFrames(browserFrames, msg.sessionId); delete browserShut[msg.sessionId];
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
        // Engine runs only: the sidebar's popup put Claude Code transcripts on
        // this same wire, and `recallSession` cannot open one.
        historyItems = (Array.isArray(msg.sessions) ? msg.sessions : []).filter((s: { kind?: string }) => s?.kind !== 'claude');
        historyLoading = false;
        break;
      }
      case 'system':
        if (sid) addMessage(sid, 'system', 'System', msg.text || '');
        break;
      // t-q90gj9. A dropped provider stream, as DATA. Its own row kind, never an
      // agent bubble: the engine said this, not the model. Consecutive notices
      // fold into the OPEN card (streamDropNotice.ts) rather than stacking.
      case 'streamDrop': {
        const s = sid ? getSession(sid) : null, notice = asStreamDropNotice(msg.notice);
        if (!s || !notice) break;
        const folded = foldStreamDrop(s.messages, notice);
        if (folded) { s.messages = folded; scrollToBottom(sid!); }
        else addMessage(sid!, 'streamDrop', 'System', '', undefined, undefined, { streamDrop: { notice } });
        break;
      }
      case 'busy':
        // Host-driven in-flight: a /loop scheduled run starts outside the send
        // path, so the host flips the composer busy (turnDone clears it as usual).
        if (sid) { const s = getSession(sid); if (s && !s.inFlight) { s.inFlight = true; s.engineTurn = false; sessions = [...sessions]; } }
        break;
      case 'sessionStatus': {
        // The ENGINE's own run state. ONLY the in-flight flag (turnDone still owns
        // the rest of the end of a turn), and only a turn this status ADOPTED may
        // be released by it — ../../shared/engineStatus.ts carries why.
        const s = sid ? getSession(sid) : null;
        const next = s ? applyEngineStatus(s, msg.status) : null;
        if (s && next) { s.inFlight = next.inFlight; s.engineTurn = next.engineTurn; sessions = [...sessions]; }
        break;
      }
      case 'firstfoldStart': {
        // /firstfold drives the SAME live todo overlay as a tool turn. Mark the
        // session in-flight so the slide-in shows, and clear any old todos.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        clearTodoLinger(s);
        s.todos = [];
        s.todoSource = 'firstfold';
        s.inFlight = true; s.engineTurn = false;
        sessions = [...sessions];
        break;
      }
      case 'firstfoldDone': {
        // Mirror turnDone's todo handling: leave a collapsed one-liner summary
        // inline, linger the overlay briefly, then clear + end in-flight.
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        s.inFlight = false; s.engineTurn = false;
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
        // "folded" is workspace-wide: flip every open chat's pinned tip back
        // to rotation live, not just this session's.
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
          undefined, undefined, { peerReplyTo: String(msg.replyTo || ''), peerFlock: msg.flock as never, peerSubagent: msg.subagent as never });
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
        // Prose after a drop = the stream came back; the rule (and the bound on
        // recovery) is streamDropNotice.ts's, so the restore path shares it.
        if ((msg.text || '').trim()) s.messages = settleStreamDrop(s.messages);
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
        s.messages = settleStreamDrop(s.messages); // t-sj3fvo: reasoning recovers a drop card too.
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
        // Posted the instant /compact is clicked, so the marker always appears
        // even when the summary streams no text. Close open streams so it
        // stands alone; its body fills from compactionChunk deltas.
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
        // The /compact summary streams here. Collapse into one "Compaction
        // Completed" marker: chunks arrive contiguously, so an already-'compacted'
        // last message means the same compaction is streaming — append it.
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
          // Settle the marker the moment compaction finishes: a manual /compact
          // turn emits no turnDone, so this is what flips the marker instead.
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
          s.messages = settleStreamDrop(s.messages); // t-sj3fvo: a tool call recovers a drop card too.
          // Append + shell-detail shaping live in chatToolMsg.ts; side effects stay here.
          s.messages = applyToolCall(s.messages, msg, nextMsgId++);
          // Close the open agent-text message so prose the model streams after
          // this tool starts a fresh message below the card, preserving the
          // real text -> tool -> text interleave.
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
        const card = cardForChild(subagentSource(s), child);
        if (!card) { warnSubagentDrop('chunk', child); break; }
        card.taskStream = cappedStream(card.taskStream, msg.text || '');
        // A prose or tool line ENDS the run of thought that preceded it
        // (t-gvz8t0): the child stopped weighing and started doing, and a
        // heartbeat left standing would age for ever beside real activity.
        card.taskThinking = undefined;
        s.messages = [...s.messages]; // trigger reactivity
        break;
      }
      case 'subagentThinking': {
        // A sub-agent's live REASONING. Its OWN field, never `taskStream`:
        // that string is the row's activity tail and this card's reply text,
        // and thought written there is thought shown as the child's answer.
        if (!sid) break;
        const sThink = getSession(sid);
        if (!sThink) break;
        const thinkChild = childId(msg.childSessionId);
        const thinkCard = cardForChild(subagentSource(sThink), thinkChild);
        if (!thinkCard) { warnSubagentDrop('thinking', thinkChild); break; }
        // The engine's reasoning rider is a SESSION total; handing the run its
        // baseline here is what lets a later exact figure be read as this
        // thought's own share (subagentThinking.ts thinkingTokens).
        thinkCard.taskThinking = appendThinking(
          thinkCard.taskThinking, msg.text || '', Date.now(), thinkCard.taskTokens?.reasoning ?? 0,
        );
        sThink.messages = [...sThink.messages]; // trigger reactivity
        break;
      }
      case 'subagentTokens': {
        // A running sub-agent's spend, re-sent per child step (t-dkkd2o). LATEST
        // WINS, like the same rider on a tool update (taskRiders.ts): an earlier
        // figure is a superseded snapshot, and a message carrying none at all
        // must never blank the one already on the card.
        if (!sid) break;
        const st = getSession(sid);
        if (!st) break;
        const kid = childId(msg.childSessionId);
        const tokenCard = cardForChild(subagentSource(st), kid);
        if (!tokenCard) { warnSubagentDrop('tokens', kid); break; }
        if (!msg.tokens || typeof msg.tokens !== 'object') break;
        tokenCard.taskTokens = msg.tokens;
        st.messages = [...st.messages]; // trigger reactivity
        break;
      }
      case 'subagentTodos': {
        // A sub-agent's list, pulled by the host off that child's stored
        // session. Stored by CHILD ID and joined to the roster at render time,
        // so a list whose task card has not arrived yet is held rather than
        // dropped — unlike a chunk, which has nowhere to be drawn without one.
        if (!sid) break;
        const s2 = getSession(sid);
        const child = childId(msg.childSessionId);
        if (!s2 || !child) break;
        s2.subagentTodos = { ...(s2.subagentTodos ?? {}), [child]: Array.isArray(msg.todos) ? msg.todos : [] };
        sessions = [...sessions];
        break;
      }
      case 'subagentChanges': {
        // t-j3qxbp — a child's raw before/after pairs, pulled by the host off
        // that child's stored session. Folded into the pill by aggregateSessionChanges.
        if (!sid) break;
        const s3 = getSession(sid);
        const child3 = childId(msg.childSessionId);
        if (!s3 || !child3) break;
        s3.subagentChanges = { ...(s3.subagentChanges ?? {}), [child3]: Array.isArray(msg.files) ? msg.files : [] };
        sessions = [...sessions];
        break;
      }
      case 'subagentDismissed': {
        // The rows this chat had already retired, replayed by the host on attach
        // (t-fiszlv R9). Unioned, never assigned: a dismiss made between the
        // burst being built and this landing must not be undone by it.
        if (!sid) break;
        const sd = getSession(sid);
        if (!sd || !Array.isArray(msg.keys)) break;
        const keys = msg.keys.filter((k: unknown): k is string => typeof k === 'string' && k !== '');
        sd.subagentsDismissed = [...new Set([...(sd.subagentsDismissed ?? []), ...keys])];
        sessions = [...sessions];
        break;
      }
      case 'subagentDone': {
        // A detached sub-agent finished; this marker is the only thing that
        // retires the drawer row (the launcher card reached `completed` at spawn).
        if (!sid) break;
        const s = getSession(sid);
        if (!s) break;
        const child = childId(msg.taskSessionId);
        // A LOST marker is a row that never retires, so this drop is the one
        // that has to be loud. The rule for WHICH card is subagentInbox.ts's.
        if (!settleChild(subagentSource(s), child, msg.state, msg.endedAt)) { warnSubagentDrop('done', child); break; }
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
      case 'permissionAudit': {
        // No sessionId on this message (a phone's signed approve, or a bypass
        // release draining every ask on a session at once), so offer it to every
        // session; settlePermissionAudit is a no-op wherever the id isn't found.
        if (msg.action === 'approved' || msg.action === 'denied') {
          for (const s of sessions) settlePermissionAudit(s, msg.toolCallId);
          sessions = [...sessions];
        }
        break;
      }
      case 'planStatus': {
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          // 'turn_end' (or any empty/non-plan status) is the backend's
          // end-of-turn marker, not a real plan phase — clear the in-progress
          // banner rather than inventing a 'self_review'.
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
        // Live todo snapshot mirroring the harness-owned tracker. Wholesale
        // replacement (the bridge sends the full list each time).
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          s.todos = Array.isArray(msg.todos) ? msg.todos : [];
          s.todoSource = msg.source ?? '';
          // Fresh array reference guarantees the overlay slide-in re-mounts
          // every cycle, not just the first.
          sessions = [...sessions];
        }
        break;
      }
      case 'browserSnapshot': {
        // One picture of the page the agent just acted on. `pushFrame` owns the
        // cap, the order and the refusal of an imageless frame.
        if (!sid) break;
        const { action, ts, url, imageDataUrl, pageText, width, height, shotWidth, shotHeight } = msg;
        browserFrames = pushFrame(browserFrames, sid, { action, ts, url, imageDataUrl, pageText, width, height, shotWidth, shotHeight });
        break;
      }
      case 'arbiterDecision': {
        // Single per-turn arbiter verdict. Wholesale replacement: exactly one
        // decision is shown at a time, never a stack of gate firings.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          const raw = String(msg.decision ?? '');
          // A recognised decision is kept; an unrecognised label is surfaced as
          // `unknown` rather than silently promoted to the benign `continue`.
          const decision =
            raw === 'done' || raw === 'continue' || raw === 'ask_user' || raw === 'incomplete'
              ? raw
              : 'unknown';
          s.arbiterDecision = { decision, reason: String(msg.reason ?? '') };
        }
        break;
      }
      case 'turnVerdict': {
        // `origami/turnEnd` stop_reason → the terminal verdict for this turn.
        // Two surfaces: (1) upgrade the floating arbiter chip to `incomplete`
        // when the terminal was an error/park (arbiterDecision collapses those
        // to `continue`); (2) append an inline verdict row at the end of the
        // turn's messages so history shows what each turn actually resolved to.
        if (!sid) break;
        const s = getSession(sid);
        if (s) {
          const verdict = verdictForStopReason(String(msg.stopReason ?? ''));
          // (1) only sharpen toward honesty; never downgrade a recognised
          // non-error decision.
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
        // Task decomposition; same wholesale-replacement pattern as todoUpdate.
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
          // Preserve any alternatives/verdict from a prior bestOfNComplete that
          // arrived first: the critic verdict fires slightly before planReady.
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
          s.inFlight = false; s.engineTurn = false;
        }
        scrollToBottom(sid);
        break;
      }
      case 'bestOfNComplete': {
        // Critic verdict + scored alternatives land on the active plan so
        // PlanPanel can render the tab bar. If the plan isn't staged yet, stash
        // them on a placeholder so planReady picks them up.
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
          s.inFlight = false; s.engineTurn = false; s.pendingEcho = null; // turn over: no echo still owed (interjections are resolved at the END of this case)
          // A plan-mode "Revise" revision was waiting on this turn — the defer
          // that keeps it off the old turn lives in queuedFlush.ts.
          flushQueuedSend(s, handleSendForSession);
          // Completion retires the list: leave the collapsed summary in history,
          // hold the panel for a short linger (so an all-at-once todowrite still
          // flashes), then clear. A list with work outstanding is left alone.
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
          // Stamp the cumulative token count onto the last agent message of this
          // turn so hovering historical messages shows spend at each point.
          if (s.latestTokensUsed > 0) {
            for (let i = s.messages.length - 1; i >= 0; i--) {
              const m = s.messages[i];
              if (m.kind === 'agent') {
                m.tokensAtTurn = s.latestTokensUsed;
                // Per-turn spend = cumulative delta since last turn.
                const delta = s.latestTokensUsed - s.prevTokensStamped;
                if (delta > 0) m.tokensThisTurn = delta;
                if (s.latestContextPct > 0) m.ctxPctAtTurn = s.latestContextPct;
                s.prevTokensStamped = s.latestTokensUsed;
                s.messages = [...s.messages];
                break;
              }
              // Stop past the most recent user message — the agent of this
              // turn, not the previous.
              if (m.kind === 'user') break;
            }
          }
          // Interjections still unanswered when the turn ended keep their rows.
          // Last on purpose: the token stamp above walks back to the turn's
          // final agent row and a row added before it would hide the stamp target.
          for (const late of drainInterject(s)) addMessage(sid, 'user', 'You', late.text, late.images);
        }
        break;
      }
      case 'error':
        if (sid) {
          const s = getSession(sid);
          // A rejected interjection gets its row drawn above the failure that
          // explains it (interjectSplit.ts) — unless the line never reached the
          // engine at all (interjectRetry.ts), in which case it goes out as a
          // fresh prompt instead. Not deferred: a setTimeout would let a second
          // refusal's retry find the first turn already in flight and get dropped.
          const line = s ? resolveInterject(s) : null;
          const retry = !!line && retryAsPrompt(msg.message || '', line);
          if (line && !retry) addMessage(sid, 'user', 'You', line.text, line.images);
          addMessage(sid, 'error', 'Error', msg.message || '');
          if (s) { s.inFlight = false; s.engineTurn = false; clearInProgressPlan(s); clearTodoLinger(s); }
          if (retry) handleSendForSession(s!, line!.text);
        }
        break;
      case 'imageError':
        // Pairs with the toast shown by DashboardPanel.ts so the failure
        // persists in chat history after the toast dismisses. No inFlight flip:
        // image errors fire from InputBar paste/drop, not a turn in flight.
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
          if (s) for (const line of drainInterject(s)) addMessage(sid, 'user', 'You', line.text, line.images); // the engine is gone: every outstanding line keeps its place
          if (s) showEngine(s, { stage: 'stopped', reason: msg.reason || '', held: 0, retry: false }); // the reconnect card, not a red row (t-v5qn37)
          if (s) { s.inFlight = false; s.engineTurn = false; clearInProgressPlan(s); clearTodoLinger(s); }
        }
        break;
      // The host confirmed the interjection reached the running turn. The row
      // goes in here, not at the click, so it seals the bubble above it and
      // the deltas that follow open a fresh one below (interjectSplit.ts).
      case 'interjected': { const s = sid ? getSession(sid) : null; if (s) { const line = resolveInterject(s); if (line) addMessage(sid!, 'user', 'You', line.text, line.images); sessions = [...sessions]; } break; }
      case 'historyState': case 'historyPage': case 'historyProgress': case 'historyLoaded': { const s = sid ? getSession(sid) : null; if (s) { applyHistory(s, msg, () => nextMsgId++); sessions = [...sessions]; } break; } // t-ucnp7t (chatHistory.ts)
      // A different model's review of the last completed turn; the host answers
      // twice per request (pending, then ok/error), routed by secondOpinion.ts.
      case 'secondOpinionResult': { const s = sid ? getSession(sid) : null; if (s) { const next = applySecondOpinion(s.messages, msg, (label, extra) => addMessage(sid!, 'secondOpinion', label, '', undefined, undefined, extra)); if (next) s.messages = next; sessions = [...sessions]; } break; }
    }
  });
</script>

<div class="chat-pane" class:chat-backdrop={backdropOn} class:chat-density-compact={densityCompact} ondragover={(e) => e.preventDefault()} ondrop={(e) => { e.preventDefault(); if (e.dataTransfer) forwardPaneDropToComposer(activeSessionId, e.dataTransfer); }}> <!-- forwards to the active chat; see paneDrop.ts -->
  <WarmTooltip />
  <!-- Solo (popped-out) tab: the 24px strip in place of the tab bar (t-qn0wj5, proposal 23). -->
  {#if soloSessionId && activeSession}
    <SoloChatHeader
      number={activeSession.number} agentName={activeSession.agentName}
      title={activeSession.title} peerName={activeSession.peerName} modelName={activeSession.modelName}
      waiting={isTabWaiting(!!questionAsks[activeSession.id], !!activeSession.permission || activeSession.permissionQueue.length > 0)} />
  {/if}
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
          use:tip={'Double-click to rename'}
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
          <button class="tab-popout" onclick={(e) => { e.stopPropagation(); popOutSession(s.id); }} use:tip={'Open this chat in its own movable tab'}>⤢</button>
          {#if sessions.length > 1}
            <button class="tab-close" onclick={(e) => { e.stopPropagation(); closeSession(s.id); }} use:tip={'Close session'}>&times;</button>
          {/if}
        </div>
      {/each}
      <button class="new-tab-btn" onclick={requestNewSession} use:tip={'New session'}>+</button>
      <!-- History recall: opens the in-webview searchable dropdown below. -->
      <button class="history-btn" class:active={historyOpen} onclick={toggleHistory} use:tip={'Recall a past chat'}>⟲</button>
      <!-- Layout cycler: single <-> grid, disabled in single mode until a second chat exists. -->
      <button
        class="grid-toggle-btn"
        class:active={chatLayout !== 'single'}
        disabled={sessions.length < 2 && chatLayout === 'single'}
        onclick={cycleChatLayout}
        use:tip={
          sessions.length < 2 && chatLayout === 'single'
            ? 'Open a second chat to enable the grid view'
            : chatLayout === 'single'
              ? 'Switch to grid view (all chats, tiled)'
              : 'Switch back to single-chat view'
        }
      >{chatLayoutGlyph(chatLayout)}</button>
      <!-- Export the active session's message log as markdown; disabled with
           no messages. Rendering + Save happens extension-side. -->
      {#if activeSession}
        <button
          class="export-btn"
          disabled={activeSession.messages.length === 0}
          onclick={() => activeSession && exportSession(activeSession)}
          use:tip={'Export this session as markdown'}
        >⤓</button>
      {/if}
    </div>
  {/if}

  <!-- In-webview history dropdown: searchable list of past chats, opened by
       the recall button or the palette/title-bar command. -->
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
            <button class="history-row" onclick={() => recallSession(h.sessionId)} use:tip={h.sessionId}>
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

  <!-- Unified cell renderer: each cell is a fully independent agent chat with
       its own stream, PermissionBar/PlanPanel/InputBar. The active session
       gets a subtle outline for image-paste/persistence focus, but every
       cell accepts input. -->
  <div
    class="chat-grid"
    class:layout-single={chatLayout === 'single'}
    class:layout-grid={chatLayout === 'grid'}
  >
    {#each visibleCells as cellSession (cellSession.id)}
      <!-- The sub-agent lists this cell has, joined ONCE per render: the todo
           panel's VISIBILITY now depends on them (t-geo4n3) as well as its
           contents, and a block-level `{@const}` is the only place a value can
           be shared by an `{#if}` condition and the component inside it.
           `now: 0` on purpose — the roster is read here for each sub-agent's
           KEY, TITLE and whether it has stopped; ages belong to the drawer,
           which owns the tick that keeps them honest. -->
      {@const subTodoLists = subagentTodoLists(subagentRows(subagentSource(cellSession), 0, new Set(cellSession.subagentsDismissed ?? [])), cellSession.subagentTodos)}
      <div
        class="chat-cell" data-session-id={cellSession.id}
        class:active={cellSession.id === activeSessionId}
        class:single={chatLayout === 'single'}
      >
        <!-- Header only shows in multi-up modes; single-mode uses the session
             tabs, except a solo tab which gets a quiet peer-name label. -->
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

        <!-- Right-edge rail of pull-outs: a column, not two centred overlays,
             because the browser strip sits directly above the task list. -->
        <div class="right-rail">
          {#if framesFor(browserFrames, cellSession.id).length > 0}
            <BrowserOverlay
              frames={framesFor(browserFrames, cellSession.id)}
              collapsed={browserShut[cellSession.id] ?? false}
              onToggleCollapse={() => (browserShut[cellSession.id] = !(browserShut[cellSession.id] ?? false))}
              onOpen={openLightbox}
              onReveal={revealFrame}
            />
          {/if}
          {#if todoOverlayVisible(cellSession.inFlight, cellSession.todoLingerTimer !== null, cellSession.todos, subTodoLists)}
            <TodoOverlay
              todos={cellSession.todos}
              source={cellSession.todoSource}
              collapsed={cellSession.todosCollapsed ?? false}
              onToggleCollapse={() => { cellSession.todosCollapsed = !(cellSession.todosCollapsed ?? false); sessions = [...sessions]; }}
              subagents={subTodoLists}
              selectedTab={cellSession.todoTab ?? MAIN_TAB}
              onSelectTab={(id) => { cellSession.todoTab = id; sessions = [...sessions]; }}
              hidden={cellSession.todoHidden}
              onClearCompleted={(id, keys) => { cellSession.todoHidden = withCleared(cellSession.todoHidden, id, keys); sessions = [...sessions]; }}
            />
          {/if}
        </div>

        <!-- Single per-turn arbiter decision: exactly one chip, never a stack
             of gate firings. -->
        {#if cellSession.arbiterDecision}
          <ArbiterChip decision={cellSession.arbiterDecision.decision} reason={cellSession.arbiterDecision.reason} />
        {/if}

        <!-- The [shape] heuristic sub-task decomposition is intentionally not
             rendered: it duplicates the model's own todos and never updates its
             status. Data still flows on taskShape for diagnostics only. -->

        <!-- Ctrl+F. Mounted OUTSIDE the scroller below, or the search would walk
             the bar's own text; it claims the key for itself (ChatFind.svelte). -->
        <ChatFind sessionId={cellSession.id} history={cellSession.history} revealFolded={() => { const was = !!cellSession.focusMode; cellSession.focusMode = false; return was; }} />
        <div class="cell-messages" data-session-id={cellSession.id} bind:this={messagesEl}
          use:watchResize={(el) => onMessagesResize(cellSession, el)} onwheel={(ev) => onMessagesWheel(cellSession, ev)}
          onscroll={(ev) => onMessagesScroll(cellSession, ev)}>
          <!-- Mirrors the most-recent user message as a sticky header. Not
               gated on inFlight: it persists until a new user message replaces
               it. A mirror only — the real row stays below. -->
          <PinnedUserMessage text={pinnedFor(cellSession)} />
          {#if cellSession.agentArt && chatLayout === 'single'}
            <!-- Agent banner art, single-mode only (no room in multi-up cells). -->
            <pre class="agent-banner" data-agent={cellSession.agentName}>{cellSession.agentArt}</pre>
          {/if}
          <ChatHistoryBar sessionId={cellSession.id} history={cellSession.history} empty={!hasConversation(shownMessages(cellSession))} />
          <ChatTranscript
            messages={shownMessages(cellSession)} ordinalSource={subagentSource(cellSession)}
            sessionId={cellSession.id}
            inFlight={cellSession.inFlight}
            currentThoughtMsgId={cellSession.currentThoughtMsgId}
            currentAgentMsgId={cellSession.currentAgentMsgId}
            openThoughtIds={cellSession.openThoughtIds}
            onThoughtOpenIds={(ids) => (cellSession.openThoughtIds = ids)}
            onImageClick={openLightbox}
            onRewind={rewindTo}
            onRetryTurn={retryTurn}
            focusMode={cellSession.focusMode ?? false} passthrough={isPassthrough(cellSession.kind)}
          />
          {#if cellSession.revertStash && cellSession.revertStash.length > 0 && capabilityOn(cellSession.kind, 'rewind')}
            <!-- Staged-rewind banner: the working tree is restored; the dropped
                 turns are gone on the next message. Undo (unrevert) until then. -->
            <div class="rewind-undo">
              <span class="rewind-undo-text">&#8630; Rewound — files restored. {cellSession.revertStash.length} message{cellSession.revertStash.length !== 1 ? 's' : ''} dropped; sending finalises it.</span>
              <button class="rewind-undo-btn" onclick={() => undoRewind(cellSession.id)}>Undo</button>
            </div>
          {/if}
          {#if !hasConversation(shownMessages(cellSession)) && !cellSession.history?.restoring}
            <!-- Empty state, shown until the first real turn. ChatEmptyState.svelte
                 owns the crane + rotating tip / offline setup guidance; the online
                 check stays here since it needs cellSession + panel fallbacks. -->
            <ChatEmptyState
              online={onlineBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelOnline : false)}
              providerLocal={providerLocalBySession[cellSession.id] ?? true}
              providerLabel={providerLabelBySession[cellSession.id] || ''}
              needsSetup={cellSession.needsSetup} botGlyph={cellSession.botGlyph}
            />
          {/if}
          {#if cellSession.inFlight}
            <!-- Driven by the per-session inFlight flag, set on send and cleared
                 on done/error/blocked, so it can't out-live the turn. -->
            <div class="stream-indicator">
              <ThinkingGlyph active={cellSession.inFlight} />
              <LoadingCycler active phrases={['thinking…', 'reasoning…', 'working…', 'composing…']} />
            </div>
          {/if}
          <NestAwayBlock sessionId={cellSession.id} />
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

        <!-- `changes` is derived per cell from that cell's own transcript, not a
             running counter, so it rebuilds itself correctly after a webview reload. -->
        <NestReadOnlyGate sessionId={cellSession.id}><InputBar
          inFlight={cellSession.inFlight}
          agentName={cellSession.agentName}
          modelName={prettyModel(modelBySession[cellSession.id]) || nameBySession[cellSession.id] || (cellSession.id === activeSessionId ? modelName : '')}
          modelOnline={onlineBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelOnline : false)}
          modelReason={reasonBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? modelReason : '')}
          isVlm={isVlmBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? isVlm : false)}
          visionState={visionStateBySession[cellSession.id] ?? (cellSession.id === activeSessionId ? visionState : 'auto-off')}
          providerLabel={providerLabelBySession[cellSession.id] ?? ''}
          providerIsLocal={providerLocalBySession[cellSession.id] ?? true}
          sessionId={cellSession.id} passthrough={isPassthrough(cellSession.kind)}
          placeholder={composerHint(cellSession)}
          onImageClick={openLightbox}
          anchorLabel={cellSession.stuckToBottom === false ? anchorLabel(cellSession.messages, cellSession.unseenFromId ?? null) : ''}
          onAnchorJump={() => { pinSessionCell(cellSession.id); cellSession.stuckToBottom = true; cellSession.unseenFromId = null; }}
          onCompact={() => compactSession(cellSession.id)}
          onSend={(text, mode) => handleSendForSession(cellSession, text, mode)}
          onCancel={() => handleCancelForSession(cellSession)}
          onExport={() => exportSession(cellSession)}
          canExport={cellSession.messages.length > 0}
          interjecting={cellSession.interjecting ?? false}
          changes={changesFor(cellSession)}
          focused={cellSession.focusMode ?? false}
          onToggleFocus={() => { cellSession.focusMode = !(cellSession.focusMode ?? false); }}
          onInterject={(text, images) => { armInterject(cellSession, text, images?.map((i) => i.dataUrl)); sessions = [...sessions]; vscode.postMessage({ type: 'interject', sessionId: cellSession.id, text, ...(images?.length ? { images } : {}) }); }}
        /></NestReadOnlyGate>
      </div>
    {/each}
    {#if visibleCells.length === 0}
      <div class="empty">No session</div>
    {/if}
  </div>

  <!-- THE LEFT RAIL, ONE PER PANE (t-fiszlv R18), keyed by the cell in focus —
       both drawers used to mount once per chat cell, each with its own window
       listener and its own request on every focus. They sit outside .chat-grid
       and anchor on .chat-pane, which is the positioned ancestor now. -->
  {#if dockCell}
    {@const dock = dockCell}
    <!-- The sub-agents this chat has out, derived from the transcript's own
         `task` cards — no second wire to disagree with (SubagentDock.svelte). -->
    <SubagentDock
      messages={subagentSource(dock)}
      dismissed={dock.subagentsDismissed ?? []}
      open={dock.subagentsOpen ?? false}
      chatTitle={`${dock.agentName} ${dock.number}${dock.title ? ': ' + dock.title : ''}`}
      onToggle={() => { dock.subagentsOpen = !(dock.subagentsOpen ?? false); sessions = [...sessions]; }}
      onDismiss={(key) => { dismissSubagent(dock, key); }}
      focusMode={dock.focusMode ?? false}
      onToggleFocus={() => { dock.focusMode = !(dock.focusMode ?? false); sessions = [...sessions]; }}
    />

    <!-- Side quests the main agent raised for later, from the workspace's own
         `.origami/sidequests` folder — the second drawer on this rail, above
         the one over it (SideQuestsDock.svelte). -->
    <SideQuestsDock
      sessionId={dock.id}
      open={dock.sideQuestsOpen ?? false}
      onToggle={() => { dock.sideQuestsOpen = !(dock.sideQuestsOpen ?? false); sessions = [...sessions]; }}
    />
  {/if}

  {#if activeAsk}
    <QuestionModal
      questions={activeAsk.questions}
      bind:currentIndex={questionAsks[activeAsk.sessionId].currentIndex}
      bind:answers={questionAsks[activeAsk.sessionId].answers}
      onSubmit={handleQuestionSubmit}
      onClose={closeQuestionModal}
    />
  {/if}
  <!-- One lightbox for the whole pane, not one per cell: the backdrop is
       position:fixed, so N mounts would stack N veils. -->
  <ImageLightbox src={lightbox?.src ?? null} alt={lightbox?.alt ?? ''} onClose={() => (lightbox = null)} />
</div>

<style>
  /* NO WRAPPER SURFACE. A2 (52c7241174) inset the pane and gave the cell a pill
     skin; the owner reverted that on 2026-09-21 (t-qi09w0) — the transcript sits
     flush on the webview background, as it did before. The rest of A2 stays. */
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

  /* The right-edge rail. It carries what the task overlay used to carry alone —
     the anchor, the width and the clip its collapse slide needs. */
  .right-rail {
    position: absolute;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);
    width: min(280px, 88%);
    max-height: 88%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-x: clip;
    z-index: 6;
    /* The rail is ALWAYS mounted; only its drawers may take a click, or an
       empty column would swallow every click on the transcript behind it. */
    pointer-events: none;
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

  /* Single mode dissolves the cell into the pane: one chat on screen needs no
     card around it, and the card is exactly what the owner asked to see gone. */
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
