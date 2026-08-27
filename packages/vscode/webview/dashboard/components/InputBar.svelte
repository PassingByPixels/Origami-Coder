<script lang="ts">
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { type SlashCommand, buildSlashCommand, DEFAULT_COMMANDS, SHELL_COMMANDS } from '../lib/slashCommands';
  import ModeControl from './ModeControl.svelte';
  import { isPlanningMode } from './modeControl';
  import { onMount } from 'svelte';
  import ImageStrip from './ImageStrip.svelte';
  import InterjectingChip from './InterjectingChip.svelte';
  import ModelPicker from './ModelPicker.svelte';

  import SlashDropdown from './SlashDropdown.svelte';
  import CompactionThresholdMenu from './CompactionThresholdMenu.svelte';
  import ApprovePopover from './ApprovePopover.svelte';
  import { approveButtonState } from './approveButtonState';
  import VisionProfileMenu from './VisionProfileMenu.svelte';
  import type { VisionState } from './visionPinState';
  import { readComposerImage } from './composerImages';
  import { bannerState, probingText } from './modelBanner';
  import { applyMention, filterMentions, mentionQuery, type MentionCandidate } from '../../chat/collabMentions';

  interface Props {
    inFlight: boolean;
    agentName: string;
    modelName: string;
    modelOnline?: boolean;
    modelReason?: string;
    /** Whether the loaded model is vision-capable (LM Studio type:vlm, or a
     *  configured `modalities.input` carrying "image"), read live from the
     *  connection. It is the webview's copy of the field the engine gates on,
     *  and it lights the Vision button as NATIVE. */
    isVlm?: boolean;
    /** Auto-vs-pinned vision for this chat's model; passed straight through to the Vision control. */
    visionState?: VisionState;
    /** THIS chat's provider display name + whether it's the loopback LM Studio —
     *  the offline banner names the right server ("start LM Studio" vs "check
     *  the Spark"). Defaults keep older hosts on the legacy LM Studio wording. */
    providerLabel?: string;
    providerIsLocal?: boolean;
    /**
     * S7 V1 (bright-muffin) — id of the chat tab the InputBar is
     * attached to. Captured at paste time so images route back to
     * that session even if the user switches tabs before sending.
     */
    sessionId?: string | null;
    /** An attached thumbnail was clicked — the parent opens it enlarged. Passed
     *  STRAIGHT THROUGH to the strip; this component owns which images exist,
     *  never how one is displayed. Absent on any mount with no lightbox above
     *  it, which is why the strip's own prop is optional too. */
    onImageClick?: (src: string, alt: string) => void;
    /** Gauge click — the parent shows a branded confirm before compacting. */
    onCompact?: () => void;
    /** Returning `false` means the parent REFUSED the line, and is the only
     *  case the draft is kept (see `passthroughSlash`) — the draft being the
     *  text AND its attachments, kept or cleared together. `images` is slot
     *  THREE because slot two is the chat's own mode (`/loop`, `/compose`). */
    onSend: (text: string, mode?: string, images?: ComposerImage[]) => boolean | void;
    onCancel: () => void;
    /** Export this conversation as markdown. Provided per-cell by ChatPane so
     *  the action is available in the solo editor-tab view too (the tab-strip
     *  export button only exists in the multi-chat grid). */
    onExport?: () => void;
    canExport?: boolean;
    /** One or more lines are with the host for delivery INTO the running turn,
     *  and the engine has not acknowledged them yet. The parent owns the flag
     *  because it owns the lines (interjectSplit.ts). */
    interjecting?: boolean;
    /** Deliver a line typed DURING a turn into that turn, now. Its absence is
     *  what makes a mount refuse to send mid-turn at all: the draft is kept
     *  rather than handed to nobody. */
    onInterject?: (text: string) => void;
    // --- The collab surface. Every prop below defaults to the chat behaviour,
    // so a mount that omits them is bit-identical to the chat composer. ---
    /** A FIXED command list instead of the engine's `availableCommands`: a
     *  collab has no engine session of its own, so the chat's vocabulary would
     *  either do nothing or act on some unrelated chat. */
    commands?: SlashCommand[];
    /** Hand the raw trimmed line to `onSend` — no slash interception, no image
     *  branch. The parent owns the parse, and says so by returning `false`. */
    passthroughSlash?: boolean;
    /** A read-only surface (an archived collab): the box and Send are dead. */
    disabled?: boolean;
    placeholder?: string;
    /** Strip the composer to the textarea, Send, `/` and Export. Everything
     *  hidden — model bar, banners, images, queue, Cancel — is about an engine
     *  session, which a collab composer does not have. */
    bare?: boolean;
    /** Flock M4: the ACTIVE collab roster, which gates the `@` picker. ABSENT
     *  (every chat mount) means `@` is an ordinary character, as it was. */
    participants?: MentionCandidate[];
    /** Let a BARE composer attach images too. The chat posts `sendWithImages`
     *  to the host; a passthrough surface has no session for that, so its
     *  attachments go to the parent on `onSend`. Default false = chat as-is. */
    allowImages?: boolean;
  }

  interface ImageAttachment { id: number; name: string; dataUrl: string; }
  /** What LEAVES this component — no local id, which is the strip's bookkeeping. */
  interface ComposerImage { dataUrl: string; name: string; }

  let { inFlight, agentName, modelName, modelOnline = false, modelReason = '', isVlm = false, visionState = 'auto-off', providerLabel = '', providerIsLocal = true, sessionId = null, onImageClick, onCompact, onSend, onCancel, onExport, canExport = false, interjecting = false, onInterject, commands, passthroughSlash = false, disabled = false, placeholder = '', bare = false, participants, allowImages = false }: Props = $props();
  /** ONE gate for the strip, the paste handler and the drop handler, so the
   *  three cannot end up answering differently. */
  const imagesOn = $derived(!bare || allowImages);
  let inputText = $state('');
  let inputEl: HTMLTextAreaElement | undefined = $state();
  let showSlash = $state(false);
  let slashFilter = $state('');
  let selectedIdx = $state(0);
  // The `@` picker — its OWN flag and cursor, never the slash palette's.
  let showMentions = $state(false);
  let mentionFilter = $state('');
  let mentionIdx = $state(0);
  let images: ImageAttachment[] = $state([]);
  let nextImageId = 0;
  // S7 V1 — locked at the moment of the first paste. Subsequent
  // session switches don't move this; the bound send routes back to
  // the original session. Reset when images are cleared (after send
  // or last attachment removed) so the next paste captures fresh.
  let pasteSessionId: string | null = $state(null);
  // Reasoning effort — the model's REAL variants (from the engine's `effort`
  // configOption), not hardcoded think/quick (which the engine rejected with
  // "effort not found: think"). Empty ⇒ the model has no variants ⇒ hide the button.
  let effortOptions = $state<Array<{ value: string; name: string }>>([]);
  let effortCurrent = $state('');
  let effortOpen = $state(false);
  let permissionMode = $state('default');
  // THREE modes now, scoped to THIS chat panel (a per-session choice, not a
  // global setting): 'build' (and the initial 'default') is the baseline,
  // 'plan' is the read-only planning agent, 'deep-plan' researches and delivers
  // a plan folder. What the control shows lives in modeControl.ts; what the
  // rest of this file needs is the one predicate below — both planning modes
  // are read-only for the project, so both gate the approve rail.
  let isPlanning = $derived(isPlanningMode(permissionMode));
  // Scoped auto-approve preset for THIS chat, independent of the plan/build agent:
  // 'default' = ask on every tool as normal; 'auto' = auto-approve file edits;
  // 'bypass' = auto-approve everything (yolo). Rides each message via the engine's
  // per-session permission config; resets to 'default' on reload (fail-closed).
  let approveMode = $state('default');
  // t-kgsupy round 4 — ONE trigger, ONE popover: round 3 shipped this Actions
  // preset and the Browser control below as TWO separate buttons/popovers;
  // this flag now gates both rows at once. Each row still drives its OWN
  // setting through its OWN message (setApproveMode vs setBrowserAutoApprove)
  // exactly as it did as two buttons — only the open/closed state merged.
  let approveOpen = $state(false);
  // t-kgsupy round 3 — VS Code's OWN global chat-tool auto-approve
  // (chat.tools.global.autoApprove), NOT scoped to this chat: every open
  // composer converges on the same value, read LIVE from the host rather than
  // carried as per-session state. 'ask' is the safe default shown before the
  // first requestBrowserAutoApprove reply lands.
  let browserApproveMode = $state('ask');
  // What the merged button says/wears — a pure function of both settings,
  // extracted to approveButtonState.ts (InputBar was over its cap). Shows
  // the RISKIER of the two, per round 4's own wording for the requirement.
  let approveButton = $derived(approveButtonState(approveMode, browserApproveMode));
  const ACTIONS_ROW_OPTIONS = [
    { value: 'default', name: 'Ask' },
    { value: 'auto', name: 'Auto' },
    { value: 'bypass', name: 'Bypass' },
  ];
  const BROWSER_ROW_OPTIONS = [
    { value: 'ask', name: 'Ask' },
    { value: 'bypass', name: 'Bypass' },
  ];
  // The popover's two rows. Actions is disabled in plan mode (read-only has
  // nothing to auto-approve) — the ROW's notches, not the trigger button,
  // because Browser is not a per-session permission and must stay reachable
  // even while Actions cannot be touched.
  let approveRows = $derived([
    {
      key: 'actions', title: 'Actions:',
      mode: approveMode, options: ACTIONS_ROW_OPTIONS, disabled: isPlanning,
      onSelect: selectActionsMode,
    },
    {
      key: 'browser', title: 'Browser:',
      mode: browserApproveMode, options: BROWSER_ROW_OPTIONS, disabled: false,
      onSelect: selectBrowserMode,
    },
  ]);
  // t-kgtr6c — the per-chat VISION PROFILE. '' is OFF and is the default: the
  // route costs a tool schema and a prompt block on every image turn, so it is
  // opted into per chat, never inherited. Written through the engine's session
  // config option (`visionProfile`), the same authoritative path the approve
  // preset above takes, so a reload starts from the row rather than from here.
  let visionProfile = $state('');
  let visionOpen = $state(false);
  /** Profile slugs offered in the menu, from the host's def listing. Empty is a
   *  real state with its own copy — "none configured" is a different problem
   *  from "none chosen", and one sends you to the Agents board. */
  let visionAgents = $state<string[]>([]);
  function setVision(slug: string) {
    visionProfile = slug; // optimistic; visionUpdate confirms
    visionOpen = false;
    vscode.postMessage({ type: 'setVisionProfile', profile: slug, sessionId });
  }
  let effortLabel = $derived(effortOptions.find(o => o.value === effortCurrent)?.name ?? 'Effort');
  // "Active" = a non-baseline effort is selected (baseline = the first variant).
  let effortActive = $derived(effortOptions.length > 1 && !!effortCurrent && effortCurrent !== effortOptions[0].value);

  // Context tracking — real token counts from the engine's `usageUpdate` frames,
  // with the host's `contextUpdate` turn count + probed window as the fallback
  // (the only source before the first frame of the first turn lands).
  let contextWindow = $state(0);
  let turns = $state(0);
  let contextUsed = $state(0);
  let contextTotal = $state(0);
  // Throughput of the most recent COMPLETED turn: this turn's real output tokens
  // over its wall-clock, computed at the source (acpClient, from the prompt-
  // response usage) and pushed via `turnStats`. Honest, no char-count guessing.
  let lastTps = $state(0);
  // True from when a /compact finishes until the next real turn lands (whose
  // usage_update carries the reduced footprint). Drives a "pending" cue on the
  // gauge so the lazy reduction reads as done-and-queued, not "did nothing".
  let compactionPending = $state(false);
  // t-kgsdsw — right-click menu's picked auto-compaction trigger. RAW wire
  // value ('' = auto, 'NN%', or a token count); an OPTIMISTIC echo only — a
  // reopened chat does not read the persisted override back, though the
  // override itself still governs compaction (see acp/service.ts).
  let compactionThresholdValue = $state('');
  let compactionMenuOpen = $state(false);
  // This chat's cumulative cost in USD (from usage_update.cost.amount). 0 for
  // local/free models; real once an OpenRouter model has priced usage. It is
  // PARENT-ONLY and stays that way — the rollup is a separate number below, so
  // the badge can name both halves instead of showing one opaque total.
  let sessionCost = $state(0);
  // M4.4 — what the sub-agents this chat spawned have spent, off usage_update's
  // OPTIONAL additive `subagents` field. An engine that does not send it leaves
  // this at 0 and the badge is bit-identical to what it always was.
  //
  // NOT double-counted against a child's own composer: a mounted sub-agent
  // session draws its OWN InputBar with its OWN cost, and this parent draws the
  // rollup. Two surfaces, two questions ("what did this run cost me" vs "what
  // did that agent cost"), and summing them is the user's to do, not ours.
  let subagentCost = $state(0);
  let totalCost = $derived(sessionCost + subagentCost);
  // Monthly OpenRouter spend + cap (global, from spendUpdate / budgetUpdate) — the
  // warn-at-80% / block-at-100% banner. monthBudget null ⇒ no cap ⇒ no banner.
  let monthSpend = $state(0);
  let monthBudget = $state<number | null>(null);
  let budgetPct = $derived(monthBudget && monthBudget > 0 ? Math.round((monthSpend / monthBudget) * 100) : 0);
  function raiseBudget() {
    vscode.postMessage({ type: 'setBudget', monthly: (monthBudget ?? 0) + 5 });
  }

  // Listener lives in onMount with a cleanup so closed grid cells release
  // it (in grid layout EVERY session mounts its own InputBar). Session-
  // scoped events are filtered by sessionId — without it, all gauges in a
  // grid would converge on whichever session's contextUpdate arrived last
  // (cross-session bleed). A message with no sessionId is treated as a
  // broadcast and accepted.
  onMount(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      const forThisSession = msg.sessionId == null || msg.sessionId === sessionId;
      if (msg.type === 'contextUpdate' && forThisSession) {
        turns = msg.turns ?? turns;
        contextWindow = msg.contextWindow ?? contextWindow;
        if (typeof msg.contextUsed === 'number') contextUsed = msg.contextUsed;
        if (typeof msg.contextTotal === 'number') contextTotal = msg.contextTotal;
      }
      if (msg.type === 'turnStats' && forThisSession) {
        if (typeof msg.tokensPerSec === 'number') lastTps = msg.tokensPerSec;
      }
      if (msg.type === 'usageUpdate' && forThisSession) {
        // Engine's authoritative per-turn accounting for THIS chat's session.
        // The engine omits the frame when it can't resolve a context limit,
        // so contextTotal simply holds its last value.
        //
        // NOTHING here is gated on the turn ending — M4.4 throttles these to
        // roughly one every two seconds MID-TURN, so the gauge and the cost
        // both move while the agent works. That is deliberate: a cost that only
        // appears after a long turn tells you what you already spent.
        if (typeof msg.used === 'number') contextUsed = msg.used;
        if (typeof msg.size === 'number' && msg.size > 0) contextTotal = msg.size;
        if (msg.cost && typeof msg.cost.amount === 'number') sessionCost = msg.cost.amount;
        // Optional + additive. A frame that omits it HOLDS the last value (the
        // same rule contextTotal follows above) rather than snapping the total
        // back down — a rollup that flickered to zero between frames would read
        // as the sub-agents having refunded you.
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
        effortOptions = Array.isArray(msg.options) ? msg.options : [];
        effortCurrent = String(msg.current ?? '');
      }
      if (msg.type === 'reasoningUpdate' && forThisSession) {
        if (typeof msg.mode === 'string') effortCurrent = msg.mode;
      }
      if (msg.type === 'compactionThresholdUpdate' && forThisSession) {
        if (typeof msg.value === 'string') compactionThresholdValue = msg.value;
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
    // Seed the Browser Ask/Bypass control (t-kgsupy) — a bare composer has no
    // mode row to show it in.
    if (!bare) vscode.postMessage({ type: 'requestBrowserAutoApprove' });
    // The vision-profile ROSTER. Asked for here rather than only when the menu
    // opens, so the button can say which profile is armed the moment the
    // composer mounts — the same reason the model options are fetched up front.
    if (!bare) vscode.postMessage({ type: 'listCollabAgentDefs' });
    return () => window.removeEventListener('message', onMsg);
  });

  // Denominator: PREFER the actually-loaded context window from the model probe
  // (LM Studio's /api/v0 `loaded_context_length` — the real ceiling), and only
  // fall back to the engine's reported limit when there's no probe (e.g. cloud
  // models). The engine reports a model's *declared max* (e.g. 262k for qwen)
  // which overstates a locally-loaded window (e.g. 48k) — using it gave a false
  // low %. If neither is known we show NO percentage and flag it, rather than a
  // confident wrong number.
  let gaugeTotal = $derived(contextWindow > 0 ? contextWindow : (contextTotal > 0 ? contextTotal : 0));
  let contextKnown = $derived(gaugeTotal > 0);
  let contextPct = $derived(contextKnown ? Math.min(100, Math.round((contextUsed / gaugeTotal) * 100)) : 0);
  let contextColor = $derived(contextPct >= 80 ? 'var(--og-error)' : contextPct >= 60 ? 'var(--og-warning)' : 'var(--og-success)');
  // Tooltip HONESTY: `contextWindow > 0` means a live probe actually supplied
  // this number (LM Studio's loaded_context_length, a vLLM's max_model_len, or
  // now OpenRouter's own /models context_length — DashboardPanel.ts's
  // refreshModelInfoFor). `contextWindow` at 0 means gaugeTotal fell back to
  // contextTotal, which for a cloud model is the build-frozen models.dev
  // snapshot baked into the engine — a real number, but not what is "loaded".
  // Saying "loaded" for a catalog max nobody probed is the dishonesty this
  // branch exists to remove; the click-to-compact affordance is identical
  // either way, only the wording of what the % is OF changes.
  let windowSourceLabel = $derived(contextWindow > 0 ? "loaded context window" : "context window (catalog max)");

  function fmtK(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
    return String(n);
  }

  // Compact USD — sub-dollar costs need more precision than cents.
  function fmtUsd(n: number): string {
    return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  }

  const vscode = getVsCodeApi();

  // Dynamic command list — populated from ACP AvailableCommandsUpdate. Falls
  // back to DEFAULT_COMMANDS (the shared baseline + the shell's own, both in
  // ../lib/slashCommands) until the harness sends the real list.
  let engineCommands: SlashCommand[] = $state(DEFAULT_COMMANDS);
  // A given `commands` list is authoritative and never merged with the engine's:
  // the engine's vocabulary belongs to a session this surface may not have.
  let slashCommands: SlashCommand[] = $derived(commands ?? engineCommands);

  // Available commands listener is merged into the main message handler above.
  let filteredCommands = $derived(() => {
    if (!slashFilter) return slashCommands;
    const q = slashFilter.toLowerCase();
    return slashCommands.filter(c => c.name.includes(q) || c.description.toLowerCase().includes(q));
  });

  // The picker's rows, in the SAME shape the `/` palette draws.
  let mentionHits = $derived(filterMentions(participants ?? [], mentionFilter));
  let mentionRows = $derived(mentionHits.map((p) => ({ name: `@${p.slug}`, description: p.name, category: 'agent' })));

  function handleInput() {
    showSlash = inputText.startsWith('/');
    if (showSlash) { slashFilter = inputText.slice(1); selectedIdx = 0; }
    // Never both at once: a `/` line is a command, and no roster means no picker.
    const q = showSlash || !participants?.length ? null : mentionQuery(inputText, inputEl?.selectionStart ?? inputText.length);
    showMentions = q !== null;
    if (q) { mentionFilter = q.query; mentionIdx = 0; }
  }

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
    if (cmd.name === '/reasoning') { cycleEffort(); inputText = ''; showSlash = false; inputEl?.focus(); return; }
    if (cmd.name === '/plan') { selectMode(permissionMode === 'plan' ? 'build' : 'plan'); inputText = ''; showSlash = false; inputEl?.focus(); return; }
    inputText = cmd.name + ' '; showSlash = false; inputEl?.focus();
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
    // Per-panel mode switch: move THIS session onto the named agent.
    // Authoritative ACP write via setMode (setConfigOption 'mode'); the
    // modeUpdate echo confirms, and the host snaps the button back if the
    // engine refuses. Optimistic so the control responds instantly.
    permissionMode = modeId;
    vscode.postMessage({ type: 'setMode', modeId, sessionId });
    // Entering a planning agent, drop any auto-approve preset: a session
    // 'bypass' ruleset would otherwise override the agent's edit-deny and break
    // the guarantee the mode is for. Auto-approve is meaningless when nothing
    // outside the plan can be edited.
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

  // t-kgsupy round 4 — the ONE trigger opens the ONE popover with both rows.
  // "read it live" (t-kgsupy round 3) still applies on open, because the
  // Browser row's setting can change OUTSIDE Origami (Settings UI, another
  // window) while the popover was closed — the Actions row has no such path
  // (it lives only in this session), so only Browser needs the re-request.
  function toggleApprovePopover() {
    approveOpen = !approveOpen;
    if (approveOpen) vscode.postMessage({ type: 'requestBrowserAutoApprove' });
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

  /** Browser row: VS Code's OWN global chat-tool auto-approve — never gated
   *  on plan mode, this is not a per-session permission. */
  function selectBrowserMode(value: string) {
    browserApproveMode = value; // optimistic; browserAutoApproveUpdate confirms (and corrects on a failed write)
    vscode.postMessage({ type: 'setBrowserAutoApprove', value: value === 'bypass' });
  }

  /** Validate, read, optionally resize, and attach a single image file. The
   *  rules and the refusal wording live in composerImages.ts; what stays here
   *  is what only the composer knows — where an accepted image is kept, and
   *  where a refusal is shown. */
  async function attachImageFile(file: File) {
    const taken = await readComposerImage(file);
    if (!taken.ok) {
      vscode.postMessage({ type: 'imageError', message: taken.error });
      return;
    }
    // S7 V1 — capture sessionId on the FIRST attachment so a tab
    // switch between paste and send doesn't move the destination.
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

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer?.files;
    if (!f) return;
    for (let i = 0; i < f.length; i++) {
      if (f[i].type.startsWith('image/')) {
        void attachImageFile(f[i]);
      }
    }
  }
  function handleDragOver(e: DragEvent) { e.preventDefault(); }
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
      // Tab always completes. Enter completes only where a command is a PREFIX
      // of the real line; on a passthrough surface a command IS the whole line
      // (`/archive`), so an Enter eaten by the dropdown would make a one-word
      // command need two presses — and would swallow the missing-argument error.
      if (e.key === 'Tab' || (!passthroughSlash && e.key === 'Enter' && cmds.length > 0 && !e.shiftKey)) { e.preventDefault(); if (cmds[selectedIdx]) selectCommand(cmds[selectedIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); showSlash = false; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  }

  function doSend() {
    if (!inputText.trim() && images.length === 0) return;
    const text = inputText.trim();
    showMentions = false;

    // Passthrough surface: the parent parses the line itself, so nothing is
    // intercepted here. It answers `false` when it refused the line — the draft
    // is kept then, because retyping a whole message because you forgot an
    // argument is the wrong punishment. Ahead of the in-flight branch on
    // purpose: this surface has no turn of its own to interject into.
    if (passthroughSlash) {
      showSlash = false;
      // The attachments ride WITH the line rather than going to the host behind
      // the parent's back — this surface has no session to send them to — and
      // they are part of the DRAFT: a refusal keeps both, a success clears both.
      const attached: ComposerImage[] = images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }));
      if (onSend(text, undefined, attached.length ? attached : undefined) !== false) { inputText = ''; images = []; pasteSessionId = null; }
      inputEl?.focus();
      return;
    }

    // A turn is running: the line goes INTO it, on this keypress. It used to be
    // parked in a chip and delivered by a second click on an Interject button —
    // an extra gesture, and one the user had to know existed. Slash commands and
    // image attachments still wait for idle: their side effects are not part of
    // the conversation, so landing them mid-turn is a different act. Both keep
    // the draft rather than eating it, as does a mount with no `onInterject` at
    // all (a collab composer has no turn of its own to interrupt).
    if (inFlight) {
      if (text && !text.startsWith('/') && images.length === 0 && onInterject) {
        onInterject(text);
        inputText = '';
        inputEl?.focus();
      }
      return;
    }

    const attachedImages = [...images];
    showSlash = false;
    inputText = '';
    images = [];
    inputEl?.focus();

    // Route slash commands to the host's slashCommand handler, not a plain prompt
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const command = parts[0] || '';
      const args = parts.slice(1).join(' ');
      // Built-in autonomous/coach modes go through the SEND path (via onSend with a
      // mode) so the composer shows in-flight + Stop works like a normal turn.
      if (command === 'loop' || command === 'compose') {
        onSend(args, command);
        return;
      }
      vscode.postMessage({ type: 'slashCommand', command, args });
      return;
    }

    // If images are attached, send them along with the text. S7 V1 —
    // route by `pasteSessionId` (captured when the first image was
    // attached) so a tab switch between paste and send still lands the
    // image in the originating session. Falls back to the live
    // `sessionId` prop when no paste lock exists (no images, or a
    // future direct image attach).
    if (attachedImages.length > 0) {
      const targetSessionId = pasteSessionId ?? sessionId ?? null;
      pasteSessionId = null;
      vscode.postMessage({
        type: 'sendWithImages',
        text,
        sessionId: targetSessionId,
        images: attachedImages.map(img => ({ dataUrl: img.dataUrl, name: img.name })),
      });
      return;
    }

    onSend(text);
  }

  function toggleSlashPalette() {
    if (showSlash) { showSlash = false; return; }
    slashFilter = inputText.startsWith('/') ? inputText.slice(1) : '';
    selectedIdx = 0;
    showSlash = true;
    inputEl?.focus();
  }
