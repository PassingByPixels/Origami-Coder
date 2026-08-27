<script lang="ts">
  // CONNECTION SETTINGS — the sidebar's job is now ONLY establishing provider
  // connections, never model selection. (Model + context selection live in the
  // chat pane's model bar; see ChatPane / InputBar.)
  //
  // The surface is a compact grid of traffic-light squares (LM Studio /
  // OpenRouter / …), one per configured provider — green once the host's
  // probe confirms it live, red/yellow otherwise (see providerGrid.ts). Click
  // a square to open its settings fold:
  //   - LM Studio (local): Engine endpoint · View models (read-only) · Rep penalty
  //   - OpenRouter / cloud: Re-key · (base URL + models are handled)
  //   - all: Remove
  // With no providers configured, the strip is just a "+ Add provider" affordance
  // (LM Studio is the default; its setup is endpoint-only — the model is picked in
  // the chat pane, not here).
  //
  // Every control sends the EXACT message the DashboardPanel handler already
  // actions — no new wire, no fake status:
  //   - add / re-key   → { type: 'setupProvider', … }   (host validates + writes)
  //   - remove         → { type: 'removeProvider', providerId }
  //   - engine endpoint→ { type: 'setEngineUrl', url }   (persists + respawns acp)
  //   - rep penalty    → { type: 'setFrequencyPenalty', value }  (global engine setting)
  //   - status probe   → { type: 'requestProviderStatus' } → `providerStatus`
  //   - view models    → { type: 'requestModels' } → `modelOptions` (read-only list)

  import { getVsCodeApi } from '../shared/vscodeApi';
  import { useGrid, lightOf, gridLabel } from './providerGrid';
  import { classifySection, SECTION_ORDER, SECTION_LABEL, type ConnectionSection } from './connectionSection';
  const vscode = getVsCodeApi();

  // Per-provider status — one pill per CONFIGURED provider, driven solely by the
  // host's `providerStatus` probe (LM Studio reachable / OpenRouter key valid /
  // cloud key present). Green + "Live" when reachable, else grey + "Idle".
  // `kind`/`baseURL`/`primary` are host-supplied per configured provider: kind is
  // inferred from the stored block (so a renamed / 2nd local still renders the
  // right fold), baseURL is shown per-pill, and primary marks the one local that
  // drives the global engine URL (only its pill edits that URL).
  let providerStatus = $state<Array<{ id: string; name: string; live: boolean; reason?: string; kind?: 'local' | 'compat' | 'cloud'; baseURL?: string; primary?: boolean }>>([]);
  // Draft for the in-fold "Pill name" rename input; seeded when a fold opens.
  let renameDraft = $state('');
  // Which pill's settings fold is open ('' = none).
  let openSettingsFor = $state('');

  // The configured models (from the ACP configOptions + live LM Studio poll,
  // broadcast as `modelOptions`). Used ONLY for the read-only "View models" list
  // in a provider's settings fold — selection happens in the chat pane.
  let modelOptions = $state<Array<{ value: string; name: string; configured?: boolean }>>([]);
  // OpenRouter's live catalog (fetched on demand when its fold opens), for the
  // read-only "view models" list. Read-only here — picking happens in the chat pane.
  let openRouterModels = $state<Array<{ id: string; name: string; free?: boolean }>>([]);
  // Filter text for the currently-open fold's model list (reset on each open).
  let modelFilter = $state('');

  // Monthly OpenRouter spend + cap (USD). Driven by the host's spendUpdate /
  // budgetUpdate broadcasts; the cap is set from the OpenRouter fold.
  let monthSpend = $state(0);
  let monthBudget = $state<number | null>(null);
  let budgetInput = $state<number | ''>('');
  function fmtUsd(n: number): string { return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`; }
  let budgetPct = $derived(monthBudget && monthBudget > 0 ? Math.round((monthSpend / monthBudget) * 100) : 0);

  // ENGINE ENDPOINT — the endpoint origami-acp is spawned against (resolved
  // setting → env → default), seeded from `modelStatus.engineUrl`. Shown under the
  // LM Studio pill; saving posts `setEngineUrl` (persists + respawns origami-acp).
  let engineUrl = $state('');
  let engineInput = $state('');

  // REP — repetition (frequency) penalty, a GLOBAL engine setting written to
  // origami.json (agent.build.frequency_penalty). Off (0) by default; blank and 0
  // both mean off. The engine re-reads it per request, so a change applies live on
  // the next message. Shown under the LM Studio pill's settings fold.
  let repInput = $state<number | ''>('');

  // PROVIDER SETUP — the add/re-key form. Pick a provider and only that provider's
  // fields show:
  //   local  (LM Studio)                    → Base URL only (localAuto: model auto-picked)
  //   compat OpenRouter                     → API key only (keyOnly: URL fixed, model auto)
  //   compat (other OpenAI-compatible)      → Base URL + API key + Model id
  //   cloud  (OpenAI / xAI / Anthropic)     → API key + Model id (URL/catalog baked)
  // Connect posts `setupProvider`; the host validates, writes the GLOBAL
  // origami.json, and lights the pill.
  //   oauth  (OpenAI OAuth / Grok OAuth)  → no fields at all: pick a sign-in
  //          method, the host opens your browser, the engine holds the flow.
  import { SETUP_PROVIDERS, type ProviderKind, type SetupProvider } from './setupCatalog';
  import { setupProviderPayload, oauthEntryFor, reKeyTemplate } from './providerIdentity';
  // The add/re-key picker is a collapsible accordion (a native <optgroup>
  // can't collapse), grouped by CONNECTION SECTION — Local/Self Hosted /
  // Providers / Labs / Other (t-kgt7wh) — not by form-shape `kind`.
  // classifySection (connectionSection.ts) is the single source of truth,
  // driven off each template's real id/baseURL so it never drifts from how a
  // live configured provider gets classified too.
  //
  // Local and Hosted USED to be two sections here, splitting LM Studio from a
  // tailnet vLLM on loopback-vs-LAN. They are now one — see connectionSection.ts
  // for why. Local/Self Hosted is open by default; the rest start collapsed to
  // keep the list short.
  //
  // An OAuth entry buckets by the provider it signs into, so "OpenAI (OAuth)"
  // sits under Labs next to "OpenAI" instead of falling to Other on its
  // catalog-only `-oauth` id.
  function sectionOf(p: SetupProvider): ConnectionSection {
    return classifySection({ id: p.authProvider ?? p.id, baseURL: p.baseURL });
  }
  const setupBySection: Record<ConnectionSection, SetupProvider[]> = { selfhosted: [], providers: [], labs: [], other: [] };
  for (const p of SETUP_PROVIDERS) setupBySection[sectionOf(p)].push(p);
  let sectionOpen = $state<Record<ConnectionSection, boolean>>({ selfhosted: true, providers: false, labs: false, other: false });
  function toggleSection(s: ConnectionSection) {
    sectionOpen = { ...sectionOpen, [s]: !sectionOpen[s] };
  }
  let providerSetupOpen = $state(false);
  // The EXACT existing provider id a Re-key opened for ('' = a plain Add).
  // Connect writes back to THIS id instead of minting a fresh one — a 2nd
  // local instance's id ('vllm-2') isn't a catalog id (see openReKey).
  let reKeyProviderId = $state('');
  let setupProviderId = $state('lmstudio');
  let setupName = $state('');
  let setupBaseURL = $state('');
  let setupApiKey = $state('');
  let setupModelId = $state('');
  // The live model list for a keylessCatalog preset, filled by the host's
  // `presetModels` reply. Empty until it lands (or forever, if the gateway is
  // unreachable) — the preset's default model still submits either way, so a
  // dead network degrades the picker instead of blocking setup.
  let presetModels = $state<string[]>([]);

  // OAUTH SIGN-IN state, all host-driven (providerAuthData / Pending / Done /
  // Failed). `methods` is per ENGINE provider id and already filtered to the
  // OAuth ones — the plugins' "Manually enter API Key" entry is deliberately
  // absent, because the API-key catalog entries above already cover it.
  // `connected` holds only oauth credentials, so an api key stored for the
  // same provider never lights this pill.
  let oauthMethods = $state<Record<string, Array<{ index: number; label: string }>>>({});
  let oauthConnected = $state<Record<string, { type: string; expires?: number }>>({});
  let oauthError = $state('');
  type OauthState =
    | { phase: 'idle' }
    | { phase: 'waiting'; providerId: string; methodIndex: number; url: string; instructions: string; needsCode: boolean }
    | { phase: 'failed'; providerId: string; message: string }
    | { phase: 'done'; providerId: string; model: string };
  let oauthState = $state<OauthState>({ phase: 'idle' });
  // SUBSCRIPTION USAGE, asked LAZILY — once per provider, when its fold opens on
  // a connection that is already signed in. Never on a timer: OpenAI's own CLI
  // polls this endpoint every 60s and openai/codex#10869 is the bug report about
  // it. Lines arrive pre-formatted from the host (see src/dashboard/providerUsage.ts).
  let oauthUsage = $state<Record<string, string[]>>({});
  let usageAsked = $state<Record<string, boolean>>({});
  let oauthCode = $state('');

  function renamePill(id: string) {
    const name = renameDraft.trim();
    if (!name) return;
    vscode.postMessage({ type: 'renameProvider', providerId: id, name });
  }

  let setupProvider = $derived(SETUP_PROVIDERS.find(p => p.id === setupProviderId) ?? SETUP_PROVIDERS[0]);
  // What the keyless-catalog picker offers: the live list once it arrives, else
  // just the preset's own default so the control is never an empty dropdown.
  let presetModelOptions = $derived(
    presetModels.length > 0 ? presetModels : [setupProvider.model].filter(Boolean),
  );
  // localAuto (LM Studio) needs ONLY the base URL; keyOnly (OpenRouter) needs ONLY
  // the API key. Otherwise: URL + model, and a KEY only for `cloud` — an "Other"
  // compat endpoint is often UNAUTHENTICATED (SGLang), so a blank key saves and the
  // block omits it. oauth has no Connect button, so it never satisfies this gate.
  let canSubmitSetup = $derived(
    setupProvider.kind === 'oauth'
      ? false
      : setupProvider.localAuto
        ? !!setupBaseURL.trim()
        : setupProvider.keyOnly
          ? !!setupApiKey.trim()
          : (!!setupModelId.trim()
            && (setupProvider.kind === 'cloud' || !!setupBaseURL.trim())
            && (setupProvider.kind !== 'cloud' || !!setupApiKey.trim())),
  );

  /** The engine provider id the open oauth form signs into ('' when the open
   *  form is not an oauth one). */
  let oauthTarget = $derived(setupProvider.kind === 'oauth' ? (setupProvider.authProvider ?? '') : '');
  let oauthTargetMethods = $derived(oauthTarget ? (oauthMethods[oauthTarget] ?? []) : []);

  // An EFFECT, not a call in the markup: asking mutates state, and Svelte 5
  // treats a state write during render as an error (state_unsafe_mutation).
  $effect(() => {
    const target = oauthTarget;
    if (!providerSetupOpen || !target || !oauthConnected[target] || usageAsked[target]) return;
    usageAsked = { ...usageAsked, [target]: true };
    vscode.postMessage({ type: 'providerUsageRequest', providerId: target });
  });

  function startOauth(methodIndex: number) {
    if (!oauthTarget) return;
    oauthCode = '';
    oauthState = { phase: 'waiting', providerId: oauthTarget, methodIndex, url: '', instructions: '', needsCode: false };
    vscode.postMessage({ type: 'providerAuthStart', providerId: oauthTarget, methodIndex });
  }
  function submitOauthCode() {
    if (oauthState.phase !== 'waiting' || !oauthCode.trim()) return;
    vscode.postMessage({
      type: 'providerAuthSubmitCode',
      providerId: oauthState.providerId,
      methodIndex: oauthState.methodIndex,
      code: oauthCode.trim(),
    });
  }

  // Resolve a configured provider's kind from the setup catalog (for the settings
  // fold). An unknown id (a custom provider) is treated as compat.
  function providerKind(id: string): ProviderKind {
    return SETUP_PROVIDERS.find(p => p.id === id)?.kind ?? 'compat';
  }
  // Prefer the host's inferred kind (covers custom-id / renamed / 2nd-local
  // pills); fall back to the template catalog for anything not yet in status.
  function kindOf(id: string): ProviderKind {
    return providerStatus.find(p => p.id === id)?.kind ?? providerKind(id);
  }
  // The models this provider contributes, for the read-only "View models" list.
  function modelsForProvider(id: string): Array<{ value: string; name: string }> {
    return modelOptions.filter(o => o.value.startsWith(id + '/'));
  }

  // The (filtered) read-only model list for whichever fold is open. LM Studio pulls
  // from `modelOptions`; OpenRouter from its fetched catalog. Only one fold is open
  // at a time, so this derives off `openSettingsFor`.
  let visibleModels = $derived.by(() => {
    const id = openSettingsFor;
    if (!id) return [] as Array<{ value: string; name: string }>;
    let list: Array<{ value: string; name: string }>;
    if (kindOf(id) === 'local') {
      list = modelsForProvider(id);
    } else if (id === 'openrouter') {
      list = openRouterModels.map(mm => ({ value: `${id}/${mm.id}`, name: mm.name || mm.id }));
    } else {
      list = [];
    }
    const q = modelFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(mm => mm.name.toLowerCase().includes(q) || mm.value.toLowerCase().includes(q));
  });
  // Cap how many rows the read-only "view models" list renders — OpenRouter's
  // catalog is ~343, and a full DOM wall is both unreadable and slow. The filter
  // box is the browse tool; a footer notes how many are hidden.
  const MODEL_LIST_CAP = 60;

  // Refresh the open fold's list: re-probe LM Studio, or re-fetch the OpenRouter
  // catalog.
  function refreshModels() {
    if (openSettingsFor === 'openrouter') {
      vscode.postMessage({ type: 'requestOpenRouterModels', providerId: 'openrouter' });
    } else {
      vscode.postMessage({ type: 'modelPanel.refresh' });
      vscode.postMessage({ type: 'requestModels' });
    }
  }

  function applyProviderDefaults(id: string) {
    // Picking a catalog entry is always an ADD — never leave a stale re-key target armed.
    reKeyProviderId = '';
    const p = SETUP_PROVIDERS.find(x => x.id === id) ?? SETUP_PROVIDERS[0];
    setupProviderId = p.id;
    setupName = p.name;
    setupBaseURL = p.baseURL ?? '';
    setupApiKey = '';
    setupModelId = p.model;
    // Ask the gateway what it actually serves. Zen answers GET /models with no
    // key at all, so the picker can show real ids before anything is pasted —
    // far better than a hardcoded default nobody can check. This is USER-INITIATED
    // setup (they opened Add provider and clicked this preset), not a phone-home:
    // no timer, no activation hook, no chat path reaches it.
    presetModels = [];
    if (p.keylessCatalog && p.baseURL) {
      vscode.postMessage({ type: 'requestPresetModels', providerId: p.id, baseURL: p.baseURL });
    }
    // Reveal the accordion section the selection lives in, so an active pick —
    // incl. a "Re-key…" of a Providers/Labs entry — is always visible. The
    // other sections still start collapsed on a fresh open, where the default
    // is Local.
    sectionOpen = { ...sectionOpen, [sectionOf(p)]: true };
    // An OAuth entry needs the engine's method list before it can offer a
    // button, and the connected map before it can say "signed in".
    if (p.kind === 'oauth') {
      oauthState = { phase: 'idle' };
      vscode.postMessage({ type: 'providerAuthRequest' });
    }
  }
  function openProviderSetup(id = 'lmstudio') {
    openSettingsFor = '';
    providerSetupOpen = true;
    applyProviderDefaults(id);
  }
  /** Re-key an EXISTING provider — the add/re-key form, seeded from the LIVE
   *  pill, not a fresh-add's catalog defaults: setupBaseURL takes pv.baseURL,
   *  so an unchanged submit is a no-op for the endpoint (not a reset to the
   *  template's install default) and still satisfies setupProvider.ts's
   *  self-hosted auto-pick path, which needs a truthy URL. */
  function openReKey(pv: { id: string; name: string; baseURL?: string }) {
    openSettingsFor = '';
    providerSetupOpen = true;
    reKeyProviderId = pv.id;
    setupProviderId = reKeyTemplate(pv.id).id;
    setupName = pv.name;
    setupBaseURL = pv.baseURL ?? '';
    setupApiKey = '';
    setupModelId = '';
    presetModels = [];
    sectionOpen = { ...sectionOpen, [classifySection({ id: pv.id, baseURL: pv.baseURL })]: true };
  }
  function submitProviderSetup() {
    if (!canSubmitSetup) return;
    // Every id / key / model rule lives in setupProviderPayload — a pure leaf,
    // testable with no DOM, and this file is AT its architecture cap.
    vscode.postMessage({
      type: 'setupProvider',
      ...setupProviderPayload({
        template: setupProvider,
        name: setupName.trim() || setupProvider.name,
        reKeyProviderId,
        existingIds: providerStatus.map(x => x.id),
        baseURL: setupBaseURL,
        apiKey: setupApiKey,
        modelId: setupModelId,
      }),
    });
    providerSetupOpen = false;
    reKeyProviderId = '';
    // Re-probe so the just-connected provider's pill flips to "Live".
    vscode.postMessage({ type: 'requestProviderStatus' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'modelStatus') {
      if (typeof msg.engineUrl === 'string' && msg.engineUrl) {
        engineUrl = msg.engineUrl;
        // Seed the editor only while this pill's fold is closed so a live
        // broadcast doesn't clobber what the user is typing.
        if (openSettingsFor === '') engineInput = msg.engineUrl;
      }
    }
    if (msg.type === 'modelOptions') {
      modelOptions = Array.isArray(msg.options) ? msg.options : [];
    }
    if (msg.type === 'providerStatus') {
      providerStatus = Array.isArray(msg.providers) ? msg.providers : [];
    }
    if (msg.type === 'openRouterModels') {
      openRouterModels = Array.isArray(msg.models) ? msg.models : [];
    }
    if (msg.type === 'presetModels') {
      // Only for the preset currently selected — a late reply for a preset the
      // user has since clicked away from must not repopulate the form.
      if (msg.providerId === setupProviderId) {
        presetModels = Array.isArray(msg.models) ? msg.models.map((x: unknown) => String(x)) : [];
        // Keep the bound value inside the offered set, or the <select> renders
        // blank and Connect writes an id the gateway just said it does not serve.
        if (presetModels.length > 0 && !presetModels.includes(setupModelId)) {
          setupModelId = typeof msg.defaultModel === 'string' && presetModels.includes(msg.defaultModel)
            ? msg.defaultModel
            : presetModels[0];
        }
      }
    }
    if (msg.type === 'spendUpdate') {
      if (typeof msg.total === 'number') monthSpend = msg.total;
    }
    if (msg.type === 'budgetUpdate') {
      monthBudget = typeof msg.monthly === 'number' ? msg.monthly : null;
      // Seed the editor only while the OpenRouter fold is closed, so a live
      // re-broadcast doesn't clobber what the user is typing.
      if (openSettingsFor !== 'openrouter') budgetInput = monthBudget ?? '';
    }
    if (msg.type === 'providerAuthData') {
      oauthMethods = (msg.methods && typeof msg.methods === 'object') ? msg.methods : {};
      oauthConnected = (msg.connected && typeof msg.connected === 'object') ? msg.connected : {};
      oauthError = typeof msg.error === 'string' ? msg.error : '';
    }
    // An `unavailable` answer carries no `lines`, so the row below simply never
    // renders — a fold that cannot report usage shows nothing rather than an
    // apology the user can do nothing about.
    if (msg.type === 'providerUsageData' && typeof msg.providerId === 'string' && Array.isArray(msg.lines)) {
      oauthUsage = { ...oauthUsage, [msg.providerId]: (msg.lines as unknown[]).map(String) };
    }
    if (msg.type === 'providerAuthPending' && oauthState.phase === 'waiting' && msg.providerId === oauthState.providerId) {
      oauthState = {
        ...oauthState,
        url: typeof msg.url === 'string' ? msg.url : '',
        instructions: typeof msg.instructions === 'string' ? msg.instructions : '',
        needsCode: msg.method === 'code',
      };
    }
    if (msg.type === 'providerAuthFailed') {
      oauthState = { phase: 'failed', providerId: String(msg.providerId ?? ''), message: String(msg.message ?? 'Sign-in failed.') };
    }
    if (msg.type === 'providerAuthDone') {
      oauthState = { phase: 'done', providerId: String(msg.providerId ?? ''), model: String(msg.model ?? '') };
      // The provider block only just landed, so re-probe: without this the new
      // pill does not exist in `providerStatus` until the next 20s sweep.
      vscode.postMessage({ type: 'requestProviderStatus' });
    }
    if (msg.type === 'frequencyPenaltyConfig') {
      // Seed only while the fold is closed so a live re-broadcast doesn't clobber
      // what the user is typing. null = using the model default -> blank input.
      if (openSettingsFor === '') repInput = typeof msg.value === 'number' ? msg.value : '';
    }
  });

  // On mount: probe provider status, pull the model list (for View models), and
  // seed the rep penalty — covers a webview that mounted after the first broadcast.
  vscode.postMessage({ type: 'requestProviderStatus' });
  vscode.postMessage({ type: 'requestModels' });
  vscode.postMessage({ type: 'requestFrequencyPenalty' });
  vscode.postMessage({ type: 'requestSpend' });
  // The OAuth credential store is the ONLY truth for an OAuth pill: those
  // blocks carry no apiKey, so the host's key-presence probe calls them "not
  // configured" and would paint them red.
  vscode.postMessage({ type: 'providerAuthRequest' });

  // The rendered grid: the host's probe, with the engine's credential store
  // overriding it for OAuth-connected providers.
  let gridProviders = $derived(providerStatus.map(p => ({ ...p, oauth: !!oauthConnected[p.id] })));

  // Open / close a provider's settings fold. Seed the endpoint + rep inputs from
  // the live values each time it opens.
  function toggleSettings(id: string) {
    if (openSettingsFor === id) { openSettingsFor = ''; return; }
    openSettingsFor = id;
    modelFilter = '';
    engineInput = engineUrl;
    // Seed the rename box from this pill's current name.
    renameDraft = providerStatus.find(p => p.id === id)?.name ?? '';
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestFrequencyPenalty' });
    // OpenRouter's list is a live fetch — pull its catalog when the fold opens,
    // plus the current spend + cap for the budget control.
    if (id === 'openrouter') {
      vscode.postMessage({ type: 'requestOpenRouterModels', providerId: 'openrouter' });
      vscode.postMessage({ type: 'requestSpend' });
      budgetInput = monthBudget ?? '';
    }
  }

  function saveBudget() {
    // Blank clears the cap; else the host clamps (>0 or null).
    vscode.postMessage({ type: 'setBudget', monthly: budgetInput === '' ? null : budgetInput });
  }

  function saveEngineUrl() {
    const url = engineInput.trim();
    if (!url) return;
    vscode.postMessage({ type: 'setEngineUrl', url });
  }
  function onEngineKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); saveEngineUrl(); }
  }

  function applyRep() {
    // Blank = clear -> model default; 0 = off; else the host clamps to 0..2.
    vscode.postMessage({ type: 'setFrequencyPenalty', value: repInput === '' ? null : repInput });
  }

  function removeProvider(id: string) {
    openSettingsFor = '';
    vscode.postMessage({ type: 'removeProvider', providerId: id });
  }

  /** Cancel/Close — also drop a pending re-key target so a later Add doesn't inherit it. */
  function closeProviderSetup() {
    providerSetupOpen = false;
    reKeyProviderId = '';
  }
</script>

<div class="control-strip">
  <!-- PROVIDER SURFACE: one traffic-light square per configured provider —
       colour + initials, grey-toned "Idle" until the host's probe confirms it,
       then green "Live" (see providerGrid.ts). The grid IS the layout, from
       the first configured provider on; there is no pill phase. Click opens
       the settings fold via toggleSettings. -->
  {#if providerStatus.length > 0}
    {#if useGrid(providerStatus.length)}
      <div class="provider-grid" role="list" aria-label="Providers">
        {#each gridProviders as pv (pv.id)}
          <button
            class="grid-square"
            class:light-green={lightOf(pv) === 'green'}
            class:light-red={lightOf(pv) === 'red'}
            class:light-yellow={lightOf(pv) === 'yellow'}
            class:open={openSettingsFor === pv.id}
            title={gridLabel(pv)}
            aria-label={gridLabel(pv)}
            onclick={() => toggleSettings(pv.id)}
          >{pv.name.slice(0, 2).toUpperCase()}</button>
        {/each}
      </div>
    {/if}
    <button class="add-provider small" onclick={() => openProviderSetup()} title="Add another provider (OpenRouter / OpenAI / xAI / Anthropic / a 2nd local)">＋ Add</button>
  {:else}
    <!-- Empty state: no providers yet. LM Studio is the default; its setup is
         endpoint-only (the model is chosen in the chat pane). -->
    <button class="add-provider" onclick={() => openProviderSetup()} title="Connect a provider — LM Studio (local) is the default">
      ＋ Add provider
    </button>
  {/if}
</div>

{#snippet modelListBlock()}
  <!-- Read-only "view models" list for the open fold (LM Studio / OpenRouter),
       with a filter search + its own scroll so a long catalog stays contained. -->
  <div class="fold-label with-action">
    <span>Models{visibleModels.length ? ` (${visibleModels.length})` : ''}</span>
    <button class="fold-linkbtn" onclick={refreshModels} title="Refresh the list">Refresh</button>
  </div>
  <!-- Only worth a filter box when the list is long (OpenRouter's ~343, a big LM
       Studio library) — a single-model server (e.g. a remote vLLM) doesn't need it. -->
  {#if visibleModels.length > 8}
    <input
      class="fold-input"
      type="text"
      bind:value={modelFilter}
      placeholder="Filter models…"
      spellcheck="false"
      autocomplete="off"
      aria-label="Filter models"
    />
  {/if}
  <div class="model-list" role="list" aria-label="Available models">
    {#each visibleModels.slice(0, MODEL_LIST_CAP) as mo (mo.value)}
      <div class="model-list-item" role="listitem" title={mo.value}>{mo.name}</div>
    {:else}
      <div class="model-list-empty">
        {#if modelFilter.trim()}No models match your filter.
        {:else if openSettingsFor === 'openrouter'}No models — check the API key (Re-key), then Refresh.
        {:else}No models — load one in LM Studio, then Refresh.{/if}
      </div>
    {/each}
  </div>
  {#if visibleModels.length > MODEL_LIST_CAP}
    <span class="fold-hint">Showing {MODEL_LIST_CAP} of {visibleModels.length} — type above to filter.</span>
  {/if}
  <span class="fold-hint">Read-only — pick the active model in the chat pane.</span>
{/snippet}

{#each providerStatus as pv (pv.id)}
  {#if openSettingsFor === pv.id}
    {@const kind = pv.kind ?? providerKind(pv.id)}
    {@const signedIn = !!oauthConnected[pv.id]}
    <!-- Provider settings fold — connection settings only. -->
    <div class="settings-fold">
      <div class="settings-head">
        <span class="settings-title">{pv.name}</span>
        <span class="settings-status" class:live={pv.live || signedIn}>{signedIn ? 'Signed in' : pv.live ? 'Live' : 'Idle'}</span>
      </div>

      <!-- Pill name (the instance label) — separate from the provider type. Rename
           changes only the label; the id (routing) is untouched, no reload needed. -->
      <label class="fold-label" for="rename-input">Pill name</label>
      <div class="fold-row">
        <input
          id="rename-input"
          class="fold-input"
          type="text"
          bind:value={renameDraft}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); renamePill(pv.id); } }}
          placeholder={pv.name}
          spellcheck="false"
          autocomplete="off"
          aria-label="Pill name"
        />
        <button class="fold-go" onclick={() => renamePill(pv.id)} disabled={!renameDraft.trim() || renameDraft.trim() === pv.name} title="Rename this pill">Rename</button>
      </div>

      {#if kind === 'local'}
        {#if pv.primary === false}
          <!-- A secondary local endpoint — its base URL lives in its own provider
               block, not the global engine URL. Read-only here; Remove & re-add to
               change it (a per-pill URL editor is a follow-up). -->
          <label class="fold-label">Base URL</label>
          <div class="fold-readonly">{pv.baseURL ?? '(unknown)'}</div>
          <span class="fold-hint">Secondary local endpoint. To change its URL, Remove &amp; re-add it.</span>
        {:else}
          <!-- The primary local endpoint drives the global engine URL
               (ORIGAMI_API_BASE). Also the default when primary is unknown. -->
          <label class="fold-label" for="engine-url-input">Engine endpoint</label>
          <div class="fold-row">
            <input
              id="engine-url-input"
              class="fold-input"
              type="text"
              bind:value={engineInput}
              onkeydown={onEngineKey}
              placeholder="http://127.0.0.1:1234/v1"
              spellcheck="false"
              autocomplete="off"
              aria-label="Inference engine endpoint URL"
            />
            <button class="fold-go" onclick={saveEngineUrl} disabled={!engineInput.trim()} title="Save endpoint + reconnect origami-acp">Save</button>
          </div>
        {/if}

        <!-- The key is optional and independent of the endpoint. Blank on
             submit CLEARS a stored key (firstFold.writeModelConfig); typing a
             new one overwrites it. Used to need Remove & re-add just for this. -->
        <div class="fold-row">
          <button class="fold-go" onclick={() => openReKey(pv)} title="Set, replace, or clear this provider's API key">Re-key…</button>
        </div>

        {@render modelListBlock()}

        <!-- Repetition penalty is a GLOBAL sampling knob (per-agent, applies to all
             local models), most useful for curbing loops on the local models you run
             directly — so it's shown only on the primary local endpoint, not on every
             secondary/remote server where it's just noise. Still settable in
             origami.json for anyone who wants it elsewhere. -->
        {#if pv.primary !== false}
          <label class="fold-label" for="rep-input">Repetition penalty (0&ndash;2)</label>
          <div class="fold-row">
            <input
              id="rep-input"
              class="fold-input"
              type="number"
              min="0" max="2" step="0.05"
              bind:value={repInput}
              placeholder="0 (off)"
              aria-label="Repetition (frequency) penalty, 0 to 2, blank means off"
            />
            <button class="fold-go" onclick={applyRep} title="Apply — takes effect on your next message">Apply</button>
          </div>
          <span class="fold-hint">Curbs repetition/loops, but accumulates over long output — high values can truncate large writes on local models. Off (0) by default; blank and 0 both mean off.</span>
        {/if}
      {:else if pv.id === 'openrouter'}
        <!-- OpenRouter: the key is the connection; base URL is handled. Re-key to
             replace the key, and browse the live catalog (read-only). -->
        <span class="fold-hint">OpenRouter's base URL is handled for you. Re-key to replace the API key (validated live before it's saved).</span>
        <div class="fold-row">
          <button class="fold-go" onclick={() => openReKey(pv)} title="Replace this provider's API key">Re-key…</button>
        </div>

        <label class="fold-label" for="budget-input">Monthly spend cap (USD)</label>
        <div class="fold-row">
          <input
            id="budget-input"
            class="fold-input"
            type="number"
            min="0"
            step="1"
            bind:value={budgetInput}
            placeholder="no cap"
            aria-label="Monthly spend cap in USD"
          />
          <button class="fold-go" onclick={saveBudget} title="Set the monthly OpenRouter spend cap">Save</button>
        </div>
        <span class="fold-hint">
          This month: <b>{fmtUsd(monthSpend)}</b>{monthBudget ? ` of ${fmtUsd(monthBudget)} (${budgetPct}%)` : ' — no cap set'}. Warns at 80%, blocks cloud turns at 100%. All chats count; resets on the 1st. Blank = no cap.
        </span>

        {@render modelListBlock()}
      {:else if signedIn}
        <!-- OAuth credential present — but an API key may ALSO exist (both entries
             share one provider id), so never claim key absence and keep Re-key. -->
        <span class="fold-hint">Signed in with your {pv.name} subscription. Re-authorize if sign-in has expired; Re-key manages the separate API-key connection if you use one. Pick a model in the chat pane.</span>
        <div class="fold-row">
          <button class="fold-go" onclick={() => openProviderSetup(oauthEntryFor(pv.id))} title="Sign in to this provider again">Re-authorize…</button>
          <button class="fold-go" onclick={() => openReKey(pv)} title="Replace this provider's API key">Re-key…</button>
        </div>
      {:else}
        <!-- Cloud (OpenAI / xAI / Anthropic): the key is the connection; no live
             catalog at runtime, so Re-key + Remove only. -->
        <span class="fold-hint">{pv.name}'s API key is the connection. Re-key to replace it. Pick a model in the chat pane.</span>
        <div class="fold-row">
          <button class="fold-go" onclick={() => openReKey(pv)} title="Replace this provider's API key">Re-key…</button>
        </div>
      {/if}

      <div class="fold-row end">
        <button class="fold-remove" onclick={() => removeProvider(pv.id)} title="Remove this provider from your config">Remove {pv.name}</button>
      </div>
    </div>
  {/if}
{/each}

{#if providerSetupOpen}
  <!-- Provider setup — progressive disclosure. Pick a provider and ONLY that
       provider's fields show. Connect writes the GLOBAL origami.json (via the
       host's writeModelConfig) and lights the pill. -->
  <div class="settings-fold">
    <span class="fold-label">Add / re-key provider</span>
    <!-- Collapsible Local-Self-Hosted/Providers/Labs/Other accordion (t-kgt7wh).
         Local/Self Hosted (every server the user runs — LM Studio, Ollama,
         SGLang, a vLLM on the tailnet) is open by default; the rest start
         collapsed so the picker stays short. Section membership comes from
         classifySection (connectionSection.ts), not `kind`. -->
    <div class="provider-groups" aria-label="Model provider">
      {#each SECTION_ORDER as section (section)}
        {#if setupBySection[section].length > 0}
          <button
            class="provider-group-header"
            type="button"
            aria-expanded={sectionOpen[section]}
            onclick={() => toggleSection(section)}
          >
            <span class="provider-group-chevron" aria-hidden="true">{sectionOpen[section] ? '▾' : '▸'}</span>
            {SECTION_LABEL[section]}
          </button>
          {#if sectionOpen[section]}
            <div class="provider-group-body">
              {#each setupBySection[section] as p (p.id)}
                <button
                  class="provider-option"
                  class:active={p.id === setupProviderId}
                  type="button"
                  aria-pressed={p.id === setupProviderId}
                  onclick={() => applyProviderDefaults(p.id)}
                >{p.label}</button>
              {/each}
            </div>
          {/if}
        {/if}
      {/each}
    </div>

    <!-- Pill name: the instance label. Lets you tell two vLLM / LM Studio boxes
         apart; defaults to the type name. -->
    <label class="fold-label sub" for="setup-name">Pill name</label>
    <input
      id="setup-name"
      class="fold-input"
      type="text"
      bind:value={setupName}
      placeholder={setupProvider.name}
      spellcheck="false"
      autocomplete="off"
      aria-label="Pill name"
    />

    {#if setupProvider.kind !== 'cloud' && setupProvider.kind !== 'oauth' && !setupProvider.keyOnly}
      <label class="fold-label sub" for="setup-baseurl">Base URL</label>
      <input
        id="setup-baseurl"
        class="fold-input"
        type="text"
        bind:value={setupBaseURL}
        placeholder="http://127.0.0.1:1234/v1"
        spellcheck="false"
        autocomplete="off"
        aria-label="Provider base URL"
      />
    {/if}

    {#if setupProvider.kind !== 'oauth'}
      <!-- A self-hosted server MAY require a key (LM Studio, vLLM and SGLang can
           all be put behind one), so kind:'local' gets the field too — clearly
           marked OPTIONAL, because the overwhelmingly common case is an
           unauthenticated loopback server and a blank key must stay a first-class
           save. Blank writes no `apiKey` into the block (writeModelConfig guards
           on truthiness) and the SDK then sends no Authorization header at all.
           Cloud/compat keep the original required-looking label. -->
      {#if setupProvider.kind === 'local'}
        <label class="fold-label sub" for="setup-apikey">API key (optional)</label>
        <input
          id="setup-apikey"
          class="fold-input"
          type="password"
          bind:value={setupApiKey}
          placeholder={reKeyProviderId ? 'blank clears the stored key' : 'leave blank if your server needs no key'}
          spellcheck="false"
          autocomplete="off"
          aria-label="Provider API key (optional)"
        />
      {:else}
        <label class="fold-label sub" for="setup-apikey">API key</label>
        <input
          id="setup-apikey"
          class="fold-input"
          type="password"
          bind:value={setupApiKey}
          placeholder="sk-…"
          spellcheck="false"
          autocomplete="off"
          aria-label="Provider API key"
        />
      {/if}
    {/if}

    {#if setupProvider.keylessCatalog}
      <!-- A gateway that publishes its catalog without a key: pick from the real
           list instead of trusting a baked-in default. Falls back to the preset's
           own default as the single option if the fetch never lands. -->
      <label class="fold-label sub" for="setup-preset-model">Model</label>
      <select
        id="setup-preset-model"
        class="fold-input"
        bind:value={setupModelId}
        aria-label="Model"
      >
        {#each presetModelOptions as mid (mid)}
          <option value={mid}>{mid}</option>
        {/each}
      </select>
    {/if}

    {#if !setupProvider.keyOnly && !setupProvider.localAuto && setupProvider.kind !== 'oauth'}
      <label class="fold-label sub" for="setup-model">Model id</label>
      <input
        id="setup-model"
        class="fold-input"
        type="text"
        bind:value={setupModelId}
        placeholder="model id"
        spellcheck="false"
        autocomplete="off"
        aria-label="Model id"
      />
    {/if}

    {#if setupProvider.kind === 'oauth'}
      <!-- OAUTH SIGN-IN. No fields: pick how you want to sign in, the host
           opens the page in your browser, and the ENGINE holds the flow (its
           plugin is already listening on its own loopback port). One button
           per method the plugin offers — typically "browser" and a headless /
           device-code variant for a machine with no browser on it. -->
      <div class="fold-label sub" id="oauth-methods-label">Sign in</div>
      {#if oauthTargetMethods.length === 0}
        <span class="fold-hint">{oauthError || 'No sign-in method reported yet — open a chat so the engine is running, then reopen this form.'}</span>
      {:else}
        <div class="provider-group-body" aria-labelledby="oauth-methods-label">
          {#each oauthTargetMethods as om (om.index)}
            <button
              class="provider-option"
              type="button"
              disabled={oauthState.phase === 'waiting'}
              onclick={() => startOauth(om.index)}
            >{om.label}</button>
          {/each}
        </div>
      {/if}

      {#if oauthState.phase === 'waiting'}
        <span class="fold-hint" role="status">Waiting for sign-in… complete it in your browser. {oauthState.instructions}</span>
        {#if oauthState.url}
          <div class="fold-readonly">{oauthState.url}</div>
        {/if}
        {#if oauthState.needsCode}
          <label class="fold-label sub" for="oauth-code">Authorization code</label>
          <div class="fold-row">
            <input
              id="oauth-code"
              class="fold-input"
              type="text"
              bind:value={oauthCode}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitOauthCode(); } }}
              placeholder="paste the code from the page"
              spellcheck="false"
              autocomplete="off"
              aria-label="Authorization code"
            />
            <button class="fold-go" onclick={submitOauthCode} disabled={!oauthCode.trim()}>Submit</button>
          </div>
        {/if}
      {:else if oauthState.phase === 'failed'}
        <span class="fold-hint" role="alert">{oauthState.message}</span>
      {:else if oauthState.phase === 'done'}
        <span class="fold-hint" role="status">Signed in — default model {oauthState.model}. Reload the window to use it.</span>
      {/if}

      {#if oauthConnected[oauthTarget]}
        <span class="fold-hint">Already signed in. Signing in again replaces the stored credential.</span>
        {#each oauthUsage[oauthTarget] ?? [] as line (line)}
          <span class="fold-hint">Usage: {line}</span>
        {/each}
      {/if}

      <div class="fold-row">
        <button class="fold-cancel" onclick={closeProviderSetup}>Close</button>
      </div>
      <span class="fold-hint">
        {#if oauthTarget === 'xai'}
          Signs in with your SuperGrok subscription. xAI gates OAuth by subscription tier — if sign-in or the first message comes back 403, your plan does not carry OAuth access; use the "Grok (API)" API-key entry instead. No API key is stored for this connection.
        {:else}
          Signs in with your ChatGPT Plus/Pro account. The models come from the ChatGPT subscription backend (the gpt-5.x Codex family), not the OpenAI platform API — a platform key is a different, metered catalog under the "OpenAI (API)" entry. No API key is stored for this connection.
        {/if}
      </span>
    {:else}
    <div class="fold-row">
      <button class="fold-go" onclick={submitProviderSetup} disabled={!canSubmitSetup} title="Validate + save this provider to origami.json">Connect</button>
      <button class="fold-cancel" onclick={closeProviderSetup}>Cancel</button>
    </div>
    <span class="fold-hint">
      {#if setupProvider.localAuto}
        Just the endpoint — {setupProvider.name}'s loaded model is picked up automatically, and you choose the active model in the chat pane. Add a key only if your server requires one. Saved to your global origami.json.
      {:else if setupProvider.keylessCatalog}
        Your API key plus a starting model — {setupProvider.name}'s base URL is handled, and the model list above is {presetModels.length > 0 ? 'read live from the gateway' : 'the default until the live list loads'}. The key is validated against {setupProvider.name} itself before it's saved (a bad key is never written). You can change model in the chat pane later.
      {:else if setupProvider.keyOnly}
        Just your API key — {setupProvider.name}'s base URL and models are handled for you. The key is validated live before it's saved (a bad key is never written). Pick a model in the chat pane.
      {:else if setupProvider.kind === 'local'}
        Self-hosted endpoint — a key is optional, and only needed if your server enforces one. Pick the active model in the chat pane once connected.
      {:else}
        The API key is saved to your global origami.json. Pick a model in the chat pane once connected.
      {/if}
    </span>
    {/if}
  </div>
{/if}


<style>
  /* Connection-settings strip — a calm paper-toned surface above the chat thread.
     The brand accent (--og-chat) is reserved for the active/focus affordance. */
  .control-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--og-pane-header);
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  /* PROVIDER GRID — the connection surface from the first configured provider
     on: a compact grid of traffic-light squares (colour + initials). Small
     fixed squares that wrap, so anywhere from one to a dozen keys stay usable
     even at the sidebar's narrowest (~200px) — never overflow. */
  .provider-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .grid-square {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.2px;
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  /* The square IS the light — a filled colour block, not an outline. At a dozen
     providers the whole point is reading STATUS at a glance; 9px initials in a
     coloured border makes you read text instead. color-mix keeps one rule
     working across all five themes (light + dark) off the same status var. The
     initials stay for the colour-blind + colour-only-control problem, and the
     full name always lives in title/aria-label. */
  .grid-square.light-green {
    border-color: var(--og-success);
    background: color-mix(in srgb, var(--og-success) 34%, var(--og-input-bg));
    color: var(--og-text);
  }
  .grid-square.light-red {
    border-color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 34%, var(--og-input-bg));
    color: var(--og-text);
  }
  .grid-square.light-yellow {
    border-color: var(--og-warning);
    background: color-mix(in srgb, var(--og-warning) 34%, var(--og-input-bg));
    color: var(--og-text);
  }
  .grid-square.open { box-shadow: 0 0 0 1px var(--og-chat); }

  .add-provider {
    display: inline-flex;
    align-items: center;
    padding: 5px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-chat);
    background: var(--og-input-bg);
    border: 1px dashed color-mix(in srgb, var(--og-chat) 55%, var(--og-border));
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, background 0.12s ease;
  }
  .add-provider:hover { border-color: var(--og-chat); background: var(--og-surface-alt, var(--og-input-bg)); }
  .add-provider.small { flex-shrink: 0; padding: 4px 9px; }

  /* Provider settings fold — a calm fold below the strip. */
  .settings-fold {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 12px 10px;
    background: var(--og-pane-header);
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
  }
  .settings-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 2px;
  }
  .settings-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: var(--og-text);
  }
  .settings-status {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--og-text-muted);
  }
  .settings-status.live { color: var(--og-success); }

  .fold-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--og-text-secondary);
  }
  .fold-label.sub {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    color: var(--og-text-muted);
    margin-top: 2px;
  }
  .fold-label.with-action {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .fold-linkbtn {
    font-size: 10px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--og-chat);
    background: none;
    border: none;
    cursor: pointer;
    font-family: inherit;
    padding: 0;
  }
  .fold-linkbtn:hover { text-decoration: underline; }

  .fold-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .fold-row.end { justify-content: flex-end; margin-top: 4px; }

  .provider-groups {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--og-input-border);
    border-radius: 5px;
    padding: 3px;
    background: var(--og-input-bg);
  }
  .provider-group-header {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 4px 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    color: var(--og-text-muted);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .provider-group-header:hover { color: var(--og-text); }
  .provider-group-chevron { font-size: 9px; flex-shrink: 0; }
  .provider-group-body { display: flex; flex-direction: column; gap: 1px; padding: 0 0 2px 4px; }
  .provider-option {
    width: 100%;
    padding: 5px 8px;
    font-size: 11px;
    font-family: inherit;
    text-align: left;
    color: var(--og-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .provider-option:hover { background: var(--og-btn-bg); color: var(--og-text); }
  .provider-option.active {
    color: var(--og-text);
    border-color: var(--og-chat);
    background: color-mix(in srgb, var(--og-chat) 12%, transparent);
  }

  .fold-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 5px;
    outline: none;
    transition: border-color 0.12s ease;
  }
  .fold-input:focus { border-color: var(--og-chat); }

  .fold-readonly {
    padding: 5px 8px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    overflow-x: auto;
    white-space: nowrap;
  }

  .fold-go {
    padding: 5px 12px;
    font-size: 11px;
    background: var(--og-input-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .fold-go:hover:not(:disabled) { border-color: var(--og-chat); color: var(--og-text); }
  .fold-go:disabled { opacity: 0.4; cursor: not-allowed; }

  .fold-cancel {
    padding: 5px 12px;
    font-size: 11px;
    background: transparent;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .fold-cancel:hover { border-color: var(--og-chat); color: var(--og-text); }

  .fold-remove {
    padding: 5px 12px;
    font-size: 11px;
    background: transparent;
    color: var(--og-error, #ef5350);
    border: 1px solid color-mix(in srgb, var(--og-error, #ef5350) 40%, var(--og-border));
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: background 0.12s ease;
  }
  .fold-remove:hover { background: color-mix(in srgb, var(--og-error, #ef5350) 12%, transparent); }

  /* Read-only "View models" list (LM Studio / OpenRouter). Its own scroll so a
     long catalog stays contained; legible row height so 300+ ids don't read as a
     grey wall. */
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 220px;
    overflow-y: auto;
    padding: 4px;
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
  }
  .model-list-item {
    padding: 5px 10px;
    font-size: 10px;
    line-height: 1.35;
    /* The UI sans font (not monospace): far more legible in a narrow column, and
       OpenRouter's names are prose ("Google: Gemini 2.0 Flash"). */
    font-family: inherit;
    color: var(--og-text);
    border-radius: 4px;
    /* Wrap the FULL name across lines rather than ellipsis-clipping it to ~half
       the row in a narrow sidebar — the whole model name is what's useful here. */
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .model-list-item:nth-child(odd) {
    background: color-mix(in srgb, var(--og-text) 4%, transparent);
  }
  .model-list-empty {
    padding: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    line-height: 1.35;
  }

  .fold-hint {
    font-size: 10px;
    color: var(--og-text-muted);
    line-height: 1.35;
  }
</style>
