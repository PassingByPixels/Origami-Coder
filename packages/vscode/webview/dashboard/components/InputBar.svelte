<script lang="ts">
  import { spotlight } from '../../shared/spotlight';
  import { tip } from '../../shared/warmTip';
  import ScrollAnchorPill from './ScrollAnchorPill.svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { type SlashCommand, buildSlashCommand, filterCommands, DEFAULT_COMMANDS, SHELL_COMMANDS } from '../lib/slashCommands';
  import { replaceSlashToken, slashDispatch, slashPaletteAt } from '../lib/slashAnywhere';
  import ModeControl from './ModeControl.svelte';
  import { isPlanningMode } from './modeControl';
  import { onMount } from 'svelte';
  import ImageStrip from './ImageStrip.svelte';
  import InterjectingChip from './InterjectingChip.svelte';
  import ChangesPill from './ChangesPill.svelte';
  import ComposerUtilityRow from './ComposerUtilityRow.svelte';
  import GaugeCounter from './GaugeCounter.svelte';
  import SendStopButton from './SendStopButton.svelte';
  import InterjectSendButton from './InterjectSendButton.svelte';
  import { createDragState, filesFromHost, hostReadable, nextDropId, planDrop } from './composerDropIntake';
  import type { SessionChanges } from '../panes/sessionChanges';
  import ModelPicker from './ModelPicker.svelte';

  import SlashDropdown from './SlashDropdown.svelte';
  import ComposerModeRow from './ComposerModeRow.svelte';
  import CompactionThresholdMenu from './CompactionThresholdMenu.svelte';
  import ContextBreakdownCard from './ContextBreakdownCard.svelte';
  import { watchPinned } from './ctxCardPin';
  import CtxPinButton from './CtxPinButton.svelte';
  import { asComposition, usedOf, type ContextComposition } from './contextComposition';
  import { clickFuse, FUSE_MS, type FusePhase } from './contextFuse';
  import FuseOverlay from './FuseOverlay.svelte';
  import { actionsRowOptions, approveButtonState } from './approveButtonState';
  import SpendBadge from './SpendBadge.svelte';
  import { type AuthKind } from './billing';
  import { fmtUsd } from '../lib/money';
  import type { VisionState } from './visionPinState';
  import { readComposerImage } from './composerImages';
  import { prefillFor } from './composerPrefill';
  import { readTextAttachment, foldAttachments, looksLikeImage, type TextAttachmentFile } from './composerAttachments';
  import { decodeUriList, insertRun } from './composerCaret';
  import TextAttachmentStrip from './TextAttachmentStrip.svelte';
  import { orderEffortLevels } from './effortOrder';
  import ModelWarning from './ModelWarning.svelte';
  import { NO_CONNECTIONS, NO_CONNECTIONS_TEXT } from './modelBanner';
  import { applyMention, filterMentions, mentionQuery, type MentionCandidate } from '../../chat/collabMentions';
  import { growHeight } from '../lib/composerGrow';
  import { interjectHold } from './interjectHold';

  interface Props {
    inFlight: boolean;
    agentName: string;
    modelName: string;
    modelOnline?: boolean;
    modelReason?: string;
    /** Whether the loaded model is vision-capable; lights the Vision button as native. */
    isVlm?: boolean;
    /** Auto-vs-pinned vision for this chat's model; passed straight through to the Vision control. */
    visionState?: VisionState;
    /** This chat's provider display name + whether it's the loopback LM Studio,
     *  so the offline banner names the right server. */
    providerLabel?: string;
    providerIsLocal?: boolean;
    /** Id of the chat tab the InputBar is attached to. Captured at paste time
     *  so images route back to that session even after a tab switch. */
    sessionId?: string | null;
    /** An attached thumbnail was clicked — passed straight through to the
     *  strip; this component owns which images exist, not how one displays. */
    /** The scroll anchor's wording, counted off the MESSAGE LIST by the pane
     *  (scrollAnchor.ts). '' hides the pill. */
    anchorLabel?: string;
    /** The pill was clicked: the pane re-pins the transcript (chatPin.ts). */
    onAnchorJump?: () => void;
    onImageClick?: (src: string, alt: string) => void;
    /** Gauge click — the parent shows a branded confirm before compacting. */
    onCompact?: () => void;
    /** Returning `false` means the parent refused the line, the only case the
     *  draft is kept (`passthroughSlash`). `images` is slot three because slot
     *  two is the chat's own mode (`/loop`, `/compose`). */
    onSend: (text: string, mode?: string, images?: ComposerImage[]) => boolean | void;
    onCancel: () => void;
    /** Export this conversation as markdown. Provided per-cell by ChatPane so
     *  it's available in the solo editor-tab view too. */
    onExport?: () => void;
    canExport?: boolean;
    /** One or more lines are with the host, unacknowledged, for delivery into
     *  the running turn (interjectSplit.ts). */
    interjecting?: boolean;
    /** What this chat has changed so far, rolled up by the caller from its own
     *  transcript (panes/sessionChanges.ts). Absent = nothing to show. */
    changes?: SessionChanges;
    /** Focus view for this chat (ChangesPill's eye). `onToggleFocus` absent —
     *  the bare collab composer — draws no eye at all. */
    focused?: boolean; onToggleFocus?: () => void;
    /** Deliver a line typed during a turn into that turn, now, with whatever
     *  is attached (`sendWithImages`'s `{dataUrl,name}` shape). Its absence is
     *  what makes a mount refuse to send mid-turn (interjectHold.ts). */
    onInterject?: (text: string, images?: ComposerImage[]) => void;
    // --- The collab surface. Every prop below defaults to the chat behaviour,
    // so a mount that omits them is bit-identical to the chat composer. ---
    /** A fixed command list instead of the engine's `availableCommands`: a
     *  collab has no engine session of its own. */
    commands?: SlashCommand[];
    /** Hand the raw trimmed line to `onSend` — no slash interception, no image
     *  branch. The parent owns the parse, and says so by returning `false`. */
    passthroughSlash?: boolean;
    /** A read-only surface (an archived collab): the box and Send are dead. */
    disabled?: boolean;
    placeholder?: string;
    /** Strip the composer to the textarea, Send, `/` and Export — everything
     *  else is about an engine session, which a collab composer lacks. */
    bare?: boolean;
    /** The active collab roster, which gates the `@` picker. Absent (every
     *  chat mount) means `@` is an ordinary character. */
    participants?: MentionCandidate[];
    /** Let a bare composer attach images too; a passthrough surface has no
     *  session, so its attachments go to the parent on `onSend`. */
    allowImages?: boolean;
    /** Claude Code passthrough cell — hides /compact, the sub-agent model
     *  target and the second-opinion scales (passthroughCaps.ts). */
    passthrough?: boolean;
  }

  interface ImageAttachment { id: number; name: string; dataUrl: string; }
  /** What leaves this component — no local id, which is the strip's bookkeeping. */
  interface ComposerImage { dataUrl: string; name: string; }

  let { anchorLabel = '', onAnchorJump, inFlight, agentName, modelName, modelOnline = false, modelReason = '', isVlm = false, visionState = 'auto-off', providerLabel = '', providerIsLocal = true, sessionId = null, onImageClick, onCompact, onSend, onCancel, onExport, canExport = false, interjecting = false, changes, focused = false, onToggleFocus, onInterject, commands, passthroughSlash = false, disabled = false, placeholder = '', bare = false, participants, allowImages = false, passthrough = false }: Props = $props();
  // Nothing connected (not "nothing loaded"): a turn typed here has nowhere to
  // go, so the composer refuses it and says why rather than failing at send time.
  let noConn = $derived(modelReason.trim() === NO_CONNECTIONS);
  /** One gate for the strip, the paste handler and the drop handler, so the
   *  three cannot end up answering differently. */
  const imagesOn = $derived(!bare || allowImages);
  let inputText = $state('');
  let inputEl: HTMLTextAreaElement | undefined = $state();
  let showSlash = $state(false);
  let slashFilter = $state('');
  // The span a completion replaces — the whole line, or just the token under the
  // caret when one was typed mid-message (slashPaletteAt, t-qi09w0).
  let slashStart = $state(0);
  let slashEnd = $state(0);
  let selectedIdx = $state(0);
  // The `@` picker — its OWN flag and cursor, never the slash palette's.
  let showMentions = $state(false);
  let mentionFilter = $state('');
  let mentionIdx = $state(0);
  let images: ImageAttachment[] = $state([]);
  let nextImageId = 0;
  // Non-image drops (a doc, a source file, …) — independent of `imagesOn`.
  let textAttachments: TextAttachmentFile[] = $state([]);
  let nextTextAttachmentId = 0;
  /** An Enter that arrived mid-turn on a composer with no turn to reach, waiting for idle. */
  let heldForIdle = $state(false);
  /** Why the last mid-turn Enter did not go into the turn (interjectHold.ts). */
  let heldReason = $state('');
  $effect(() => { if (!inFlight && heldForIdle) { heldForIdle = false; doSend(); } });
  // Locked at the moment of the first paste; a session switch doesn't move it,
  // so the bound send routes back to the original session. Reset when images
  // are cleared so the next paste captures fresh.
  let pasteSessionId: string | null = $state(null);
  // The model's real effort variants (from the engine's `effort` configOption),
  // not hardcoded think/quick. Empty means the model has no variants.
  let effortOptions = $state<Array<{ value: string; name: string }>>([]);
  // The engine's own baseline (its advertised list's first entry, before this
  // component re-sorts for display) — "Active" means "off the baseline", and
  // that has to survive the display sort, not track effortOptions[0] anymore.
  let effortBaseline = $state('');
  let effortCurrent = $state('');
  let permissionMode = $state('default');
  // Scoped to this chat panel: 'build'/'default' is the baseline, 'plan' and
  // 'deep-plan' are read-only, so both gate the approve rail below.
  let isPlanning = $derived(isPlanningMode(permissionMode));
  // Scoped auto-approve preset for this chat, independent of the plan/build
  // agent: 'default' asks on every tool, 'auto' auto-approves edits, 'bypass'
  // auto-approves everything. Resets to 'default' on reload (fail-closed).
  let approveMode = $state('default');
  // VS Code's own global chat-tool auto-approve, read live from the host.
  // t-obf3jw: bypass is now the default (browserVsCode.ts's globalAutoApprove
  // reads an unset setting as bypass), so 'bypass' is what shows before the
  // first requestBrowserAutoApprove reply lands, not 'ask'.
  let browserApproveMode = $state('bypass');
  // What the merged button says/wears — a pure function of both settings,
  // extracted to approveButtonState.ts. Shows the riskier of the two. Browser
  // has no row to pick a mode from any more, but still feeds the badge so the
  // button is honest if a user has explicitly set the VS Code setting to off.
  let approveButton = $derived(approveButtonState(approveMode, browserApproveMode, passthrough));
  // The popover's one row. Actions is disabled in plan mode.
  // t-obf3jw: the Browser row (Ask/Bypass) is REMOVED — bypass-browser is now
  // the default with no setup action, so there is nothing left to pick here.
  // The setting itself is unchanged and remains an OFF switch reachable
  // directly in VS Code's own Settings UI (chat.tools.global.autoApprove).
  let approveRows = $derived([
    {
      key: 'actions', title: 'Actions:',
      mode: approveMode, options: actionsRowOptions(passthrough), disabled: isPlanning,
      onSelect: selectActionsMode,
    },
  ]);
  // The per-chat vision profile. '' is off and is the default: the route costs
  // a tool schema and a prompt block on every image turn, so it's opted into
  // per chat, never inherited. Written through the engine's `visionProfile`
  // session config option, so a reload starts from there rather than from here.
  let visionProfile = $state('');
  /** Profile slugs offered in the menu, from the host's def listing. Empty is a
   *  real state with its own copy — "none configured" is a different problem
   *  from "none chosen", and one sends you to the Agents board. */
  let visionAgents = $state<string[]>([]);
  function setVision(slug: string) {
    visionProfile = slug; // optimistic; visionUpdate confirms
    vscode.postMessage({ type: 'setVisionProfile', profile: slug, sessionId });
  }
  let effortLabel = $derived(effortOptions.find(o => o.value === effortCurrent)?.name ?? 'Effort');
  // "Active" = a non-baseline effort is selected (baseline = the engine's
  // advertised default, not the display-sorted first entry).
  let effortActive = $derived(effortOptions.length > 1 && !!effortCurrent && effortCurrent !== effortBaseline);

  // Context tracking: real token counts from the engine's `usageUpdate` frames,
  // with the host's `contextUpdate` as the fallback before the first frame lands.
  let contextWindow = $state(0);
  let turns = $state(0);
  let contextUsed = $state(0);
  let contextTotal = $state(0);
  // The engine's split of the last turn's prompt tokens, off usageUpdate /
  // contextUpdate. Undefined on an engine that does not report one, and that is
  // the no-card path: the gauge keeps its own title rather than drawing invented
  // parts. Held, never cleared by a frame that omits it.
  let composition = $state<ContextComposition | undefined>(undefined);
  let trend = $state<number[] | undefined>(undefined); // host's last 20 readings (contextTrend.ts, t-ru1i84)
  // Hover/focus over the gauge, and the PIN (t-ru13hb item 5): its own control, not the
  // gauge's click, which arms the compaction fuse (ctxCardPin.test.ts header; ctxCardPin.ts).
  let ctxCardOpen = $state(false);
  let ctxPinned = $state(false);
  let ctxWrapEl = $state<HTMLElement | null>(null);
  let ctxPopEl = $state<HTMLElement | null>(null);
  $effect(() => (ctxPinned ? watchPinned([ctxPopEl, ctxWrapEl], () => (ctxPinned = false)) : undefined));
  // True from when a /compact finishes until the next real turn's usage_update
  // carries the reduced footprint; drives a "pending" cue on the gauge.
  let compactionPending = $state(false);
  // Right-click menu's picked auto-compaction trigger. Raw wire value
  // ('' = auto, 'NN%', or a token count); an optimistic echo only — a reopened
  // chat does not read the persisted override back (see acp/service.ts).
  let compactionThresholdValue = $state('');
  let compactionMenuOpen = $state(false);
  // t-okz748 — the gauge pill's own fuse; see contextFuse.ts for the state machine.
  let fusePhase = $state<FusePhase>('idle');
  let fuseTimer: ReturnType<typeof setTimeout> | null = null;
  function onGaugeClick() {
    const r = clickFuse(fusePhase, fuseTimer, () => { fuseTimer = null; fusePhase = 'idle'; onCompact?.(); });
    fusePhase = r.phase;
    fuseTimer = r.timer;
  }
  // This chat's cumulative cost in USD (usage_update.cost.amount). 0 for
  // local/free models. Parent-only; the rollup below is a separate number so
  // the badge can name both halves instead of one opaque total.
  let sessionCost = $state(0);
  // What the sub-agents this chat spawned have spent, off usage_update's
  // optional additive `subagents` field. Not double-counted against a child's
  // own composer: a mounted sub-agent session draws its own InputBar with its
  // own cost, and this parent draws the rollup.
  let subagentCost = $state(0);
  let totalCost = $derived(sessionCost + subagentCost);
  // Claude Code passthrough only. `subscription` says the dollar figure above
  // is notional and must not be shown; retracted on unbind (claudeCodeCell.unbindCell)
  // so an engine turn is never priced by a leftover Claude badge.
  let ccMeter = $state({ subscription: false });
  // The engine's own native OAuth connections hit the same "plan, not money"
  // question ccMeter answers for passthrough — billing.ts decides from the
  // session's raw provider id plus whether it holds an OAuth credential.
  let modelBySession = $state<Record<string, string>>({});
  let oauthConnected = $state<Record<string, { type: string; expires?: number }>>({});
  let currentProviderId = $derived(sessionId ? (modelBySession[sessionId] ?? '').split('/')[0] : '');
  let authKind = $derived<AuthKind>(!currentProviderId ? 'unknown' : oauthConnected[currentProviderId] ? 'oauth' : 'apiKey');
  // This session's own `/` rows, from the CLI's init. Empty on every engine
  // chat, which is what keeps `slashCommands` below bit-identical for one.
  let ccCommands: SlashCommand[] = $state([]);
  // Monthly OpenRouter spend + cap (global, from spendUpdate / budgetUpdate) — the
  // warn-at-80% / block-at-100% banner. monthBudget null ⇒ no cap ⇒ no banner.
  let monthSpend = $state(0);
  let monthBudget = $state<number | null>(null);
  let budgetPct = $derived(monthBudget && monthBudget > 0 ? Math.round((monthSpend / monthBudget) * 100) : 0);
  function raiseBudget() {
    vscode.postMessage({ type: 'setBudget', monthly: (monthBudget ?? 0) + 5, sessionId }); // t-xsufto: the note lands in this chat
  }

  // Listener lives in onMount with a cleanup so closed grid cells release it
  // (every session mounts its own InputBar in grid layout). Session-scoped
  // events are filtered by sessionId to avoid cross-session bleed; a message
  // with no sessionId is treated as a broadcast and accepted.
  onMount(() => {
    const onMsg = (event: MessageEvent) => {
      if (event.data?.type === 'droppedFiles' && myDrops.delete(event.data.dropId)) attachFiles(filesFromHost(event.data.files), false); // t-z69b8m
      const msg = event.data || {};
      const forThisSession = msg.sessionId == null || msg.sessionId === sessionId;
      if (msg.type === 'contextUpdate' && forThisSession) {
        turns = msg.turns ?? turns;
        contextWindow = msg.contextWindow ?? contextWindow;
        if (typeof msg.contextUsed === 'number') contextUsed = msg.contextUsed;
        if (typeof msg.contextTotal === 'number') contextTotal = msg.contextTotal;
        if (Array.isArray(msg.trend)) trend = msg.trend; // t-ru1i84 — the host's per-session ring
        composition = asComposition(msg.composition) ?? composition;
      }
      if (msg.type === 'usageUpdate' && forThisSession) {
        // Engine's authoritative per-turn accounting. The engine omits the
        // frame when it can't resolve a context limit, so contextTotal holds
        // its last value. Not gated on the turn ending: these throttle to
        // roughly one every two seconds mid-turn, so the gauge and cost move
        // live rather than only appearing after a long turn.
        if (typeof msg.used === 'number') contextUsed = msg.used;
        if (typeof msg.size === 'number' && msg.size > 0) contextTotal = msg.size;
        composition = asComposition(msg.composition) ?? composition;
        if (msg.cost && typeof msg.cost.amount === 'number') sessionCost = msg.cost.amount;
        // Optional + additive. A frame that omits it holds the last value
        // rather than snapping the rollup back to zero.
        if (msg.subagents && typeof msg.subagents.cost === 'number') subagentCost = msg.subagents.cost;
        // A real turn landed with the post-compaction footprint — the queued
        // reduction has applied, so clear the pending cue.
        compactionPending = false;
      }
      // Global spend/budget broadcasts (no sessionId) — the warn/block banner.
      if (msg.type === 'spendUpdate' && typeof msg.total === 'number') monthSpend = msg.total;
      if (msg.type === 'budgetUpdate') monthBudget = typeof msg.monthly === 'number' ? msg.monthly : null;
      if (msg.type === 'compactionEnd' && forThisSession) {
        // /compact finished. The drop is lazy (applies at the next real turn),
        // so flag it pending: the gauge shows it worked and is queued, and the
        // next usageUpdate above clears it as the reduced value lands.
        compactionPending = msg.ok !== false;
      }
      // A brief the host put in this composer for the owner to send himself
      // (t-f89g49, Start on a side quest). The RULE — exact session, never over
      // a draft — is composerPrefill.ts's, not this listener's: it is the only
      // message that writes text the user did not type.
      const prefill = prefillFor(msg, sessionId, inputText);
      if (prefill !== null) {
        inputText = prefill;
        // Focused and caret at the END, so the owner can add a line before
        // sending rather than landing in front of the brief.
        setTimeout(() => { inputEl?.focus(); inputEl?.setSelectionRange(prefill.length, prefill.length); }, 0);
      }
      if (msg.type === 'modeUpdate' && forThisSession) {
        permissionMode = msg.mode ?? permissionMode;
      }
      if (msg.type === 'modeOptions' && forThisSession) {
        // Seed this panel's mode from the engine's authoritative current
        // (e.g. on session create or recall of a plan-mode session).
        if (typeof msg.current === 'string') permissionMode = msg.current;
      }
      if (msg.type === 'approveUpdate' && forThisSession) {
        if (typeof msg.mode === 'string') approveMode = msg.mode;
      }
      // GLOBAL, not session-scoped (like spendUpdate/budgetUpdate below) — VS
      // Code's own setting, so every open composer converges on one value.
      if (msg.type === 'browserAutoApproveUpdate' && typeof msg.value === 'boolean') {
        browserApproveMode = msg.value ? 'bypass' : 'ask';
      }
      if (msg.type === 'visionUpdate' && forThisSession) {
        if (typeof msg.profile === 'string') visionProfile = msg.profile;
      }
      // NOT session-scoped: the profile ROSTER is a directory on disk, shared by
      // every chat. Only which one THIS chat picked is per-session.
      if (msg.type === 'collabAgentDefs' && Array.isArray(msg.visionDefs)) {
        visionAgents = msg.visionDefs.map((d: { slug?: unknown }) => String(d?.slug ?? '')).filter(Boolean);
      }
      if (msg.type === 'effortOptions' && forThisSession) {
        // The engine advertises its ladder in the backend's own order (default
        // first, per catalogDefaultFirst) — not rank order. Sort for display
        // here; capture the baseline BEFORE sorting, since effortActive below
        // used to read it off options[0] and the sort no longer guarantees
        // that position holds the default.
        const rawOptions = Array.isArray(msg.options) ? msg.options : [];
        effortBaseline = rawOptions[0]?.value ?? '';
        effortOptions = orderEffortLevels(rawOptions);
        effortCurrent = String(msg.current ?? '');
      }
      if (msg.type === 'reasoningUpdate' && forThisSession) {
        if (typeof msg.mode === 'string') effortCurrent = msg.mode;
      }
      if (msg.type === 'compactionThresholdUpdate' && forThisSession) {
        if (typeof msg.value === 'string') compactionThresholdValue = msg.value;
      }
      if (msg.type === 'passthroughMeter' && forThisSession) {
        ccMeter = { subscription: msg.subscription === true };
      }
      // Feeds currentProviderId / authKind above (billing.ts) — global broadcasts, not session-tagged.
      if (msg.type === 'sessionModels') modelBySession = (msg.models && typeof msg.models === 'object') ? msg.models : {};
      if (msg.type === 'providerAuthData') oauthConnected = (msg.connected && typeof msg.connected === 'object') ? msg.connected : {};
      if (msg.type === 'passthroughCommands' && Array.isArray(msg.commands) && forThisSession) {
        ccCommands = msg.commands.map(buildSlashCommand);
      }
      if (msg.type === 'availableCommands' && Array.isArray(msg.commands) && forThisSession) {
        // Engine commands replace the list; re-append the shell-only ones the
        // engine doesn't know about (/firstfold is intercepted host-side).
        engineCommands = [...msg.commands.map(buildSlashCommand), ...SHELL_COMMANDS];
      }
    };
    window.addEventListener('message', onMsg);
    // Seed the spend/budget banner (a fresh composer, before any turn). A bare
    // composer has no banner to seed.
    if (!bare) vscode.postMessage({ type: 'requestSpend' });
    // Seed the Browser Ask/Bypass control — a bare composer has no mode row to show it in.
    if (!bare) vscode.postMessage({ type: 'requestBrowserAutoApprove' });
    // The vision-profile roster, asked for here so the button can say which
    // profile is armed the moment the composer mounts.
    if (!bare) vscode.postMessage({ type: 'listCollabAgentDefs' });
    // Seed the SpendBadge billing inputs — ModelPicker asks for the same two
    // broadcasts, but this bar must not depend on its child's mount order.
    if (!bare) { vscode.postMessage({ type: 'requestSessionModels' }); vscode.postMessage({ type: 'providerAuthRequest' }); }
    return () => window.removeEventListener('message', onMsg);
  });

  // Denominator: prefer the actually-loaded context window from the model
  // probe (the real ceiling) and fall back to the engine's reported limit only
  // when there's no probe. The engine's declared max overstates a locally
  // loaded window, which gave a false low %. If neither is known, show no
  // percentage rather than a confident wrong number.
  let gaugeTotal = $derived(contextWindow > 0 ? contextWindow : (contextTotal > 0 ? contextTotal : 0));
  let contextKnown = $derived(gaugeTotal > 0);
  let contextPct = $derived(contextKnown ? Math.min(100, Math.round((contextUsed / gaugeTotal) * 100)) : 0);
  let contextColor = $derived(contextPct >= 80 ? 'var(--og-error)' : contextPct >= 60 ? 'var(--og-warning)' : 'var(--og-success)');
  // `contextWindow > 0` means a live probe supplied this number; at 0,
  // gaugeTotal fell back to contextTotal, a real but un-probed catalog max —
  // so the tooltip must not call it "loaded". The click-to-compact affordance
  // is identical either way; only the wording of what the % is of changes.
  let windowSourceLabel = $derived(contextWindow > 0 ? "loaded context window" : "context window (catalog max)");

  function fmtK(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
    return String(n);
  }

  const vscode = getVsCodeApi();

  // Dynamic command list, populated from ACP AvailableCommandsUpdate; falls
  // back to DEFAULT_COMMANDS until the harness sends the real list.
  let engineCommands: SlashCommand[] = $state(DEFAULT_COMMANDS);
  // A given `commands` list is authoritative and never merged with the
  // engine's: the engine's vocabulary belongs to a session this surface may
  // not have. A passthrough cell shows Claude's commands and nothing else —
  // SHELL_COMMANDS don't apply, since claudeCodeManager doesn't intercept
  // `slashCommand`, so those would act on the engine session hiding underneath.
  let slashCommands: SlashCommand[] = $derived(commands ?? (ccCommands.length ? ccCommands : engineCommands));

  // filterCommands (lib/slashCommands) is the one matcher, shared with the Cmd-K palette.
  let filteredCommands = $derived(() => filterCommands(slashCommands, slashFilter));

  // The picker's rows, in the same shape the `/` palette draws.
  let mentionHits = $derived(filterMentions(participants ?? [], mentionFilter));
  let mentionRows = $derived(mentionHits.map((p) => ({ name: `@${p.slug}`, description: p.name, category: 'agent' })));

  function handleInput() {
    // slashAnywhere.ts owns the rule; the owner's first-command-only rule is
    // about EXECUTION (doSend, below) and is untouched by it.
    const p = slashPaletteAt(inputText, inputEl?.selectionStart ?? inputText.length);
    showSlash = p.open; slashStart = p.start; slashEnd = p.end;
    if (showSlash) { slashFilter = p.filter; selectedIdx = 0; }
    // Never both at once: a `/` line is a command, and no roster means no picker.
    const q = showSlash || !participants?.length ? null : mentionQuery(inputText, inputEl?.selectionStart ?? inputText.length);
    showMentions = q !== null;
    if (q) { mentionFilter = q.query; mentionIdx = 0; }
  }

  // Auto-grow: rest height is 2 lines, growing with content to a 10-line cap,
  // then it scrolls. Reset to 'auto' first so scrollHeight reports the
  // content's real height rather than the box's last-set one.
  function resizeComposer(_text: string) {
    const el = inputEl;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const { height, overflow } = growHeight({ scrollHeight: el.scrollHeight, lineHeight, padding, minRows: 2, maxRows: 10 });
    el.style.height = `${height}px`;
    el.style.overflowY = overflow;
  }
  // `inputText` is read as an argument, not discarded via `void`, so the
  // compiler can't treat the read as a no-op and drop the dependency.
  $effect(() => resizeComposer(inputText));

  /** Insert `@slug ` over the half-typed handle, caret after it (not at the
   *  end of the line — a mention can sit mid-sentence). */
  function selectMention(i: number) {
    const hit = mentionHits[i];
    if (!hit) return;
    const next = applyMention(inputText, inputEl?.selectionStart ?? inputText.length, hit.slug);
    inputText = next.text;
    showMentions = false;
    inputEl?.focus();
    setTimeout(() => inputEl?.setSelectionRange(next.caret, next.caret), 0);
  }

  function selectCommand(cmd: SlashCommand) {
    // The two MODE commands act on the session and leave no text behind; every
    // other command completes to its name. One splice serves both, and for a
    // leading slash (0..length) it IS the old whole-line replacement.
    const acts = cmd.name === '/reasoning' || cmd.name === '/plan';
    if (cmd.name === '/reasoning') cycleEffort();
    if (cmd.name === '/plan') selectMode(permissionMode === 'plan' ? 'build' : 'plan');
    const next = replaceSlashToken(inputText, slashStart, slashEnd, acts ? '' : cmd.name + ' ');
    inputText = next.text;
    showSlash = false;
    inputEl?.focus();
    // Caret after the insertion, not at the end — a mid-sentence command has
    // prose behind it. Deferred like selectMention's: the value must land first.
    setTimeout(() => inputEl?.setSelectionRange(next.caret, next.caret), 0);
  }

  function cycleEffort() {
    // Cycle through the model's REAL effort variants (whatever the engine
    // advertised). No-op if the model has none — the button is hidden then.
    if (effortOptions.length === 0) return;
    const idx = effortOptions.findIndex(o => o.value === effortCurrent);
    const next = effortOptions[(idx + 1) % effortOptions.length];
    effortCurrent = next.value; // optimistic; reasoningUpdate confirms
    vscode.postMessage({ type: 'setEffort', effort: next.value, sessionId });
  }

  function selectMode(modeId: string) {
    // Optimistic: the host snaps the button back if the engine refuses.
    permissionMode = modeId;
    vscode.postMessage({ type: 'setMode', modeId, sessionId });
    // Entering a planning agent, drop any auto-approve preset: 'bypass' would
    // otherwise override the agent's edit-deny and break the mode's guarantee.
    if (isPlanningMode(modeId) && approveMode !== 'default') {
      approveMode = 'default';
      vscode.postMessage({ type: 'setApproveMode', mode: 'default', sessionId });
    }
  }

  function openCompactionMenu(e: Event) {
    // Right-click OR Shift+F10/the Menu key while the gauge is focused — both
    // dispatch a real `contextmenu` event, so no extra keybinding is needed.
    e.preventDefault();
    e.stopPropagation();
    compactionMenuOpen = true;
  }
  function selectCompactionThreshold(value: string) {
    compactionThresholdValue = value; // optimistic; compactionThresholdUpdate confirms
    compactionMenuOpen = false;
    vscode.postMessage({ type: 'setCompactionThreshold', value, sessionId });
  }

  /** Actions row: this chat's own scoped auto-approve. A no-op in either
   *  planning mode (a read-only agent has nothing to auto-approve) —
   *  belt-and-braces with the row's own `disabled`, which already stops the
   *  click from firing. */
  function selectActionsMode(value: string) {
    if (isPlanning) return;
    approveMode = value; // optimistic; approveUpdate confirms
    vscode.postMessage({ type: 'setApproveMode', mode: value, sessionId });
  }

  /** Validate, read, optionally resize, and attach a single image file. The
   *  rules and the refusal wording live in composerImages.ts; what stays here
   *  is what only the composer knows — where an accepted image is kept, and
   *  where a refusal is shown. */
  async function attachImageFile(file: File) {
    const taken = await readComposerImage(file);
    if (!taken.ok) {
      vscode.postMessage({ type: 'imageError', message: taken.error, sessionId }); // t-xsufto: reported in this chat
      return;
    }
    // Capture sessionId on the first attachment so a tab switch between
    // paste and send doesn't move the destination.
    if (images.length === 0) pasteSessionId = sessionId;
    images = [...images, { id: nextImageId++, name: taken.name, dataUrl: taken.dataUrl }];
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) void attachImageFile(file);
        return;
      }
    }
  }

  /** Items, space-padded, spliced at the current selection (or appended when
   *  the textarea isn't mounted). Shared by the uri-list and filename cases. */
  function insertRunAtCaret(items: string[]) {
    const el = inputEl;
    const { text, caret } = insertRun(inputText, el?.selectionStart ?? inputText.length, el?.selectionEnd ?? inputText.length, items);
    inputText = text;
    el?.focus();
    setTimeout(() => el?.setSelectionRange(caret, caret), 0);
  }

  /** A non-image file: the name lands at the caret, and — unless the file is
   *  binary — a chip carries the content for `foldAttachments` at send time. */
  async function attachTextFile(file: File, insertName = true) {
    if (insertName) insertRunAtCaret([file.name || 'attachment']);
    const intake = await readTextAttachment(file);
    if (intake.kind === 'text') {
      textAttachments = [...textAttachments, { id: nextTextAttachmentId++, name: intake.name, content: intake.content, truncated: intake.truncated }];
    }
  }
  function removeTextAttachment(id: number) {
    textAttachments = textAttachments.filter((a) => a.id !== id);
  }

  /** Triage on a raw DataTransfer (rules: composerDropIntake.ts, t-z69b8m). URIs
   *  (a VS Code explorer drag) put the path in the text and ask the host for the
   *  bytes; the host's `droppedFiles` answer comes back through `attachFiles`. */
  const myDrops = new Set<string>();
  function triageDrop(dt: DataTransfer) {
    const plan = planDrop(dt);
    if (plan.kind === 'files') attachFiles(plan.files, true);
    if (plan.kind !== 'uris') return;
    insertRunAtCaret(plan.uris.flatMap((u) => decodeUriList(u)));
    const dropId = nextDropId(), uris = hostReadable(plan.uris);
    if (uris.length) { myDrops.add(dropId); vscode.postMessage({ type: 'readDroppedFiles', dropId, uris }); }
  }
  function attachFiles(files: File[], insertName: boolean) {
    for (const file of files) { if (!looksLikeImage(file)) void attachTextFile(file, insertName); else if (imagesOn) void attachImageFile(file); }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation(); // stops ChatPane's pane-level fallback triaging it twice
    // …which is also why the hint is cleared HERE and not only on the box's
    // own `drop`: the event never reaches it.
    drag.event('drop');
    if (e.dataTransfer) triageDrop(e.dataTransfer);
  }
  /** Exposed for ChatPane: a drop outside every composer still goes somewhere
   *  rather than navigating the webview — this is that somewhere. */
  export function receiveExternalDrop(dt: DataTransfer) { triageDrop(dt); }

  function handleDragOver(e: DragEvent) { e.preventDefault(); drag.event('over'); }
  // The "Drop to attach" state: a COUNTED depth plus every reset (composerDropIntake.ts).
  let dropping = $state(false);
  const drag = createDragState((v) => (dropping = v)); $effect(() => drag.destroy);
  function removeImage(id: number) {
    images = images.filter(img => img.id !== id);
    if (images.length === 0) pasteSessionId = null;
  }

  function handleKeydown(e: KeyboardEvent) {
    // The picker first. Enter COMPLETES on every surface, passthrough included:
    // a mention is a PREFIX of the line, so it can swallow no command or error.
    if (showMentions) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIdx = Math.min(mentionIdx + 1, mentionRows.length - 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIdx = Math.max(mentionIdx - 1, 0); return; }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && mentionRows.length > 0) { e.preventDefault(); selectMention(mentionIdx); return; }
      if (e.key === 'Escape') { e.preventDefault(); showMentions = false; return; }
    }
    if (showSlash) {
      const cmds = filteredCommands();
      if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, cmds.length - 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); return; }
      // Enter completes only where a command is a prefix of the real line; on
      // a passthrough surface a command is the whole line, so eating Enter
      // there would swallow the missing-argument error.
      // Enter completes only for a LEADING slash (slashStart 0), where the line IS
      // the command. Mid-message the line is prose the user means to SEND, so
      // Enter still sends it — Tab and the mouse are what complete there.
      if (e.key === 'Tab' || (!passthroughSlash && slashStart === 0 && e.key === 'Enter' && cmds.length > 0 && !e.shiftKey)) { e.preventDefault(); if (cmds[selectedIdx]) selectCommand(cmds[selectedIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); showSlash = false; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  }

  function doSend() {
    if (!inputText.trim() && images.length === 0 && textAttachments.length === 0) return;
    const text = inputText.trim();
    showMentions = false;
    heldReason = '';

    // Passthrough surface: the parent parses the line itself. It answers
    // `false` when it refused the line, so the draft is kept rather than
    // forcing a full retype. Ahead of the in-flight branch: this surface has
    // no turn of its own to interject into.
    if (passthroughSlash) {
      showSlash = false;
      // Attachments ride with the line — this surface has no session to send
      // them to — and are part of the draft: a refusal keeps both.
      const attached: ComposerImage[] = images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }));
      const sendText = foldAttachments(text, textAttachments);
      if (onSend(sendText, undefined, attached.length ? attached : undefined) !== false) { inputText = ''; images = []; textAttachments = []; pasteSessionId = null; }
      inputEl?.focus();
      return;
    }

    // A turn is running: the line goes into it on this keypress, taking its
    // attachments with it exactly as an idle send does — one fold rule
    // (foldAttachments), not two. What still can't go in — a slash command, a
    // mount with no `onInterject` — says why instead of doing nothing (interjectHold.ts).
    if (inFlight) {
      const hold = interjectHold(text.startsWith('/'), !!onInterject, images.length > 0 || textAttachments.length > 0);
      if (hold) { heldForIdle = hold.held; heldReason = hold.reason; return; }
      const attached: ComposerImage[] = images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }));
      onInterject!(foldAttachments(text, textAttachments), attached.length ? attached : undefined);
      inputText = ''; images = []; textAttachments = []; pasteSessionId = null;
      inputEl?.focus();
      return;
    }

    const attachedImages = [...images];
    const attachedText = [...textAttachments];
    showSlash = false;
    inputText = '';
    images = [];
    textAttachments = [];
    inputEl?.focus();

    // Where this message goes — slashAnywhere.ts owns the rule (leading slash
    // forwards anything; a token named mid-body must be registered). Still
    // first-command-only: a second `/word` stays literal in the args.
    const route = slashDispatch(text, (name) =>
      slashCommands.some((c) => c.name.slice(1).toLowerCase() === name));
    if (route.kind === 'send') { onSend(route.args, route.command); return; }
    if (route.kind === 'host') {
      vscode.postMessage({ type: 'slashCommand', command: route.command, args: route.args, sessionId }); // t-xsufto: runs in THIS chat, not the host's selected one
      return;
    }

    // Route by `pasteSessionId` so a tab switch between paste and send still
    // lands the image in the originating session; falls back to the live
    // `sessionId` prop when no paste lock exists.
    if (attachedImages.length > 0) {
      const targetSessionId = pasteSessionId ?? sessionId ?? null;
      pasteSessionId = null;
      vscode.postMessage({
        type: 'sendWithImages',
        text: foldAttachments(text, attachedText),
        sessionId: targetSessionId,
        images: attachedImages.map(img => ({ dataUrl: img.dataUrl, name: img.name })),
      });
      return;
    }

    onSend(foldAttachments(text, attachedText));
  }

  function toggleSlashPalette() {
    if (showSlash) { showSlash = false; return; }
    slashFilter = inputText.startsWith('/') ? inputText.slice(1) : '';
    selectedIdx = 0;
    showSlash = true;
    inputEl?.focus();
  }
