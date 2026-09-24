<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // The chat-pane model picker — the single place model selection happens now.
  // Per-chat: it targets this cell's session.
  //
  // Two tiers: (1) Provider — the configured providers, from `providerStatus`
  // (green dot = Live); (2) Model — that provider's models, filterable: LM
  // Studio asks for a context length then loads (setModel + contextLength);
  // OpenRouter switches live with no context prompt. Eject (LM Studio) unloads
  // the loaded model to free VRAM.
  //
  // The sub-agent target also asks for a context length, for every provider —
  // it never loads or ejects (see selectModel), it only tells the engine what
  // number to treat as the children's context window for its own
  // auto-compaction bookkeeping; it does not touch what a server holds in VRAM.

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { onMount } from 'svelte';
  import { groupProviders } from './modelGrouping';
  import { withOffered, groupTooltip } from './offeredProviders';
  import { resolveTopSelection, resolveGroupProvider, resolveSelectedProvider } from './modelSelection';
  import { visibleModels, MODEL_CAP } from './modelList';
  import { hintLine, type GatewayNote } from './pickerHint';
  import { modelIdWithoutProvider } from './modelLabel';
  import { usagePillText } from './passthroughUsagePill';
  import { windowsTooltipText, parsePillWindows, type PillWindow } from './usageWindowsTooltip';
  import { chooseUsageTooltip } from './usageTooltipChoice';
  import ContextLengthPrompt from './ContextLengthPrompt.svelte';
  // ModelPickerRow, not ModelRow: modelList.ts already exports a `ModelRow` interface.
  import ModelPickerRow from './ModelPickerRow.svelte';
  import ModelPickerFollowUp from './ModelPickerFollowUp.svelte';
  import ModelPickerTab from './ModelPickerTab.svelte';
  import NoConnections from './NoConnections.svelte';
  import { TYPE_GLYPHS, vendorMark, tabLabel, tabTitle, subTitle } from './modelPickerMarks';
  const vscode = getVsCodeApi();

  interface Props {
    /** The session this picker drives (per-chat). */
    sessionId: string | null;
    /** The model name to show when this session has no per-session model yet. */
    fallbackName?: string;
    /** Whether a model is currently loaded/online (drives the trigger label). */
    online?: boolean;
    /** Claude Code passthrough cell — hides the sub-agent target, whose
     *  `setSubagentModel` is an ENGINE session option (passthroughCaps.ts). */
    passthrough?: boolean;
  }
  let { sessionId, fallbackName = '', online = false, passthrough = false }: Props = $props();

  let open = $state(false);
  // Broadcasts (fanned out to this webview by the shared host).
  let modelOptions = $state<Array<{ value: string; name: string; configured?: boolean; visionState?: string; group?: string; groupDetail?: string }>>([]);
  // True once the first providerStatus payload (even empty) has landed; nothing
  // in tier-1 renders before it. Gates the empty-providers message (so it never
  // flashes before the real answer) and the grouping (a section is decided by
  // baseURL, which only the probe carries). `modelOptions` can't do this job:
  // the host skips that broadcast when it has nothing to send, so the gate
  // would never lift; `providerStatus` posts unconditionally.
  let providerStatusReceived = $state(false);
  let providerStatus = $state<Array<{ id: string; name: string; live: boolean; reason?: string; baseURL?: string; flavor?: 'lmstudio' | 'ollama' | 'other'; kind?: 'local' | 'compat' | 'cloud' }>>([]);
  let openRouterModels = $state<Array<{ id: string; name: string; free?: boolean }>>([]);
  // Provider id -> what the host's last entitlement sweep pruned (pickerHint.ts);
  // keyless-catalog gateways only. `{}` on an older host, which draws no hint.
  let gatewayNotes = $state<Record<string, GatewayNote>>({});
  let modelBySession = $state<Record<string, string>>({}), subagentModelBySession = $state<Record<string, string>>({}); // latter = host-echo of setSubagentModel, for the trigger tooltip
  // The real loaded context window (seeds the ctx prompt) + WHICH model is loaded.
  let loadedCtx = $state(0);
  let loadedModelId = $state('');

  // OAuth connection + usage — the same host contract ControlStrip's oauth fold
  // uses, read here too so the trigger can show subscription burn next to the
  // active model without duplicating the fold's own UI.
  let oauthConnected = $state<Record<string, { type: string; expires?: number }>>({});
  // Provider id -> pre-formatted usage lines (providerUsage.ts); shown as given, never recomputed.
  let usageLines = $state<Record<string, string[]>>({});
  // Provider id -> the structured twin of `usageLines`, same order — the
  // pill's own number picks the TIGHTEST one (t-d942yi), and the tooltip
  // lists every one when there is more than one.
  let usageWindows = $state<Record<string, PillWindow[]>>({});
  // Provider ids whose subscription is bought with an API key rather than OAuth
  // (opencode-go). Empty on an older host, so the OAuth path survives version skew.
  let usageCapable = $state<string[]>([]);

  // Eject + context-length-on-load are LM Studio operations. Shown only for a
  // provider the host probed as LM Studio (`flavor`), not any loopback server:
  // a local Ollama is loopback but not lms-managed. Anything else switches live
  // with no phantom controls.
  function isLmsManaged(id: string): boolean {
    return providerStatus.find(p => p.id === id)?.flavor === 'lmstudio';
  }
  // Full "<provider>/<id>" of the model the server currently holds ('' = none).
  let lmsId = $derived(providerStatus.find(p => p.flavor === 'lmstudio')?.id ?? '');
  let loadedValue = $derived(loadedModelId && lmsId ? `${lmsId}/${loadedModelId}` : '');

  // This session's current model value ("<provider>/<id>"), the source of truth for the trigger label + the "current" tick.
  let current = $derived(sessionId ? (modelBySession[sessionId] ?? '') : '');
  let triggerTitle = $derived(!current ? 'Select a model for this chat' : (!passthrough && sessionId && subagentModelBySession[sessionId]) ? `${current} — click to switch model (this chat) · sub-agents run on ${subagentModelBySession[sessionId]}` : `${current} — click to switch model (this chat)`); // names the sub-agent override too — not on the passthrough cell (no sub-agent target) or when none is set

  // Tier-1 providers: the configured ones (from providerStatus, carrying the
  // host's baseURL, the only signal that buckets a provider into its section),
  // plus the ones the host offers without a connection to configure (offeredProviders.ts).
  let providers = $derived.by(() => {
    if (providerStatus.length > 0) return withOffered(providerStatus.map(p => ({ id: p.id, name: p.name, live: p.live, baseURL: p.baseURL })), modelOptions);
    // Nothing before the probe answers: modelOptions arrives first, and
    // grouping its baseURL-less ids would re-bucket the tab bar under the
    // cursor once the real payload lands. The loading gate holds instead.
    if (!providerStatusReceived) return [];
    // Degenerate safety net: the probe answered and listed nothing while
    // modelOptions still carries ids (an engine-side catalog). A group row
    // names its own tab, so it must not be id-scanned into a bare-id one.
    const ids = Array.from(new Set(modelOptions.filter(o => !o.group).map(o => o.value.split('/')[0]).filter(Boolean)));
    return withOffered(ids.map(id => ({ id, name: id, live: false })), modelOptions);
  });

  // Tier-1 grouping: one tab per section — a lone provider is its own tab, 2+
  // collapse behind that section's pill (modelGrouping.ts).
  let grouping = $derived(groupProviders(providers));
  // The probe answered and named nothing — the final empty state.
  let noConnections = $derived(providerStatusReceived && providers.length === 0);
  // 'no model' outranks `current`: with nothing configured the engine still
  // seeds an unresolvable id, and printing it would name a model the chat can't reach.
  let triggerLabel = $derived(noConnections ? 'no model' : current ? modelIdWithoutProvider(current) : (online && fallbackName ? fallbackName : 'Select model'));
  let currentProviderId = $derived(current.split('/')[0] ?? '');

  // Compact usage readout for the active model's own provider — hidden unless
  // that provider can report usage and a line has arrived. Two ways to be
  // capable: an OAuth sign-in, or a flat-rate plan bought with an API key.
  let canReadUsage = $derived(!!currentProviderId && (!!oauthConnected[currentProviderId] || usageCapable.includes(currentProviderId)));

  // A Claude Code cell's plan headroom fills the same slot, answering the same
  // question, since a second badge elsewhere would split attention. It can't
  // come through `usageLines`: that's an on-demand engine read for a
  // configured provider, and `claude-code` is offered rather than configured.
  // The countdown recomputes against `usageNow`, bumped on events this picker
  // already re-renders for — no timer (passthroughUsagePill.ts).
  let ccPct = $state(-1);
  let ccResetsAt = $state(0);
  let ccPillTitle = $state('');
  // Every window the plan reported (5h/7d/30d…), for the tooltip. The pill's
  // OWN number stays `ccPct` — the tightest lane, already picked host-side
  // (planPillOf / rateLimitPillOf) — this is only the breakdown underneath it.
  let ccWindows: PillWindow[] = $state([]);
  let usageNow = $state(Date.now());
  let ccUsageText = $derived(usagePillText(ccPct, ccResetsAt, usageNow));

  // The generic OAuth/API-key providers (ChatGPT, xai, Copilot, GO…): the
  // windows array `usageLines` was built alongside, same order and index.
  // The pill's own number is the TIGHTEST window, not always the first one
  // the provider happened to list first (t-d942yi — the owner's 73% pill sat
  // next to a maxed-out lane the old windows[0]-only read never showed).
  let genericWindows = $derived(usageWindows[currentProviderId] ?? []);
  let genericTightestIdx = $derived.by(() => {
    const ws = genericWindows;
    let idx = 0;
    for (let i = 1; i < ws.length; i++) if (ws[i].pct > ws[idx].pct) idx = i;
    return idx;
  });
  let genericText = $derived(canReadUsage ? (usageLines[currentProviderId]?.[genericTightestIdx] ?? '') : '');
  let usageText = $derived(ccUsageText || genericText);
  // Which limit the tooltip names — the rule lives in usageTooltipChoice.ts.
  let usageTitle = $derived(chooseUsageTooltip({ ccUsageText, ccPillTitle, genericText, usageText,
    ccWindowCount: ccWindows.length, genericWindowCount: genericWindows.length,
    ccList: windowsTooltipText(ccWindows, usageNow), genericList: windowsTooltipText(genericWindows, usageNow) }));

  // topPick = the explicit top-level tab; groupPick = the explicit sub-provider
  // within whichever pill is active. Both default via the current model.
  let topPick = $state('');
  let groupPick = $state('');
  let topSelection = $derived(resolveTopSelection(grouping, topPick, currentProviderId));
  let activeTab = $derived(grouping.tabs.find(t => t.id === topSelection));
  let selectedGroupProvider = $derived(activeTab?.collapsed ? resolveGroupProvider(activeTab.members, groupPick, currentProviderId) : '');
  // The concrete provider whose model list shows (a pill resolves to its sub-pick).
  let selectedProvider = $derived(resolveSelectedProvider(grouping, topSelection, selectedGroupProvider));

  let filter = $state('');
  // Tier-2 rows for the selected provider, filtered + ordered (modelList.ts).
  let visible = $derived(
    visibleModels({ providerId: selectedProvider, modelOptions, openRouterModels, filter, loadedValue }),
  );
  // Why the list is short: the render cap, the gateway's prune, or both.
  let hint = $derived(hintLine({ shown: Math.min(visible.length, MODEL_CAP), total: visible.length, cap: MODEL_CAP, note: gatewayNotes[selectedProvider] }));

  // Which target the next pick applies to: this chat's own model, or the
  // per-chat sub-agent override. Reset on every open — a sticky target would
  // silently send a later pick somewhere the user is no longer looking.
  let forSubagents = $state(false);
  let pickType = $derived(forSubagents ? 'setSubagentModel' : 'setModel');

  // t-di2zmm: the model just picked for THIS chat, offered as a sub-agent follow-up.
  let justPicked = $state('');
  let showFollowUp = $derived(!!justPicked && !passthrough && subagentModelBySession[sessionId ?? ''] !== justPicked);

  // The LM Studio model awaiting a context-length choice ('' = none).
  let ctxPromptFor = $state('');
  // The sub-agent-target model awaiting its (optional) context-length choice.
  let subagentCtxFor = $state('');

  // In grid mode every cell mounts its own picker, so the listener lives in
  // onMount with a cleanup — otherwise closed cells leak dead listeners.
  onMount(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'modelOptions') { modelOptions = Array.isArray(msg.options) ? msg.options : []; gatewayNotes = msg.gatewayNotes ?? {}; }
      else if (msg.type === 'providerStatus') { providerStatus = Array.isArray(msg.providers) ? msg.providers : []; providerStatusReceived = true; retryUsage(); } // a provider that just came back live is a reason to re-ask
      else if (msg.type === 'openRouterModels') openRouterModels = Array.isArray(msg.models) ? msg.models : [];
      else if (msg.type === 'sessionModels') { modelBySession = (msg.models && typeof msg.models === 'object') ? msg.models : {}; subagentModelBySession = (msg.subagentModels && typeof msg.subagentModels === 'object') ? msg.subagentModels : {}; retryUsage(); } // `current` only exists once THIS lands
      else if (msg.type === 'modelStatus') {
        // Statuses are per-session now — only this chat's may seed the picker.
        // Untagged = legacy/boot broadcast, accept.
        if (msg.sessionId != null && msg.sessionId !== sessionId) return;
        // The local server's own loaded window, not this session's
        // contextWindow — on a remote chat that one is the remote model's, and
        // would misreport as a currently-loaded size.
        if (typeof msg.loadedContextLength === 'number' && msg.loadedContextLength > 0) loadedCtx = msg.loadedContextLength;
        if (typeof msg.loadedModelId === 'string') loadedModelId = msg.loadedModelId;
      }
      else if (msg.type === 'providerAuthData') { oauthConnected = (msg.connected && typeof msg.connected === 'object') ? msg.connected : {}; retryUsage(); } // canReadUsage may have just flipped true
      else if (msg.type === 'providerUsageCapable') { usageCapable = Array.isArray(msg.ids) ? (msg.ids as unknown[]).map(String) : []; retryUsage(); } // ditto for the key-bought plans
      // An ANSWER is recorded even when it carries no lines (`unavailable`): the
      // empty array is what stops the re-ask below, so a provider that says "no
      else if (msg.type === 'providerUsageData' && typeof msg.providerId === 'string') {
        usageLines = { ...usageLines, [msg.providerId]: Array.isArray(msg.lines) ? (msg.lines as unknown[]).map(String) : [] };
        usageWindows = { ...usageWindows, [msg.providerId]: parsePillWindows(msg.windows) };
      } // usage source" is asked once, not every tick.
      // The passthrough meter. `pillPct < 0` is the retraction an unbind sends,
      // and it must clear the slot: a headroom badge left on an engine cell
      // would claim a plan is paying for turns that spend real money.
      else if (msg.type === 'passthroughMeter' && msg.sessionId === sessionId) {
        ccPct = msg.subscription && typeof msg.pillPct === 'number' ? msg.pillPct : -1;
        ccResetsAt = typeof msg.pillResetsAt === 'number' ? msg.pillResetsAt : 0;
        ccPillTitle = typeof msg.pillTitle === 'string' ? msg.pillTitle : '';
        ccWindows = parsePillWindows(msg.windows);
        usageNow = Date.now();
      }
      // Turn-end refresh: usage moves once per reply, not on a timer.
      else if (msg.type === 'turnDone' && msg.sessionId === sessionId) { usageNow = Date.now(); requestUsage(); }
    };
    window.addEventListener('message', onMsg);
    // Seed on mount (covers a picker that mounted after the first broadcast).
    vscode.postMessage({ type: 'requestSessionModels' });
    vscode.postMessage({ type: 'providerAuthRequest' });
    vscode.postMessage({ type: 'providerUsageCapableRequest' });
    return () => window.removeEventListener('message', onMsg);
  });

  // Lazy usage pull for the active model's own provider, only when it has a
  // usage source at all. Model-bar open + turn end, no timer.
  function requestUsage() { if (canReadUsage) vscode.postMessage({ type: 'providerUsageRequest', providerId: currentProviderId }); }
  // The same pull, made when a late input flips `canReadUsage` true. Guarded on
  // "never answered" so it repairs rather than polls.
  function retryUsage() { if (!usageLines[currentProviderId]) requestUsage(); }

  function openMenu() {
    open = !open;
    if (!open) return;
    filter = '';
    ctxPromptFor = '';
    subagentCtxFor = '';
    forSubagents = false;
    justPicked = '';
    requestUsage();
    // Pull fresh lists on open.
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestProviderStatus' });
    vscode.postMessage({ type: 'requestSessionModels' });
  }

  // OpenRouter's catalog is a live fetch — pull it when its (sub-)tab is selected.
  function maybeFetchOpenRouter(id: string) {
    if (id === 'openrouter') vscode.postMessage({ type: 'requestOpenRouterModels', providerId: 'openrouter' });
  }

  // Pick a top-level tab: a real provider id, or a collapsed section's pill.
  function pickTop(id: string) {
    topPick = id;
    filter = '';
    ctxPromptFor = '';
    subagentCtxFor = '';
    const tab = grouping.tabs.find(t => t.id === id);
    if (tab?.collapsed) maybeFetchOpenRouter(resolveGroupProvider(tab.members, groupPick, currentProviderId));
  }

  // Pick which provider (second-level) within the active pill's sub-select.
  function pickGroup(id: string) {
    groupPick = id;
    filter = '';
    ctxPromptFor = '';
    subagentCtxFor = '';
    maybeFetchOpenRouter(id);
  }

  function selectModel(value: string) {
    // Sub-agent target: always asks for an optional context override, no LM Studio load prompt.
    if (forSubagents) { subagentCtxFor = value; return; }
    if (isLmsManaged(selectedProvider)) {
      // LM Studio: ask for a context length before loading, including the
      // model already held (keeping that window costs no reload, host-side).
      ctxPromptFor = value;
      return;
    }
    // Cloud (OpenRouter / …): switch live, per-chat, no context prompt.
    vscode.postMessage({ type: pickType, modelId: value, sessionId });
    if (passthrough || subagentModelBySession[sessionId ?? ''] === value) { open = false; return; }
    justPicked = value;
  }

  function confirmCtx(value: number | undefined) {
    vscode.postMessage({ type: 'setModel', modelId: ctxPromptFor, sessionId, contextLength: value });
    const stayOpen = !passthrough && subagentModelBySession[sessionId ?? ''] !== ctxPromptFor;
    justPicked = stayOpen ? ctxPromptFor : '';
    ctxPromptFor = '';
    if (!stayOpen) open = false;
  }

  function alsoForSubagents() {
    vscode.postMessage({ type: 'setSubagentModel', modelId: justPicked, sessionId });
    justPicked = '';
    open = false;
  }
  function chooseSubagentModel() { forSubagents = true; justPicked = ''; }

  function confirmSubagentCtx(value: number | undefined) {
    vscode.postMessage({ type: 'setSubagentModel', modelId: subagentCtxFor, sessionId, contextLength: value });
    subagentCtxFor = '';
    open = false;
  }

  // The row chip's click: pin this model as able to read images, or hand it
  // back to Auto. Not a model switch — the user is correcting a fact about a
  // row, not necessarily selecting it. The menu stays open: the host
  // re-broadcasts `modelOptions` and the chip repaints in place as confirmation.
  function toggleVision(value: string) {
    const state = modelOptions.find(o => o.value === value)?.visionState;
    vscode.postMessage({ type: 'setVisionPin', mode: state === 'on' ? '' : 'on', modelId: value, sessionId });
  }

  function eject() {
    vscode.postMessage({ type: 'modelPanel.unload' });
    open = false;
  }
