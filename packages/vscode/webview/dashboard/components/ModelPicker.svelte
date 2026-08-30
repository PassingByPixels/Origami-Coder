<script lang="ts">
  // The CHAT-PANE model picker — the single place model selection happens now
  // (settings is connections-only). Per-chat: it targets THIS cell's session, so
  // different chats can run different models.
  //
  // Two tiers in one fold:
  //   1. Provider  — the configured providers (LM Studio / OpenRouter / …), from
  //                  the host's `providerStatus` probe (green dot = Live).
  //   2. Model     — that provider's models, filterable:
  //        · LM Studio (local) → the live library (`modelOptions`); picking one
  //          asks for a context length, then loads it (setModel + contextLength).
  //        · OpenRouter        → its live catalog (`openRouterModels`); picking one
  //          switches live (setModel), no context prompt (cloud).
  // Eject (LM Studio) unloads the loaded model to free VRAM.
  //
  // Everything posts the EXACT host message the DashboardPanel already actions:
  //   pick    → { type:'setModel', modelId, sessionId, contextLength? }
  //   pick (sub-agent target) → { type:'setSubagentModel', modelId, sessionId, contextLength? }
  //   eject   → { type:'modelPanel.unload' }
  // The picker is self-contained given `sessionId`: it subscribes to the same
  // broadcasts the sidebar consumes (all fan out to this webview too).
  //
  // t-lmqe0g: the sub-agent target ALSO asks for a context length now, for every
  // provider (not gated to LM Studio like the main-chat prompt below) — it never
  // loads or ejects anything (see selectModel), it only tells the engine what
  // number to treat as the children's context window for its OWN auto-compaction
  // bookkeeping. It does NOT change what a local server holds loaded in VRAM,
  // which a model-load-time parameter outside this request path controls.

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { onMount } from 'svelte';
  import { parseModelId } from './modelLabel';
  import { groupProviders } from './modelGrouping';
  import { resolveTopSelection, resolveGroupProvider, resolveSelectedProvider } from './modelSelection';
  import { visibleModels, MODEL_CAP } from './modelList';
  import ContextLengthPrompt from './ContextLengthPrompt.svelte';
  const vscode = getVsCodeApi();

  interface Props {
    /** The session this picker drives (per-chat). */
    sessionId: string | null;
    /** The model name to show when this session has no per-session model yet. */
    fallbackName?: string;
    /** Whether a model is currently loaded/online (drives the trigger label). */
    online?: boolean;
  }
  let { sessionId, fallbackName = '', online = false }: Props = $props();

  let open = $state(false);
  // Broadcasts (fanned out to this webview by the shared host).
  let modelOptions = $state<Array<{ value: string; name: string; configured?: boolean }>>([]);
  // True once the FIRST providerStatus payload (even an empty one) has landed.
  // NOTHING in tier-1 renders before it. Two jobs in one flag:
  //   · it gates the empty-providers message, so that message never flashes
  //     before the real answer arrives (owner screenshot: it showed with
  //     providers configured);
  //   · it gates the GROUPING, because a section is decided by baseURL and only
  //     the probe carries one — bucketing anything earlier paints a tab bar that
  //     visibly re-shuffles when the real answer lands.
  // modelOptions cannot do this job: the host SKIPS that broadcast entirely when
  // it has nothing to send (broadcastModelOptions returns early on an empty
  // merge), so the gate would never lift for the very case it exists for.
  // broadcastProviderStatus posts unconditionally, so this gate always lifts.
  let providerStatusReceived = $state(false);
  let providerStatus = $state<Array<{ id: string; name: string; live: boolean; reason?: string; baseURL?: string; flavor?: 'lmstudio' | 'ollama' | 'other'; kind?: 'local' | 'compat' | 'cloud' }>>([]);
  let openRouterModels = $state<Array<{ id: string; name: string; free?: boolean }>>([]);
  let modelBySession = $state<Record<string, string>>({});
  // The real loaded context window (seeds the ctx prompt) + WHICH model is loaded.
  let loadedCtx = $state(0);
  let loadedModelId = $state('');

  // OAuth connection + usage — the SAME host contract ControlStrip's oauth fold
  // already uses (providerAuthRequest -> providerAuthData `connected`;
  // providerUsageRequest -> providerUsageData pre-formatted `lines`). Read here
  // too so the trigger can show "am I burning my subscription" next to the
  // active model, without duplicating the fold's own UI.
  let oauthConnected = $state<Record<string, { type: string; expires?: number }>>({});
  // Provider id -> pre-formatted usage lines. Host-formatted on purpose (see
  // providerUsage.ts) — never recomputed here, only shown as given.
  let usageLines = $state<Record<string, string[]>>({});
  // Provider ids whose subscription is bought with an API KEY rather than an
  // OAuth sign-in (opencode-go). Host-read from the config; empty on an older
  // host, which is what makes the OAuth path below survive a version skew.
  let usageCapable = $state<string[]>([]);

  // Eject + context-length-on-load are LM Studio operations (they drive the `lms`
  // CLI). Show them ONLY for a provider the host PROBED as LM Studio (`flavor` =
  // it answers /api/v0/models), not merely any loopback server: a local Ollama is
  // loopback too but is NOT lms-managed, and a remote vLLM serves a fixed model.
  // Anything not lms-managed switches live with no phantom controls — honest
  // display of whatever model + context window it actually has.
  function isLmsManaged(id: string): boolean {
    return providerStatus.find(p => p.id === id)?.flavor === 'lmstudio';
  }
  // Full "<provider>/<id>" of the model the server currently holds ('' = none).
  let lmsId = $derived(providerStatus.find(p => p.flavor === 'lmstudio')?.id ?? '');
  let loadedValue = $derived(loadedModelId && lmsId ? `${lmsId}/${loadedModelId}` : '');

  // This session's current model value ("<provider>/<id>"), the source of truth
  // for the trigger label + the "current" tick.
  let current = $derived(sessionId ? (modelBySession[sessionId] ?? '') : '');
  function pretty(v: string): string {
    if (!v) return '';
    const parts = v.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : v;
  }
  let triggerLabel = $derived(current ? pretty(current) : (online && fallbackName ? fallbackName : 'Select model'));

  // Tier-1 providers: the configured ones (from providerStatus, carrying the
  // host's baseURL — the ONLY signal that buckets a provider into its section).
  let providers = $derived.by(() => {
    if (providerStatus.length > 0) return providerStatus.map(p => ({ id: p.id, name: p.name, live: p.live, baseURL: p.baseURL }));
    // Nothing before the probe answers. modelOptions arrives first (it is the
    // faster broadcast), and grouping its baseURL-less ids put every provider in
    // "Local" until the real payload re-bucketed them — the tab bar reshuffling
    // under the cursor. The loading gate holds instead.
    if (!providerStatusReceived) return [];
    // Degenerate safety net, reachable ONLY after the probe has answered and
    // listed nothing while modelOptions still carries ids (an engine-side
    // catalog the global origami.json does not hold). That is a FINAL state,
    // not a mid-flight one, so it cannot re-bucket under the user.
    const ids = Array.from(new Set(modelOptions.map(o => o.value.split('/')[0]).filter(Boolean)));
    return ids.map(id => ({ id, name: id, live: false }));
  });

  // Tier-1 grouping: one tab per section (Local/Hosted/Providers/Labs/Other) —
  // a lone provider is its own tab, 2+ collapse behind that section's pill.
  // Display-only; see modelGrouping.ts.
  let grouping = $derived(groupProviders(providers));
  let currentProviderId = $derived(current.split('/')[0] ?? '');

  // Compact usage readout for the ACTIVE model's own provider — hidden unless
  // that provider CAN report usage and a line has actually arrived. Two ways to
  // be capable: an OAuth sign-in (openai/xai), or a flat-rate plan bought with
  // an API key (opencode-go). xai's "unavailable" answer carries no `lines`, so
  // it naturally stays hidden here too (the fold's own quiet-by-default).
  let canReadUsage = $derived(!!currentProviderId && (!!oauthConnected[currentProviderId] || usageCapable.includes(currentProviderId)));
  let usageText = $derived(canReadUsage ? (usageLines[currentProviderId]?.[0] ?? '') : '');

  // topPick = the explicit top-level tab ('' | a provider id | a group pill id);
  // groupPick = the explicit sub-provider within whichever pill is active. Both
  // default via the current model.
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

  // Which TARGET the next pick applies to: this chat's own model, or the
  // per-chat SUB-AGENT override — every sub-agent this chat spawns then runs on
  // it, ahead of the flock binding and the agent definition's own pin. Reset on
  // every open (below), because a sticky target would silently send a later
  // pick somewhere the user is no longer looking.
  let forSubagents = $state(false);
  let pickType = $derived(forSubagents ? 'setSubagentModel' : 'setModel');

  // The LM Studio model awaiting a context-length choice ('' = none).
  let ctxPromptFor = $state('');
  // The sub-agent-target model awaiting its (optional) context-length choice.
  let subagentCtxFor = $state('');

  // In grid mode every cell mounts its own picker, so the listener lives in
  // onMount with a cleanup — otherwise closed cells leak dead listeners.
  onMount(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data || {};
      if (msg.type === 'modelOptions') modelOptions = Array.isArray(msg.options) ? msg.options : [];
      else if (msg.type === 'providerStatus') { providerStatus = Array.isArray(msg.providers) ? msg.providers : []; providerStatusReceived = true; }
      else if (msg.type === 'openRouterModels') openRouterModels = Array.isArray(msg.models) ? msg.models : [];
      else if (msg.type === 'sessionModels') modelBySession = (msg.models && typeof msg.models === 'object') ? msg.models : {};
      else if (msg.type === 'modelStatus') {
        // Statuses are per-session now (one per chat per tick) — only THIS chat's
        // may seed the picker. Untagged = legacy/boot broadcast, accept.
        if (msg.sessionId != null && msg.sessionId !== sessionId) return;
        // The LOCAL server's OWN loaded window, NOT this session's contextWindow —
        // on a remote/cloud chat that one is the REMOTE model's 131k+, which both
        // misreports "currently loaded" and blows VRAM as an `lms load -c` size.
        if (typeof msg.loadedContextLength === 'number' && msg.loadedContextLength > 0) loadedCtx = msg.loadedContextLength;
        if (typeof msg.loadedModelId === 'string') loadedModelId = msg.loadedModelId;
      }
      else if (msg.type === 'providerAuthData') oauthConnected = (msg.connected && typeof msg.connected === 'object') ? msg.connected : {};
      else if (msg.type === 'providerUsageCapable') usageCapable = Array.isArray(msg.ids) ? (msg.ids as unknown[]).map(String) : [];
      else if (msg.type === 'providerUsageData' && typeof msg.providerId === 'string' && Array.isArray(msg.lines)) {
        usageLines = { ...usageLines, [msg.providerId]: (msg.lines as unknown[]).map(String) };
      }
      // Turn-end refresh: usage moves once per reply, not on a timer.
      else if (msg.type === 'turnDone' && msg.sessionId === sessionId) requestUsage();
    };
    window.addEventListener('message', onMsg);
    // Seed on mount (covers a picker that mounted after the first broadcast).
    vscode.postMessage({ type: 'requestSessionModels' });
    vscode.postMessage({ type: 'providerAuthRequest' });
    vscode.postMessage({ type: 'providerUsageCapableRequest' });
    return () => window.removeEventListener('message', onMsg);
  });

  // Lazy usage pull for the active model's own provider — only when that
  // provider has a usage source at all, so a metered provider never fires a
  // request the engine would have to refuse. Model-bar open + turn end, no timer.
  function requestUsage() {
    if (canReadUsage) {
      vscode.postMessage({ type: 'providerUsageRequest', providerId: currentProviderId });
    }
  }

  function openMenu() {
    open = !open;
    if (!open) return;
    filter = '';
    ctxPromptFor = '';
    subagentCtxFor = '';
    forSubagents = false;
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
    // The sub-agent target always asks for an (optional) context override —
    // see the top-of-file note: it never loads/ejects, so the LM Studio load
    // prompt below is not the one it opens.
    if (forSubagents) { subagentCtxFor = value; return; }
    if (isLmsManaged(selectedProvider)) {
      // LM Studio (loopback): ask for a context length before loading — INCLUDING
      // the model already held, which used to short-circuit to a bare re-pick that
      // hid its window. Keeping that window still costs no reload (host-side skip).
      ctxPromptFor = value;
      return;
    }
    // Cloud (OpenRouter / …): switch live, per-chat, no context prompt.
    vscode.postMessage({ type: pickType, modelId: value, sessionId });
    open = false;
  }

  function confirmCtx(value: number | undefined) {
    vscode.postMessage({ type: 'setModel', modelId: ctxPromptFor, sessionId, contextLength: value });
    ctxPromptFor = '';
    open = false;
  }

  function confirmSubagentCtx(value: number | undefined) {
    vscode.postMessage({ type: 'setSubagentModel', modelId: subagentCtxFor, sessionId, contextLength: value });
    subagentCtxFor = '';
    open = false;
  }

  function eject() {
    vscode.postMessage({ type: 'modelPanel.unload' });
    open = false;
  }