</script>

<div
  class="input-area"
  class:dropping
  use:spotlight
  ondragenter={() => drag.event('enter')}
  ondragleave={() => drag.event('leave')}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  role="presentation"
>
  <!-- The scroll anchor lives INSIDE the composer: `.input-area` sits below the
       transcript in normal flow, so anchoring it to the cell would have put it
       under the input row. Empty label = nothing unseen = no pill. -->
  <ScrollAnchorPill label={anchorLabel} onJump={() => onAnchorJump?.()} />
  <!-- One dropdown, two vocabularies: `/` commands and `@` people (never both). -->
  {#if showSlash}
    <SlashDropdown items={filteredCommands()} {selectedIdx} onPick={(i) => { const c = filteredCommands()[i]; if (c) selectCommand(c); }} onHover={(i) => (selectedIdx = i)} emptyText="No matching commands" />
  {:else if showMentions}
    <SlashDropdown items={mentionRows} selectedIdx={mentionIdx} onPick={selectMention} onHover={(i) => (mentionIdx = i)} emptyText="No matching participants" />
  {/if}

  <!-- Model connectivity strip (ModelWarning.svelte owns the copy). A bare
       composer has no engine session, so no provider to report on. -->
  {#if !bare}<ModelWarning online={modelOnline} reason={modelReason} {providerLabel} {providerIsLocal} />{/if}

  <!-- Monthly spend cap: amber warning from 80%, red block at 100% (cloud turns
       are refused host-side; +$5 raises the cap inline). Local models are free. -->
  {#if !bare && monthBudget && budgetPct >= 80}
    <div class="budget-banner" class:blocked={budgetPct >= 100} use:tip={'Monthly OpenRouter spend across all chats — set the cap in the OpenRouter settings.'}>
      <span class="budget-dot"></span>
      <span class="budget-text">
        {#if budgetPct >= 100}
          Monthly cap reached — {fmtUsd(monthSpend)} of {fmtUsd(monthBudget)}. Cloud turns are blocked (local models still work).
        {:else}
          Approaching monthly cap — {fmtUsd(monthSpend)} of {fmtUsd(monthBudget)} ({budgetPct}%).
        {/if}
      </span>
      {#if budgetPct >= 100}
        <button class="budget-raise" onclick={raiseBudget} use:tip={'Raise the monthly cap by $5'}>+$5</button>
      {/if}
    </div>
  {/if}

  <!-- Model bar: per-chat picker plus the context gauge once a model is
       loaded; absent on a bare composer. The gauge/turn gate is not
       `modelOnline && modelName` alone, since an unanswered liveness probe can
       blank a reading the chat already earned — real tokens or turns are their
       own proof the chat is working. The offline banner above still fires on
       the liveness verdict alone. -->
  {#if !bare}
    <div class="model-bar">
      <ModelPicker {sessionId} {passthrough} fallbackName={modelName} online={modelOnline} />
      {#if (modelOnline && modelName) || contextUsed > 0 || turns > 0}
        <!-- files · turns · gauge as ONE right-hand group (CHANGES.md round 3,
             change 43): three numbers about one question — how full is this
             chat — so they read as one line with the picker alone on the left. -->
        <span class="ctx-meta">
        <ChangesPill {changes} />
        {#if changes && changes.fileCount > 0}<span class="ctx-sep">&middot;</span>{/if}
        <span class="ctx-turns">{turns} turn{turns !== 1 ? 's' : ''}</span>
        {#if contextUsed > 0}
          <!-- One clickable compact affordance whenever real tokens are in play. An
               unknown window keeps the honest "N used" face rather than a fake %. -->
          <span class="ctx-sep">&middot;</span>
          <!-- Menu is a sibling of the gauge, not nested, so a click on it doesn't
               bubble through the gauge's onclick and fire an accidental compact. -->
          <!-- The card hangs off the wrap, not the gauge, so moving onto it does not
               count as leaving the gauge. -->
          <span
            class="ctx-gauge-wrap"
            bind:this={ctxWrapEl}
            onmouseenter={() => (ctxCardOpen = true)}
            onmouseleave={() => (ctxCardOpen = false)}
            onfocusin={() => (ctxCardOpen = true)}
            onfocusout={() => (ctxCardOpen = false)}
            role="presentation"
          >
            <!-- Passthrough: the reading stays but every compaction affordance goes — the CLI
                 compacts on its own schedule and takes no /compact from us. -->
            <span
              class="ctx-gauge fuse-button"
              class:ctx-gauge-btn={!passthrough}
              class:ctx-unknown={!contextKnown}
              class:armed={fusePhase === 'armed'}
              role={passthrough ? undefined : 'button'}
              tabindex={passthrough ? undefined : 0}
              aria-label={fusePhase === 'armed' ? 'Compacting — click to cancel' : composition ? `${fmtK(usedOf(composition))} context (last step)${contextKnown ? ` of ${fmtK(gaugeTotal)} tokens (${contextPct}%)` : ''} — hover for the breakdown` : undefined}
              use:tip={{ anchor: 'composer', text: fusePhase === 'armed' ? 'Compacting — click to cancel' : composition ? '' : passthrough
                ? `${fmtK(contextUsed)}${contextKnown ? ` context (last step) of ${fmtK(gaugeTotal)} tokens (${contextPct}%)` : ' context (last step)'} — Claude Code manages its own compaction`
                : contextKnown
                ? `${fmtK(contextUsed)} context (last step) of ${fmtK(gaugeTotal)} tokens (${contextPct}%) of this chat's ${windowSourceLabel} — a last step, not a total for the chat; click to compact (summarise older turns to free space); right-click to set a custom auto-compact threshold${compactionThresholdValue ? ` (currently ${compactionThresholdValue})` : ''}`
                : `${fmtK(contextUsed)} context (last step) — context window unknown (no loaded-window report from the model server), so no %. Click to compact (summarise older turns to free space); right-click to set a custom auto-compact threshold.` }}
              onclick={(e) => { if (passthrough) return; e.stopPropagation(); onGaugeClick(); }}
              onkeydown={(e) => { if (passthrough) return; if (e.key === 'Enter' || e.key === ' ' || (e.key === 'Escape' && fusePhase === 'armed')) { e.preventDefault(); e.stopPropagation(); onGaugeClick(); } }}
              oncontextmenu={passthrough ? undefined : openCompactionMenu}
            >
              {#if fusePhase === 'armed'}
                <!-- t-okz748 — visual only; onGaugeClick's setTimeout fires compaction. -->
                <FuseOverlay fuseMs={FUSE_MS} />
              {:else if contextKnown}
                <svg class="gauge-svg" viewBox="0 0 36 36" width="15" height="15" aria-hidden="true">
                  <circle class="gauge-track" cx="18" cy="18" r="15.5" pathLength="100" />
                  <circle
                    class="gauge-arc"
                    cx="18" cy="18" r="15.5" pathLength="100"
                    style="stroke: {contextColor}; stroke-dasharray: {Math.min(contextPct, 100)} 100;"
                    transform="rotate(-90 18 18)"
                  />
                </svg>
                <!-- The digits ROLL on a change (CHANGES.md round 2, change 27).
                     The ring, the colour and the fuse are untouched. -->
                <span class="ctx-pct" style="color: {contextColor}"><GaugeCounter value={contextPct} />%</span>
              {:else}
                <span>{fmtK(contextUsed)} used &#9888;</span>
              {/if}
              {#if compactionPending}
                <span class="ctx-pending" use:tip={'Compaction done — the context drop applies on your next message'}>&#8595;</span>
              {/if}
            </span>
            <!-- Only while the card is up: a pin for a card nobody opened is furniture. -->
            {#if composition && (ctxCardOpen || ctxPinned)}
              <CtxPinButton pinned={ctxPinned} onToggle={() => (ctxPinned = !ctxPinned)} />
            {/if}
            <CompactionThresholdMenu
              open={compactionMenuOpen && !passthrough}
              current={compactionThresholdValue}
              onSelect={selectCompactionThreshold}
              onClose={() => (compactionMenuOpen = false)}
            />
          </span>
        {:else if contextWindow > 0}
          <span class="ctx-sep">&middot;</span>
          <span class="ctx-window">{fmtK(contextWindow)} ctx</span>
        {/if}
        <!-- Money, or nothing on a plan — SpendBadge.svelte owns that decision
             and the reason for it. The plan's headroom is beside the model
             name, in the picker's usage slot. -->
        <SpendBadge {totalCost} {subagentCost} subscription={ccMeter.subscription} providerId={currentProviderId} {authKind} />
        {#if effortActive}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-think">{effortLabel.toUpperCase()}</span>
        {/if}
        {#if permissionMode !== 'default' && permissionMode !== 'build'}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-{permissionMode}">{permissionMode.toUpperCase()}</span>
        {/if}
        <!-- This chat's own Actions mode only, never `approveButton.active`
             which also lights for the Browser row's global setting. -->
        {#if approveButton.actionsActive}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-{approveMode}">{approveMode === 'auto' ? 'AUTO' : approveMode === 'acceptEdits' ? 'EDITS' : 'BYPASS'}</span>
        {/if}
        </span>
      {/if}
    </div>
  {/if}

  <!-- The breakdown card hangs off THE COMPOSER, not off the 20px gauge
       (CHANGES.md round 3, change 55): centred on the gauge it shared an edge
       with nothing and read as a box floating over the pane. A child of
       `.input-area` is what lets its right edge land on the composer's own
       gutter — the grid every row here lines up to. -->
  {#if composition && (ctxCardOpen || ctxPinned)}
    <span class="ctx-card-pop" class:pinned={ctxPinned} bind:this={ctxPopEl}>
      <ContextBreakdownCard {composition} contextWindow={gaugeTotal} {trend} />
    </span>
  {/if}

  <!-- Where a dragged file lands (CHANGES.md round 2, change 28). -->
  {#if dropping}<div class="drop-hint" aria-hidden="true"><span>Drop to attach</span></div>{/if}

  {#if imagesOn && images.length > 0}<ImageStrip {images} onRemove={removeImage} onOpen={onImageClick} />{/if}
  <!-- Text-file drop chips — NOT gated on `imagesOn`. These never touch the
       host's image route, so a bare composer with no `allowImages` still
       takes them. -->
  {#if textAttachments.length > 0}<TextAttachmentStrip attachments={textAttachments} onRemove={removeTextAttachment} />{/if}

  <!-- A line typed during the turn, on its way INTO it: the composer is already
       clear, so this is what stands in for it until the host answers. -->
  {#if !bare || heldReason}<InterjectingChip {interjecting} reason={heldReason} />{/if}

  <!-- Input + send/cancel. The utility row rides inside the textarea's own
       column so the focus eye ends at the textarea's right edge instead of
       hanging above Send. -->
  <div class="input-row">
    <div class="input-col">
      <!-- Where this chat runs and what it can do, on ONE row (CHANGES.md
           round 3, change 44): the repo and branch pills came down off their
           own row above the composer to join the scales and the eye.
           `secondOpinionFor` is the composer's whole share of the
           second-opinion feature: a bare composer has no engine session, so it
           draws no scales and no pills. -->
      <ComposerUtilityRow sessionId={bare ? null : sessionId} {focused} {onToggleFocus}
        secondOpinionFor={bare || passthrough ? null : sessionId} busy={inFlight} />
      <textarea bind:this={inputEl} data-session-id={sessionId ?? ''} bind:value={inputText} oninput={handleInput} onkeydown={handleKeydown} onpaste={imagesOn ? handlePaste : undefined} rows="2" disabled={disabled || noConn} placeholder={placeholder || (inFlight ? 'Type to interrupt — Enter sends it into the running turn…' : 'Type a message or / for commands...')} class="input"></textarea>
    </div>
    <!-- ONE control (CHANGES.md round 2, change 25): the arrow morphs to a
         stop square while a turn runs, and stopping is a 600ms HOLD so a
         stray click cannot kill the turn. No Cancel button at rest. -->
    <div class="btn-col">
      <!-- t-ru13hb item 1: while a turn runs the button beside this one is
           Stop, and its click is deliberately dead (holdToStop.ts) — so a
           mouse-only user had no way to interject at all. It calls `doSend`,
           the very function Enter calls, so there is one send path. -->
      {#if !bare && inFlight && inputText.trim()}
        <InterjectSendButton onSend={doSend} disabled={disabled || noConn} />
      {/if}
      <SendStopButton busy={!bare && inFlight} disabled={disabled || noConn}
        refusal={noConn ? NO_CONNECTIONS_TEXT : ''}
        onSend={doSend} onStop={onCancel}
        onTooShort={() => (heldReason = 'Hold the stop button to end the turn')} />
    </div>
  </div>

  <!-- `/`, the effort ladder, Plan, Access, Vision — and Export at the far
       end. The row's own rhythm and every popover live in the leaf. -->
  <ComposerModeRow
    {showSlash} onToggleSlash={toggleSlashPalette} {bare} {passthrough}
    {effortOptions} {effortCurrent} {effortActive}
    onSelectEffort={(v) => { effortCurrent = v; vscode.postMessage({ type: 'setEffort', effort: v, sessionId }); }}
    {permissionMode} onSelectMode={selectMode}
    {approveButton} {approveRows} onOpenApprove={() => vscode.postMessage({ type: 'requestBrowserAutoApprove' })}
    {isVlm} {visionState} {visionProfile} {visionAgents} {sessionId} onSelectVision={setVision}
    {onExport} {canExport} />
</div>

<style>
  /* THE COMPOSER IS A CARD (CHANGES.md change 5), not a wall-to-wall strip:
     inset from the pane, rounded, with its own border and lift.
     `isolation: isolate` gives the glow layers below their own stacking
     context — and that is exactly why `z-index` is here too. The transcript
     cards above carry the spotlight's own layer, and without a z-index ABOVE
     them an open model picker was painted over and its rows went unclickable
     (trap 2 in the porting index, measured in the mock).
     `overflow: visible` keeps the scroll-anchor pill, which hangs off the top
     edge, from being clipped. */
  .input-area {
    position: relative;
    isolation: isolate;
    z-index: 3;
    overflow: visible;
    flex-shrink: 0;
    /* ONE inset for every row in here — the model bar, the input row, the mode
       row and anything anchored to the composer's edge (the breakdown card).
       Named so a card can line up with the grid instead of guessing at it. */
    --composer-gutter: 12px;
    margin: 0 10px 10px;
    border: 1px solid var(--og-border);
    border-radius: 12px;
    background: var(--og-pane-header);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  /* The pointer-driven border glow: a ring painted on a pseudo-element and
     masked to the 1px border band, so it lights the EDGE rather than washing
     the whole composer. --sp-x/--sp-y come from `use:spotlight`, the same
     action the transcript cards use, so there is one pointer behaviour here. */
  .input-area::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    padding: 1px;
    pointer-events: none;
    opacity: var(--sp-on, 0);
    transition: opacity 200ms ease;
    background: radial-gradient(
      180px circle at var(--sp-x, 50%) var(--sp-y, 50%),
      var(--og-chat),
      transparent 70%
    );
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
  }
  @media (prefers-reduced-motion: reduce) {
    .input-area, .input-area::before { transition: none; }
  }

  /* The connectivity strip's own rules moved to ModelWarning.svelte with its
     markup — Svelte scopes styles per component. */

  /* Monthly spend-cap banner — amber approaching, red at the cap. */
  .budget-banner { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: rgba(251, 191, 36, 0.14); border-bottom: 1px solid var(--og-border); }
  .budget-banner.blocked { background: rgba(248, 113, 113, 0.16); }
  .budget-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--og-warning); box-shadow: 0 0 6px var(--og-warning); flex-shrink: 0; }
  .budget-banner.blocked .budget-dot { background: var(--og-error); box-shadow: 0 0 6px var(--og-error); }
  .budget-text { font-size: 10px; color: var(--og-text-secondary); flex: 1; line-height: 1.35; }
  .budget-raise { font-size: 10px; font-weight: 600; padding: 2px 8px; border: 1px solid var(--og-border); border-radius: 4px; background: var(--og-btn-bg); color: var(--og-text-secondary); cursor: pointer; font-family: inherit; flex-shrink: 0; }
  .budget-raise:hover { border-color: var(--og-error); color: var(--og-text); }

  /* --- Model bar (above input) --- */
  .model-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px var(--composer-gutter);
    border-bottom: 1px solid var(--og-border);
  }

  /* files · turns · gauge, one group at the bar's right end. The `auto` is
     HERE and nowhere else: on .ctx-turns (where it used to be) it would push
     the gauge away from its own neighbours inside the group. */
  .ctx-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .ctx-turns {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
  }

  .ctx-sep {
    font-size: 10px;
    color: var(--og-text-muted);
  }

  .ctx-pct {
    font-size: 10px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace);
  }

  /* Pending-reduction cue: shows from when /compact finishes until the next
     real turn applies the (lazy) context drop. A gently dropping arrow so the
     hold reads as "done, queued", not "nothing happened". */
  .ctx-pending {
    font-size: 10px;
    font-weight: 700;
    color: var(--og-crane);
    cursor: help;
    animation: ctx-pending-pulse 1.1s ease-in-out infinite;
  }
  @keyframes ctx-pending-pulse {
    0%, 100% { opacity: 0.45; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(1px); }
  }

  .ctx-window {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
  }
  .ctx-unknown {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-warning);
    cursor: help;
  }

  .mode-badge {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.5px;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .mode-badge.mode-think { background: rgba(168, 130, 255, 0.2); color: var(--og-accent); }
  .mode-badge.mode-plan { background: rgba(138, 180, 255, 0.2); color: var(--og-chat); }
  /* Deep plan wears the brand gold the mode control uses for it. Without a rule of
     its own the DEEP-PLAN badge fell through to the bare .mode-badge base and read
     as an unstyled label, which is how a mode goes unnoticed. */
  .mode-badge.mode-deep-plan { background: rgba(217, 177, 90, 0.2); color: var(--og-accent-2); }
  .mode-badge.mode-auto { background: rgba(74, 222, 128, 0.2); color: var(--og-success); }
  .mode-badge.mode-bypass { background: rgba(248, 113, 113, 0.2); color: var(--og-error); }

  /* The attached-image strip's own rules moved to ImageStrip.svelte with its
     markup — Svelte scopes styles per component. */

  /* The interim chip's own rules live in InterjectingChip.svelte with its
     markup — Svelte scopes styles per component. */

  /* --- Input row --- */
  .input-row { display: flex; gap: 8px; padding: 6px var(--composer-gutter); align-items: flex-end; }
  /* The TEXTAREA'S COLUMN. The utility row is a child of it, so it spans the
     box's width exactly: the eye stops at the textarea's right edge instead of
     sitting over Send, and the row hugs the box. 2px, not more — the whole
     complaint was the band of empty space (0.4.61 UAT). `min-width: 0` because
     a flex item's default `min-width: auto` would let the textarea refuse to
     shrink below its intrinsic width in a narrow grid cell. */
  .input-col { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  /* `width` rather than `flex: 1`: the flex axis in this column is VERTICAL, so
     growing along it is not what this box wants. */
  /* max-height is no longer a fixed 120px: resizeComposer() computes the real
     10-line cap off the measured line-height and sets it via style.height, so
     a CSS max here would fight the JS clamp rather than back it up.
     resize: none — a manual drag handle would fight the auto-grow too. */
  .input { width: 100%; min-height: 24px; padding: 6px 8px; font-family: inherit; font-size: 12px; color: var(--og-text); background: var(--og-input-bg); border: 1px solid var(--og-input-border); border-radius: 4px; resize: none; outline: none; }
  .input:focus { border-color: var(--og-chat); }
  .input::placeholder { color: var(--og-text-muted); }
  .input:disabled { opacity: 0.5; }

  /* One control now (SendStopButton.svelte), so this is a slot rather than a
     column — it keeps the name because `.input-row` aligns to its bottom. */
  .btn-col { display: flex; align-items: flex-end; gap: 5px; flex-shrink: 0; }



  /* Export is an action on the chat, not a mode: the gap separates it, not a
     different shape. */







  /* Per-chat context gauge — circular fill in the model bar (per session).
     .ctx-gauge-wrap anchors CompactionThresholdMenu's absolute popover. */
  /* Above the gauge: the composer sits at the foot of the pane, so a card
     below it would be cut off by the window edge. */
  /* Hung off the COMPOSER: right edge on the composer's own gutter line and
     width capped to its inner measure, so the card shares an edge with the
     rows above it instead of floating over the pane (change 55). Above,
     because the composer sits at the foot of the pane. */
  .ctx-card-pop {
    position: absolute;
    bottom: calc(100% + 8px);
    right: var(--composer-gutter);
    max-width: calc(100% - 2 * var(--composer-gutter));
    z-index: 40;
    pointer-events: none;
  }
  /* Pinned: the card is a surface to read from, so it takes the pointer. It does
     NOT move — same anchor, same measure, whichever way it was opened. */
  .ctx-card-pop.pinned { pointer-events: auto; }
  .ctx-gauge-wrap { position: relative; display: inline-flex; }
  .ctx-gauge { display: inline-flex; align-items: center; gap: 3px; }
  .ctx-gauge-btn { cursor: pointer; border-radius: 3px; padding: 0 2px; }
  .ctx-gauge-btn:hover { background: var(--og-btn-hover, rgba(255,255,255,0.08)); }
  .ctx-gauge-btn:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  /* t-okz748 — armed: tints the pill amber; FuseOverlay.svelte owns the bar. */
  .ctx-gauge.armed {
    position: relative;
    color: var(--og-warning, #f5a524);
    background: color-mix(in srgb, var(--og-warning, #f5a524) 12%, transparent);
  }
  .gauge-svg { display: block; }
  .gauge-track { fill: none; stroke: var(--og-border); stroke-width: 4; }
  .gauge-arc {
    fill: none;
    stroke-width: 4;
    stroke-linecap: round;
    transition: stroke-dasharray 0.3s ease, stroke 0.3s ease;
  }


  /* --- Drop target: where a dragged file lands (change 28) ---------------
     A real element, not a pseudo: `::before` is already the pointer glow and
     `::after` is free but would have to carry both the frame and the label. */
  .drop-hint {
    position: absolute;
    inset: 5px;
    z-index: 6;
    display: grid;
    place-items: center;
    border: 1.5px dashed var(--og-chat);
    border-radius: 9px;
    background: color-mix(in srgb, var(--og-chat) 8%, transparent);
    pointer-events: none;
  }
  .drop-hint span {
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--og-surface);
    color: var(--og-chat);
    font-size: 11px;
    font-weight: 600;
  }
  .input-area.dropping { border-color: var(--og-chat); }

  /* The dropdown's own rules moved to SlashDropdown.svelte with its markup. */
</style>