</script>

<span class="mp">
  <button class="mp-trigger" class:placeholder={!current} onclick={openMenu} use:tip={triggerTitle}>
    <span class="mp-name">{triggerLabel}</span>
    <span class="mp-caret" aria-hidden="true">&#9662;</span>
  </button>
  {#if usageText}
    <span class="mp-usage" class:mp-usage-plan={!!ccUsageText} use:tip={usageTitle}>{usageText}</span>
  {/if}

  {#if open}
    <button class="mp-backdrop" aria-label="Close model picker" onclick={() => (open = false)}></button>
    <div class="mp-menu" role="dialog" aria-label="Select model">
      <!-- Tier 0: who the next pick is for. Sub-agents are the fan-out's cost
           centre, so choosing a cheaper model for them is first-class here. -->
      {#if !passthrough}
      <div class="mp-target" role="group" aria-label="Apply the model to">
        <button class="mp-target-btn" class:active={!forSubagents} onclick={() => { forSubagents = false; justPicked = ''; }} use:tip={'Pick the model for THIS chat'}>This chat</button>
        <button class="mp-target-btn" class:active={forSubagents} onclick={() => { forSubagents = true; justPicked = ''; }} use:tip={'Pick the model every sub-agent this chat spawns runs on'}>Sub-agents</button>
      </div>
      {/if}
      <!-- Tier 1: provider, one tab per section; a lone provider is its own
           tab, 2+ collapse into that section's pill. -->
      <div class="mp-providers" role="tablist" aria-label="Provider">
        {#each grouping.tabs as tab (tab.id)}
          <ModelPickerTab
            label={tabLabel(tab.name)}
            active={topSelection === tab.id}
            live={tab.live}
            tip={tabTitle(tab, modelOptions)}
            mark={{ kind: 'type', glyph: TYPE_GLYPHS[tab.section] }}
            onClick={() => pickTop(tab.id)}
          />
        {/each}
      </div>
      <!-- Nothing configured (NoConnections.svelte). Outside the tablist: it holds no tabs. -->
      {#if grouping.tabs.length === 0}<NoConnections ready={providerStatusReceived} />{/if}

      {#if activeTab?.collapsed}
        <!-- Tier 1b: which provider within the active pill's sub-select -->
        <div class="mp-group-subs" role="tablist" aria-label="{activeTab.name} provider">
          {#each activeTab.members as p (p.id)}
            <ModelPickerTab
              label={p.name}
              active={selectedGroupProvider === p.id}
              live={p.live}
              tip={subTitle(p, modelOptions)}
              mark={{ kind: 'source', mark: vendorMark(p.name) }}
              sub={true}
              onClick={() => pickGroup(p.id)}
            />
          {/each}
        </div>
      {/if}

      {#if selectedProvider}
        <!-- Tier 2: model list (filterable) -->
        <input
          class="mp-filter"
          type="text"
          bind:value={filter}
          placeholder="Filter models…"
          spellcheck="false"
          autocomplete="off"
          aria-label="Filter models"
        />
        <div class="mp-models" role="listbox" aria-label="Models">
          {#each visible.slice(0, MODEL_CAP) as mo (mo.value)}
            {#if ctxPromptFor === mo.value}
              <!-- LM Studio context-length prompt before load. -->
              <ContextLengthPrompt
                modelName={mo.name}
                initial={loadedCtx > 0 ? loadedCtx : ''}
                hint={mo.value === loadedValue && loadedCtx > 0 ? `Currently loaded at ${Math.round(loadedCtx / 1024)}k — confirm to keep it (no reload), or set a new window to eject and reload at that size.` : 'Blank = a safe default. Higher windows use more VRAM.'}
                confirmLabel="Load"
                onConfirm={confirmCtx}
                onCancel={() => (ctxPromptFor = '')}
              />
            {:else if subagentCtxFor === mo.value}
              <!-- Sub-agent context OVERRIDE (t-lmqe0g) — bookkeeping only, no load. -->
              <ContextLengthPrompt
                modelName={mo.name}
                initial=""
                hint="Blank = the model's own configured limit. This only sets the sub-agents' own auto-compaction budget — it does not load anything or change what any server holds in VRAM."
                onConfirm={confirmSubagentCtx}
                onCancel={() => (subagentCtxFor = '')}
              />
            {:else if showFollowUp && justPicked === mo.value}
              <!-- t-di2zmm: this chat's pick just landed — offer the sub-agent target in place of the row. -->
              <ModelPickerFollowUp
                modelName={mo.name}
                onAlsoForSubagents={alsoForSubagents}
                onChooseSubagentModel={chooseSubagentModel}
              />
            {:else}
              <ModelPickerRow
                value={mo.value}
                name={mo.name}
                current={mo.value === current}
                loaded={mo.value === loadedValue}
                visionState={mo.visionState ?? ''}
                onSelect={selectModel}
                onVision={toggleVision}
              />
            {/if}
          {:else}
            <div class="mp-empty">
              {#if filter.trim()}No models match your filter.
              {:else if selectedProvider === 'openrouter'}No models — check the API key in Settings.
              {:else if selectedProvider === 'claude-subscription'}{groupTooltip(modelOptions, activeTab?.name ?? '')}
              {:else}No models — load one in LM Studio.{/if}
            </div>
          {/each}
        </div>
        {#if hint}
          <span class="mp-hint">{hint}</span>
        {/if}

        {#if isLmsManaged(selectedProvider)}
          <button class="mp-eject" onclick={eject} use:tip={'Unload the loaded model from LM Studio (frees VRAM)'}>⏏ Eject loaded model</button>
        {/if}
      {/if}
    </div>
  {/if}
</span>

<style>
  .mp { position: relative; display: inline-flex; min-width: 0; }
  .mp-trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    min-width: 0;
    padding: 2px 6px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .mp-trigger:hover { border-color: var(--og-border); color: var(--og-text); }
  .mp-trigger.placeholder { color: var(--og-chat); font-family: inherit; }
  .mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .mp-caret { color: var(--og-chat); flex-shrink: 0; font-size: 9px; }
  /* Compact usage readout next to the trigger — full text lives in the title.
     150px used to be tighter than the text it was sizing: usageLine() (see
     providerUsage.ts) produces lines like "On-demand: 100% used, resets in
     29d 23h" (~39 chars), which the ellipsis silently ate the tail of — always,
     not just under a crowded bar. Sized to content (no explicit width) instead
     of a guessed fixed one; max-width is a generous SAFETY CAP for a
     pathological provider-supplied label, not the normal-case bound. */
  .mp-usage { overflow: hidden; width: max-content; max-width: 280px; padding: 1px 5px; font-size: 9.5px; color: var(--og-text-muted); white-space: nowrap; text-overflow: ellipsis; border: 1px solid var(--og-border); border-radius: 4px; }
  /* Plan headroom, not a quota read: the CLI only volunteers this once it has
     already raised a warning, so it is never merely informational. */
  .mp-usage-plan { color: var(--og-warning); }

  .mp-target { display: flex; gap: 4px; }
  .mp-target-btn { flex: 1 1 0; height: 20px; padding: 0 6px; font-size: 10px; font-family: inherit; color: var(--og-text-secondary); background: var(--og-btn-bg); border: 1px solid var(--og-border); border-radius: 4px; cursor: pointer; }
  .mp-target-btn:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .mp-target-btn.active { color: var(--og-text); border-color: var(--og-accent); }

  .mp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
  }
  /* t-q9013i: three narrowing columns (type | source | models) instead of the
     old stacked target -> type -> source -> filter -> models, so the whole
     tier path is visible at once and every tier is revisable without walking
     back. 94/120/1fr per the ticket; 264px is 40% shorter than the picker's
     first pass, and the model list fills whatever height that leaves it. */
  .mp-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 41;
    width: 560px; /* 300px wrapped a 90-char self-quantised GGUF id over 8 lines */
    max-width: min(84vw, calc(100vw - 24px));
    display: grid;
    grid-template-columns: 94px 120px minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 5px;
    height: 264px;
    max-height: 70vh;
    padding: 8px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
  }
  /* The target pills and the filter share the header line (row 1); the
     no-target passthrough case just leaves columns 1-2 of that row empty. */
  .mp-menu > .mp-target { grid-column: 1 / 3; grid-row: 1; }
  .mp-menu > .mp-filter { grid-column: 3; grid-row: 1; }
  .mp-menu > .mp-providers { grid-column: 1; grid-row: 2; }
  .mp-menu > .mp-group-subs { grid-column: 2; grid-row: 2; }
  .mp-menu > .mp-models { grid-column: 3; grid-row: 2; }
  .mp-menu > .mp-hint { grid-column: 1 / 3; grid-row: 3; }
  /* Footer row, right side, so it does not wrap into the type column. */
  .mp-menu > .mp-eject { grid-column: 3; grid-row: 3; align-self: center; justify-self: end; white-space: nowrap; }
  /* Empty-providers state takes the model column's slot. */
  .mp-menu > :global(.nc) { grid-column: 3; grid-row: 2; min-height: 0; overflow-y: auto; }

  .mp-providers, .mp-group-subs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;
    overflow-y: auto;
    min-height: 0;
  }

  .mp-filter {
    width: 100%;
    box-sizing: border-box;
    height: 20px;
    padding: 0 6px;
    font-size: 10px;
    font-family: inherit;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 4px;
    outline: none;
  }
  .mp-filter:focus { border-color: var(--og-chat); }

  .mp-models {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
  }
  /* The row's own styling went to ModelRow.svelte with its markup — see that
     file's header for why the extraction landed there. */

  .mp-eject {
    padding: 5px 8px;
    font-size: 11px;
    text-align: left;
    background: transparent;
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .mp-eject:hover { border-color: var(--og-chat); color: var(--og-text); }

  .mp-empty, .mp-hint {
    padding: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    line-height: 1.35;
  }
</style>