</script>

<div class="input-area">
  <!-- One dropdown, two vocabularies: `/` commands and `@` people (never both). -->
  {#if showSlash}
    <SlashDropdown items={filteredCommands()} {selectedIdx} onPick={(i) => { const c = filteredCommands()[i]; if (c) selectCommand(c); }} onHover={(i) => (selectedIdx = i)} emptyText="No matching commands" />
  {:else if showMentions}
    <SlashDropdown items={mentionRows} selectedIdx={mentionIdx} onPick={selectMention} onHover={(i) => (mentionIdx = i)} emptyText="No matching participants" />
  {/if}

  <!-- Model connectivity banner: shown until THIS chat's provider confirms a
       model. Provider-aware: names the RIGHT server to go start — a Spark/vLLM
       chat must never be told to "start LM Studio". And it does NOT cry wolf
       while the probe is still out: `probing` is a neutral, unstyled line that
       asks for nothing (modelBanner.ts owns which of the three this is). -->
  {#if !bare && !modelOnline}
    {@const banner = bannerState(modelOnline, modelReason, providerIsLocal)}
    <div class="model-warning" class:probing={banner === 'probing'}
      title={banner === 'probing' ? 'Waiting for the provider to answer — this settles on its own.' : (modelReason || 'No model reported by the harness yet.')}>
      <span class="warn-dot"></span>
      <span class="warn-text">
        {#if banner === 'probing'}
          {probingText(providerLabel)}
        {:else if providerIsLocal}
          No model detected yet — start LM Studio and type a message to retry.
        {:else}
          {providerLabel || 'Provider'} unreachable — check the server, then type a message to retry.
        {/if}
      </span>
    </div>
  {/if}

  <!-- Monthly spend cap: amber warning from 80%, red block at 100% (cloud turns
       are refused host-side; +$5 raises the cap inline). Local models are free. -->
  {#if !bare && monthBudget && budgetPct >= 80}
    <div class="budget-banner" class:blocked={budgetPct >= 100} title="Monthly OpenRouter spend across all chats — set the cap in the OpenRouter settings.">
      <span class="budget-dot"></span>
      <span class="budget-text">
        {#if budgetPct >= 100}
          Monthly cap reached — {fmtUsd(monthSpend)} of {fmtUsd(monthBudget)}. Cloud turns are blocked (local models still work).
        {:else}
          Approaching monthly cap — {fmtUsd(monthSpend)} of {fmtUsd(monthBudget)} ({budgetPct}%).
        {/if}
      </span>
      {#if budgetPct >= 100}
        <button class="budget-raise" onclick={raiseBudget} title="Raise the monthly cap by $5">+$5</button>
      {/if}
    </div>
  {/if}

  <!-- Model bar — the per-chat model PICKER, plus the context gauge once a model
       is loaded. Always shown so a model can be picked even when none is loaded
       (the picker reads "Select model" then). Absent on a bare composer, which
       has no engine session to pick a model for. -->
  {#if !bare}
    <div class="model-bar">
      <ModelPicker {sessionId} fallbackName={modelName} online={modelOnline} />
      {#if modelOnline && modelName}
        <span class="ctx-turns">{turns} turn{turns !== 1 ? 's' : ''}</span>
        {#if contextUsed > 0}
          <!-- ONE clickable compact affordance whenever real tokens are in play. An
               unknown window keeps the honest ⚠ "N used" face (no invented denominator,
               no fake %) but stays CLICKABLE: /compact always worked, it just had no
               button, so the escape hatch vanished exactly when context was least known. -->
          <span class="ctx-sep">&middot;</span>
          <!-- Menu is a SIBLING of the gauge, not nested — else a click on it
               bubbles through the gauge's onclick and fires an accidental compact. -->
          <span class="ctx-gauge-wrap">
            <span
              class="ctx-gauge ctx-gauge-btn"
              class:ctx-unknown={!contextKnown}
              role="button"
              tabindex="0"
              title={contextKnown
                ? `${fmtK(contextUsed)}/${fmtK(gaugeTotal)} tokens (${contextPct}%) of this chat's ${windowSourceLabel} — click to compact (summarise older turns to free space); right-click to set a custom auto-compact threshold${compactionThresholdValue ? ` (currently ${compactionThresholdValue})` : ''}`
                : `${fmtK(contextUsed)} tokens used — context window unknown (no loaded-window report from the model server), so no %. Click to compact (summarise older turns to free space); right-click to set a custom auto-compact threshold.`}
              onclick={(e) => { e.stopPropagation(); onCompact?.(); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onCompact?.(); } }}
              oncontextmenu={openCompactionMenu}
            >
              {#if contextKnown}
                <svg class="gauge-svg" viewBox="0 0 36 36" width="15" height="15" aria-hidden="true">
                  <circle class="gauge-track" cx="18" cy="18" r="15.5" pathLength="100" />
                  <circle
                    class="gauge-arc"
                    cx="18" cy="18" r="15.5" pathLength="100"
                    style="stroke: {contextColor}; stroke-dasharray: {Math.min(contextPct, 100)} 100;"
                    transform="rotate(-90 18 18)"
                  />
                </svg>
                <span class="ctx-pct" style="color: {contextColor}">{contextPct}%</span>
              {:else}
                <span>{fmtK(contextUsed)} used &#9888;</span>
              {/if}
              {#if compactionPending}
                <span class="ctx-pending" title="Compaction done — the context drop applies on your next message">&#8595;</span>
              {/if}
            </span>
            <CompactionThresholdMenu
              open={compactionMenuOpen}
              current={compactionThresholdValue}
              onSelect={selectCompactionThreshold}
              onClose={() => (compactionMenuOpen = false)}
            />
          </span>
        {:else if contextWindow > 0}
          <span class="ctx-sep">&middot;</span>
          <span class="ctx-window">{fmtK(contextWindow)} ctx</span>
        {/if}
        {#if lastTps > 0}
          <span class="ctx-sep">&middot;</span>
          <span class="tps" title="Tokens/sec — last turn's average generation throughput">{lastTps} t/s</span>
        {/if}
        <!-- The badge is the TOTAL a user is being charged for this run: this
             chat plus the sub-agents it spawned. The tooltip breaks it apart,
             because "why did that jump" is answered by the split, not the sum.
             With no sub-agent spend it reads exactly as it always did. -->
        {#if totalCost > 0}
          <span class="ctx-sep">&middot;</span>
          <span class="cost" title={subagentCost > 0
            ? `${fmtUsd(totalCost)} (+${fmtUsd(subagentCost)} subagents) — this chat plus the sub-agents it spawned. Type /spend for this month's total across all chats.`
            : `This chat's cost so far. Local models are free; OpenRouter accrues. Type /spend for this month's total across all chats.`}>{fmtUsd(totalCost)}</span>
        {/if}
        {#if effortActive}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-think">{effortLabel.toUpperCase()}</span>
        {/if}
        {#if permissionMode !== 'default' && permissionMode !== 'build'}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-{permissionMode}">{permissionMode.toUpperCase()}</span>
        {/if}
        <!-- THIS CHAT's own Actions mode only — `approveButton.actionsActive`,
             never `approveButton.active`, which also lights up for the
             Browser row's GLOBAL setting. A chat sitting on plain Ask must
             not wear a BYPASS badge because some other window turned Browser
             on. -->
        {#if approveButton.actionsActive}
          <span class="ctx-sep">&middot;</span>
          <span class="mode-badge mode-{approveMode}">{approveMode === 'auto' ? 'AUTO' : 'BYPASS'}</span>
        {/if}
      {/if}
    </div>
  {/if}

  {#if imagesOn && images.length > 0}
    <ImageStrip {images} onRemove={removeImage} onOpen={onImageClick} />
  {/if}

  <!-- A line typed during the turn, on its way INTO it: the composer is already
       clear, so this is what stands in for it until the host answers. -->
  {#if !bare}
    <InterjectingChip {interjecting} />
  {/if}

  <!-- Input + send/cancel -->
  <div class="input-row">
    <textarea bind:this={inputEl} bind:value={inputText} oninput={handleInput} onkeydown={handleKeydown} onpaste={imagesOn ? handlePaste : undefined} ondrop={imagesOn ? handleDrop : undefined} ondragover={imagesOn ? handleDragOver : undefined} rows="2" {disabled} placeholder={placeholder || (inFlight ? 'Type to interrupt — Enter sends it into the running turn…' : 'Type a message or / for commands...')} class="input"></textarea>
    <div class="btn-col">
      <button class="btn send" onclick={doSend} {disabled} title={inFlight ? 'Send this into the running turn now' : 'Send'}>Send</button>
      {#if !bare}
        <button class="btn cancel" onclick={onCancel}>Cancel</button>
      {/if}
    </div>
  </div>

  <!-- Mode toggles -->
  <div class="mode-row">
    <button class="mode-btn slash-btn" class:active={showSlash} onclick={toggleSlashPalette} title="Commands (toolbar)">/</button>
    <!-- Everything between the `/` toggle and Export speaks to an engine
         session, so a bare composer carries none of it. -->
    {#if !bare}
      {#if effortOptions.length > 0}
        <div class="effort-wrap">
          <button class="mode-btn" class:active={effortActive} onclick={() => effortOpen = !effortOpen}
            title="Reasoning effort — click to set level">Effort</button>
          {#if effortOpen}
            <button class="effort-backdrop" aria-label="Close effort selector" onclick={() => effortOpen = false}></button>
            <div class="effort-pop" onclick={(e) => e.stopPropagation()}>
              <div class="effort-track">
                <div class="effort-rail-row">
                  {#each effortOptions as opt, i (opt.value)}
                    <button
                      class="effort-notch"
                      class:active={opt.value === effortCurrent}
                      onclick={() => { effortCurrent = opt.value; vscode.postMessage({ type: 'setEffort', effort: opt.value, sessionId }); }}
                      title={opt.name}
                    >
                      <span class="effort-dot"></span>
                    </button>
                    {#if i < effortOptions.length - 1}<span class="effort-rail"></span>{/if}
                  {/each}
                </div>
                <div class="effort-label-row">
                  {#each effortOptions as opt (opt.value)}
                    <span class="effort-label" class:active={opt.value === effortCurrent}>{opt.name}</span>
                  {/each}
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
      <!-- The session-mode control is per-chat: Build / Plan / Deep Plan. Trigger
           and popover both live in ModeControl.svelte (this file was at its cap
           and a third state needed markup, a panel and styles of its own); the
           badge above still mirrors the live mode. -->
      <ModeControl current={permissionMode} onSelect={selectMode} />
      <!-- Agents and the Flock routing indicator BOTH left this row (M4.2 UAT).
           The board keeps four other routes (sidebar ⚑, status bar, the
           `origami.openAgentManager` palette command, the nav rail), and Flock
           routing is deprecated — an indicator for a retired mechanism lies.
           The indicator component has since been DELETED with the Routings
           view; the engine's per-profile subagents binding has no UI. -->
      <!-- t-kgsupy round 4 — ONE ACCESS control, ONE popover, TWO labeled
           rows: Actions (this chat's own Ask/Auto/Bypass preset) and Browser
           (VS Code's OWN global chat-tool auto-approve — ALL chat tools, ALL
           workspaces, not scoped to this chat). Round 3 shipped these as two
           buttons; round 4 folds them so automation level is chosen in one
           place. The TRIGGER stays enabled in plan mode even though the
           Actions row goes dim there — Browser is not a per-session
           permission and must stay reachable. Label/colour (approveButton,
           approveButtonState.ts) show the RISKIER of the two settings, so a
           user glancing at one button still sees the more dangerous state
           armed. Semantics of both settings are exactly what they were as
           separate buttons — only the composer's own open/closed state
           merged. -->
      <div class="approve-wrap">
        <button class="mode-btn approve-btn" class:active={approveButton.active} class:bypass={approveButton.bypass} onclick={toggleApprovePopover}
          title="Access settings — click to set Actions (this chat's own approval mode) and Browser (VS Code's global chat-tool auto-approve, all workspaces). Setting the Browser row to Bypass triggers VS Code's own confirmation dialog, worded by VS Code itself.">{approveButton.label}</button>
        <ApprovePopover open={approveOpen} rows={approveRows} onClose={() => (approveOpen = false)} />
      </div>

      <!-- t-kgtr6c — the ONE Vision control. Round 2 put a picker here AND a
           separate lit read-out at the end of the row; round 3 folds them, and
           `native` is the fold. Lit-and-native means this model reads images
           itself; neutral means it cannot, and a click picks the agent that
           reads them for it. OFF by default, because arming adds a tool and a
           block of prompt to every turn that carries an image.
           The engine narrows further (session/vision.ts) — nothing is spent on
           a turn with no image, or on a model that can already look — so this
           button arms the route rather than forcing it. -->
      <VisionProfileMenu profile={visionProfile} agents={visionAgents} open={visionOpen} native={isVlm} {visionState} sessionId={sessionId ?? ''}
        onToggle={() => (visionOpen = !visionOpen)} onSelect={setVision} onClose={() => (visionOpen = false)} />

    {/if}
    {#if onExport}
      <button class="mode-btn" onclick={() => onExport?.()} disabled={!canExport} title="Export this conversation as markdown">&#8675; Export</button>
    {/if}
    <!-- The separate vision READ-OUT chip lived here until t-kgtr6c round 3. It
         said the same thing the Vision button above now says with its own lit
         state, and standing beside a control it did not control it read as a
         second, contradictory answer. `isVlm` is unchanged and now feeds that
         button's `native`. -->
  </div>
</div>

<style>
  .input-area { border-top: 1px solid var(--og-border); background: var(--og-pane-header); flex-shrink: 0; position: relative; }

  .model-warning { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: rgba(251, 191, 36, 0.12); border-bottom: 1px solid var(--og-border); }

  /* Monthly spend-cap banner — amber approaching, red at the cap. */
  .budget-banner { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: rgba(251, 191, 36, 0.14); border-bottom: 1px solid var(--og-border); }
  .budget-banner.blocked { background: rgba(248, 113, 113, 0.16); }
  .budget-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--og-warning); box-shadow: 0 0 6px var(--og-warning); flex-shrink: 0; }
  .budget-banner.blocked .budget-dot { background: var(--og-error); box-shadow: 0 0 6px var(--og-error); }
  .budget-text { font-size: 10px; color: var(--og-text-secondary); flex: 1; line-height: 1.35; }
  .budget-raise { font-size: 10px; font-weight: 600; padding: 2px 8px; border: 1px solid var(--og-border); border-radius: 4px; background: var(--og-btn-bg); color: var(--og-text-secondary); cursor: pointer; font-family: inherit; flex-shrink: 0; }
  .budget-raise:hover { border-color: var(--og-error); color: var(--og-text); }
  /* PROBING is not a warning. It keeps the row (so the composer does not jump
     when the verdict lands) and drops every alarm cue: no amber wash, no glow,
     a muted dot. The pulse stays — something IS still happening. */
  .model-warning.probing { background: transparent; }
  .warn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--og-warning); box-shadow: 0 0 6px var(--og-warning); flex-shrink: 0; animation: pulse 1.6s infinite; }
  .model-warning.probing .warn-dot { background: var(--og-text-muted); box-shadow: none; }
  .warn-text { font-size: 10px; color: var(--og-text-secondary); }
  .model-warning.probing .warn-text { color: var(--og-text-muted); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }

  /* --- Model bar (above input) --- */
  .model-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 12px;
    border-bottom: 1px solid var(--og-border);
  }

  .ctx-turns {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    margin-left: auto;
  }

  .ctx-sep {
    font-size: 10px;
    color: var(--og-text-muted);
  }

  .tps {
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
  }

  /* Per-chat cost readout — money, so a touch more presence than the muted tps. */
  .cost {
    font-size: 10px;
    font-weight: 600;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    cursor: help;
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
  .input-row { display: flex; gap: 8px; padding: 6px 12px; align-items: flex-end; }
  .input { flex: 1; min-height: 24px; max-height: 120px; padding: 6px 8px; font-family: inherit; font-size: 12px; color: var(--og-text); background: var(--og-input-bg); border: 1px solid var(--og-input-border); border-radius: 4px; resize: vertical; outline: none; }
  .input:focus { border-color: var(--og-chat); }
  .input::placeholder { color: var(--og-text-muted); }
  .input:disabled { opacity: 0.5; }

  .btn-col { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
  .btn { padding: 5px 12px; font-size: 12px; cursor: pointer; border: 1px solid var(--og-border); background: var(--og-btn-bg); color: var(--og-btn-text); border-radius: 3px; font-family: inherit; white-space: nowrap; }
  .btn:hover { background: var(--og-btn-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.send { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); }

  /* --- Mode toggles --- */
  .mode-row {
    display: flex;
    gap: 6px;
    padding: 2px 12px 4px;
  }

  .mode-btn {
    padding: 2px 8px;
    font-size: 10px;
    background: var(--og-surface);
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }

  .mode-btn:hover {
    color: var(--og-text-secondary);
    background: var(--og-btn-bg);
  }

  .mode-btn.active {
    background: var(--og-accent);
    color: white;
    border-color: var(--og-accent);
  }

  /* Plan mode toggle, active — the read-only state uses the brand accent so
     it reads as a deliberate, distinct mode (not the generic accent). */
  .mode-btn.plan-mode.active {
    background: var(--og-chat);
    border-color: var(--og-chat);
    color: var(--og-bg);
  }

  /* Auto-approve toggle: green when auto (accept edits), red when bypass (yolo)
     so the elevated-trust state is unmistakable. Order matters — .bypass follows
     .active so it wins at equal specificity. */
  .mode-btn.approve-btn.active {
    background: var(--og-success);
    border-color: var(--og-success);
    color: var(--og-bg);
  }
  .mode-btn.approve-btn.bypass {
    background: var(--og-error);
    border-color: var(--og-error);
    color: white;
  }
  .mode-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .effort-wrap { position: relative; display: inline-flex; }
  .effort-backdrop {
    position: fixed; inset: 0; z-index: 19;
    background: transparent; border: none; padding: 0; margin: 0; cursor: default;
  }
  .effort-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    padding: 10px 14px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  .effort-track {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .effort-rail-row {
    display: flex;
    align-items: center;
  }
  .effort-notch {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }
  .effort-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--og-border);
    transition: background 0.15s, transform 0.15s;
    flex-shrink: 0;
  }
  .effort-notch:hover .effort-dot {
    background: var(--og-text-muted);
    transform: scale(1.3);
  }
  .effort-notch.active .effort-dot {
    background: var(--og-accent);
    transform: scale(1.4);
    box-shadow: 0 0 6px var(--og-accent);
  }
  .effort-rail {
    width: 20px;
    height: 2px;
    background: var(--og-border);
    flex-shrink: 0;
  }
  .effort-label-row {
    display: flex;
    justify-content: space-around;
  }
  .effort-label {
    font-size: 9px;
    color: var(--og-text-muted);
    white-space: nowrap;
    text-align: center;
    flex: 1;
  }
  .effort-label.active {
    color: var(--og-accent);
    font-weight: 600;
  }

  /* .approve-wrap anchors ApprovePopover's absolute popover; the rail's own
     styles went with the markup (t-kgtr6c). */
  .approve-wrap { position: relative; display: inline-flex; }


  /* Per-chat context gauge — circular fill in the model bar (per session).
     .ctx-gauge-wrap anchors CompactionThresholdMenu's absolute popover. */
  .ctx-gauge-wrap { position: relative; display: inline-flex; }
  .ctx-gauge { display: inline-flex; align-items: center; gap: 3px; }
  .ctx-gauge-btn { cursor: pointer; border-radius: 3px; padding: 0 2px; }
  .ctx-gauge-btn:hover { background: var(--og-btn-hover, rgba(255,255,255,0.08)); }
  .ctx-gauge-btn:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .gauge-svg { display: block; }
  .gauge-track { fill: none; stroke: var(--og-border); stroke-width: 4; }
  .gauge-arc {
    fill: none;
    stroke-width: 4;
    stroke-linecap: round;
    transition: stroke-dasharray 0.3s ease, stroke 0.3s ease;
  }

  .slash-btn {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 700;
    min-width: 20px;
    padding: 2px 6px;
    color: var(--og-chat);
  }
  .slash-btn.active {
    background: var(--og-chat);
    color: var(--og-bg);
    border-color: var(--og-chat);
  }

  /* The dropdown's own rules moved to SlashDropdown.svelte with its markup. */
</style>