</script>

<span class="mp">
  <button class="mp-trigger" class:placeholder={!current} onclick={openMenu} title={current ? `${current} — click to switch model (this chat)` : 'Select a model for this chat'}>
    <span class="mp-name">{triggerLabel}</span>
    <span class="mp-caret" aria-hidden="true">&#9662;</span>
  </button>
  {#if usageText}
    <span class="mp-usage" title={usageText}>{usageText}</span>
  {/if}

  {#if open}
    <button class="mp-backdrop" aria-label="Close model picker" onclick={() => (open = false)}></button>
    <div class="mp-menu" role="dialog" aria-label="Select model">
      <!-- Tier 0: WHO the next pick is for. Sub-agents are the fan-out's cost
           centre — ten children on the chat's own frontier model is ten times
           the bill — so choosing a cheaper model for them is a first-class
           choice here, not a config file edit. -->
      <div class="mp-target" role="group" aria-label="Apply the model to">
        <button class="mp-target-btn" class:active={!forSubagents} onclick={() => (forSubagents = false)} title="Pick the model for THIS chat">This chat</button>
        <button class="mp-target-btn" class:active={forSubagents} onclick={() => (forSubagents = true)} title="Pick the model every sub-agent this chat spawns runs on">Sub-agents</button>
      </div>
      <!-- Tier 1: provider — one tab per section (Local/Hosted/Providers/Labs/
           Other); a lone provider is its own tab, 2+ collapse into that
           section's pill. -->
      <div class="mp-providers" role="tablist" aria-label="Provider">
        {#each grouping.tabs as tab (tab.id)}
          <button
            class="mp-provider"
            class:active={topSelection === tab.id}
            class:live={tab.live}
            role="tab"
            aria-selected={topSelection === tab.id}
            onclick={() => pickTop(tab.id)}
            title={tab.collapsed ? `${tab.name} (${tab.members.length})` : (tab.live ? `${tab.name} — Live` : `${tab.name} — Idle`)}
          >
            <span class="mp-dot" aria-hidden="true"></span>{tab.name}
          </button>
        {/each}
        {#if grouping.tabs.length === 0}
          <!-- Text only. The picker SELECTS a model; establishing a connection
               is the sidebar's job (see ControlStrip.svelte's own header), so
               this points there instead of writing config from here. -->
          <span class="mp-empty">{providerStatusReceived ? 'No providers configured — add one in the Origami sidebar (＋ Add provider).' : 'Loading models…'}</span>
        {/if}
      </div>

      {#if activeTab?.collapsed}
        <!-- Tier 1b: which provider within the active pill's sub-select -->
        <div class="mp-group-subs" role="tablist" aria-label="{activeTab.name} provider">
          {#each activeTab.members as p (p.id)}
            <button
              class="mp-provider mp-group-sub"
              class:active={selectedGroupProvider === p.id}
              class:live={p.live}
              role="tab"
              aria-selected={selectedGroupProvider === p.id}
              onclick={() => pickGroup(p.id)}
              title={p.live ? `${p.name} — Live` : `${p.name} — Idle`}
            >
              <span class="mp-dot" aria-hidden="true"></span>{p.name}
            </button>
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
            {:else}
              {@const lbl = parseModelId(mo.value, mo.name)}
              <button
                class="mp-model"
                class:current={mo.value === current}
                role="option"
                aria-selected={mo.value === current}
                onclick={() => selectModel(mo.value)}
                title={mo.value}
              >
                <span class="mp-check" aria-hidden="true">{mo.value === current ? '✓' : ''}</span>
                <span class="mp-model-label">
                  {#if lbl.provider}<span class="mp-model-provider">{lbl.provider}</span>{/if}
                  <span class="mp-model-name">{lbl.name}</span>
                </span>
                {#if mo.value === loadedValue}<span class="mp-model-loaded" title="Already loaded on the server — picking it shows the window it is loaded at; keeping that window costs no reload">current</span>{/if}
                {#if lbl.quant}<span class="mp-model-quant">{lbl.quant}</span>{/if}
              </button>
            {/if}
          {:else}
            <div class="mp-empty">
              {#if filter.trim()}No models match your filter.
              {:else if selectedProvider === 'openrouter'}No models — check the API key in Settings.
              {:else}No models — load one in LM Studio.{/if}
            </div>
          {/each}
        </div>
        {#if visible.length > MODEL_CAP}
          <span class="mp-hint">Showing {MODEL_CAP} of {visible.length} — filter to narrow.</span>
        {/if}

        {#if isLmsManaged(selectedProvider)}
          <button class="mp-eject" onclick={eject} title="Unload the loaded model from LM Studio (frees VRAM)">⏏ Eject loaded model</button>
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

  .mp-target { display: flex; gap: 4px; margin-bottom: 5px; }
  .mp-target-btn { flex: 1 1 0; padding: 2px 4px; font-size: 10px; font-family: inherit; color: var(--og-text-secondary); background: var(--og-btn-bg); border: 1px solid var(--og-border); border-radius: 4px; cursor: pointer; }
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
  .mp-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 41;
    width: 560px; /* 300px wrapped a 90-char self-quantised GGUF id over 8 lines */
    max-width: min(84vw, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
  }

  .mp-providers { display: flex; flex-wrap: wrap; gap: 4px; }
  .mp-provider {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .mp-provider:hover { border-color: var(--og-chat); color: var(--og-text); }
  .mp-provider.active { border-color: var(--og-chat); color: var(--og-text); background: color-mix(in srgb, var(--og-chat) 12%, transparent); }
  .mp-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--og-text-muted); }
  .mp-provider.live .mp-dot { background: var(--og-success); box-shadow: 0 0 5px var(--og-success); }

  /* Tier-1b sub-select: the active pill's own providers, set off from the
     top-level tabs by an indent + rule so it reads as a second level. */
  .mp-group-subs { display: flex; flex-wrap: wrap; gap: 4px; padding-left: 8px; border-left: 2px solid var(--og-border); }
  .mp-group-sub { font-weight: 500; }

  .mp-filter {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 11px;
    font-family: inherit;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 5px;
    outline: none;
  }
  .mp-filter:focus { border-color: var(--og-chat); }

  .mp-models {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 240px;
    overflow-y: auto;
  }
  .mp-model {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    font-size: 12px;
    text-align: left;
    background: transparent;
    color: var(--og-text-secondary);
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .mp-model:hover { background: var(--og-btn-bg); color: var(--og-text); }
  .mp-model.current { border-color: var(--og-chat); color: var(--og-text); }
  .mp-check { width: 11px; flex-shrink: 0; color: var(--og-chat); }
  /* Tweak 4 — structured label: muted provider subtitle over a strong name,
     with a quant chip pinned to the right when the id actually carries one. */
  .mp-model-label {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .mp-model-provider {
    font-size: 9.5px;
    letter-spacing: 0.02em;
    color: var(--og-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mp-model-name {
    font-weight: 600;
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
  }
  .mp-model-loaded { /* already held by the server; picking it costs no reload */ flex: 0 0 auto; align-self: center; font-size: 9px; padding: 1px 5px; border-radius: 3px; color: var(--og-success); border: 1px solid color-mix(in srgb, var(--og-success) 40%, transparent); }
  .mp-model-quant {
    flex: 0 0 auto;
    align-self: center;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px;
    letter-spacing: 0.03em;
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--og-chat);
    background: color-mix(in srgb, var(--og-chat) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--og-chat) 40%, transparent);
  }

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
