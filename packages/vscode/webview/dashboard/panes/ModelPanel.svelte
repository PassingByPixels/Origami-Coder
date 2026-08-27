<script lang="ts">
  // Phase M3 rectification — ModelPanel: VRAM state, loaded models, profile
  // database, and router recommendations. Replaces the audit-flagged gap in
  // Phase M6 where this panel was planned but never shipped.

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import LoadingCycler from '../components/LoadingCycler.svelte';

  interface GpuState { name: string; vram_total_mb: number; vram_free_mb: number; vram_used_mb: number; }
  interface VramState { gpus: GpuState[]; ram_total_mb?: number; ram_free_mb?: number; }
  interface LoadedModel { identifier: string; model_key: string; type?: string; state?: string; }
  interface ContextProfile { context_size: number; memory_mb: number; fits: boolean; }
  interface ModelProfile { model_key: string; pool: 'vram' | 'ram'; base_memory_mb: number; profiles: ContextProfile[]; }
  interface Recommendation { model_key: string; context_size: number; reason: string; }

  const vscode = getVsCodeApi();

  let vram: VramState | null = $state(null);
  let loaded: LoadedModel[] = $state([]);
  let profiles: ModelProfile[] = $state([]);
  let recommendation: Recommendation | null = $state(null);
  let refreshing = $state(false);
  let error: string | null = $state(null);
  let lastRefresh: number | null = $state(null);
  // Phase M3 rectification — profiling mode surfaced from ACP
  let profilingMode: 'normal' | 'game' = $state('normal');
  let configuredVramHeadroomGb: number = $state(8);
  let effectiveVramHeadroomGb: number = $state(1);

  // B5/B6 — the model row currently mid-load/unload. The button is
  // replaced with a LoadingCycler until the backend's actionDone/error
  // event lands, so unload is no longer a silent no-feedback click.
  let pending: { id: string; kind: 'load' | 'unload' } | null = $state(null);
  // B6 — per-model context size the user wants (in K tokens). Seeded
  // from the recommended best fit; editable before pressing load.
  let ctxInputs: Record<string, number> = $state({});

  function refresh() {
    refreshing = true;
    error = null;
    vscode.postMessage({ type: 'modelPanel.refresh' });
  }

  function loadModel(modelKey: string, contextKTokens: number) {
    pending = { id: modelKey, kind: 'load' };
    vscode.postMessage({
      type: 'modelPanel.load',
      modelKey,
      contextLength: Math.round(contextKTokens * 1024),
    });
  }

  function unloadModel(identifier: string) {
    pending = { id: identifier, kind: 'unload' };
    vscode.postMessage({ type: 'modelPanel.unload', identifier });
  }

  // Largest context (in K tokens) that fits the current VRAM budget for
  // a model, from its profile. Used to warn when the user overshoots.
  function maxFitK(modelKey: string): number {
    const p = profiles.find(pr => pr.model_key === modelKey && pr.pool === 'vram');
    if (!p) return 0;
    const vramFree = primaryGpu?.vram_free_mb ?? Number.MAX_SAFE_INTEGER;
    const fits = p.profiles.filter(cp => cp.fits && cp.memory_mb <= vramFree);
    if (fits.length === 0) return 0;
    return Math.round(Math.max(...fits.map(cp => cp.context_size)) / 1024);
  }

  // Profile-database swap: pick a model + context and make it the ACTIVE
  // model (unload current → load this at the chosen window → switch
  // interactive + feed). Routes through set_active_model, unlike the
  // best-fits "load" which loads alongside.
  let swapInputs: Record<string, number> = $state({});
  function maxCtxK(p: ModelProfile): number {
    if (!p.profiles.length) return 8;
    return Math.max(1, Math.round(Math.max(...p.profiles.map(cp => cp.context_size)) / 1024));
  }
  function swapModel(modelKey: string, contextKTokens: number) {
    pending = { id: modelKey, kind: 'load' };
    vscode.postMessage({
      type: 'modelPanel.swap',
      modelKey,
      contextLength: Math.round(contextKTokens * 1024),
    });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'modelPanel.state') {
      vram = msg.vram ?? null;
      loaded = msg.loaded ?? [];
      profiles = msg.profiles ?? [];
      recommendation = msg.recommendation ?? null;
      if (msg.mode === 'game' || msg.mode === 'normal') {
        profilingMode = msg.mode;
      }
      if (typeof msg.configuredVramHeadroomGb === 'number') {
        configuredVramHeadroomGb = msg.configuredVramHeadroomGb;
      }
      if (typeof msg.effectiveVramHeadroomGb === 'number') {
        effectiveVramHeadroomGb = msg.effectiveVramHeadroomGb;
      }
      refreshing = false;
      error = null;
      lastRefresh = Date.now();
    } else if (msg.type === 'modelPanel.error') {
      error = typeof msg.error === 'string' ? msg.error : 'Unknown error';
      refreshing = false;
      pending = null;
    } else if (msg.type === 'modelPanel.actionDone') {
      // Action finished — clear the inflight indicator and re-refresh
      // to pick up the new loaded list + VRAM.
      pending = null;
      refresh();
    }
  });

  // Auto-refresh on mount
  refresh();

  function fmtGB(mb: number): string { return (mb / 1024).toFixed(1); }
  function pct(used: number, total: number): number {
    return total > 0 ? Math.round((used / total) * 100) : 0;
  }

  let primaryGpu = $derived(vram?.gpus?.[0] ?? null);
  let vramUsedMb = $derived(primaryGpu ? primaryGpu.vram_used_mb : 0);
  let vramTotalMb = $derived(primaryGpu ? primaryGpu.vram_total_mb : 0);
  let vramPct = $derived(pct(vramUsedMb, vramTotalMb));
  let ramUsedMb = $derived(
    vram && vram.ram_total_mb != null && vram.ram_free_mb != null
      ? vram.ram_total_mb - vram.ram_free_mb
      : 0
  );
  let ramTotalMb = $derived(vram?.ram_total_mb ?? 0);
  let ramPct = $derived(pct(ramUsedMb, ramTotalMb));

  // Build the "top fits" list from profiles, ranked by max context that fits
  interface Candidate { model_key: string; pool: string; best_ctx: number; memory_mb: number; }
  let topFits: Candidate[] = $derived.by(() => {
    const vramFree = primaryGpu?.vram_free_mb ?? Number.MAX_SAFE_INTEGER;
    const out: Candidate[] = [];
    for (const p of profiles) {
      if (p.pool !== 'vram') continue;
      const fits = p.profiles.filter(cp => cp.fits && cp.memory_mb <= vramFree);
      if (fits.length === 0) continue;
      const best = fits.reduce((a, b) => (b.context_size > a.context_size ? b : a));
      out.push({ model_key: p.model_key, pool: p.pool, best_ctx: best.context_size, memory_mb: best.memory_mb });
    }
    out.sort((a, b) => b.best_ctx - a.best_ctx);
    return out.slice(0, 8);
  });

  let profiledSet = $derived(new Set(profiles.map(p => p.model_key)));
  let loadedSet = $derived(new Set(loaded.map(l => l.identifier)));
</script>

<div class="model-panel">
  <header class="mp-header">
    <span class="mp-title">Model Manager</span>
    <div class="mp-header-actions">
      <button class="mp-btn" onclick={refresh} disabled={refreshing}>
        {refreshing ? 'refreshing…' : 'refresh'}
      </button>
    </div>
  </header>

  <div class="mp-mode-line">
    Effective VRAM reserve: <strong>{effectiveVramHeadroomGb.toFixed(1)} GB</strong>
    <span class="dim">· Game mode would reserve {configuredVramHeadroomGb.toFixed(1)} GB</span>
  </div>

  {#if error}
    <div class="mp-error">{error}</div>
  {/if}

  <!-- VRAM + RAM summary -->
  <section class="mp-section">
    <h3 class="mp-h3">Hardware</h3>
    {#if primaryGpu}
      <div class="mp-row">
        <span class="mp-label">{primaryGpu.name}</span>
        <span class="mp-pct" class:hot={vramPct > 85} class:warn={vramPct > 70 && vramPct <= 85}>
          {vramPct}%
        </span>
      </div>
      <div class="mp-bar">
        <div class="mp-bar-fill" class:hot={vramPct > 85} class:warn={vramPct > 70 && vramPct <= 85} style="width: {vramPct}%"></div>
      </div>
      <div class="mp-sub">VRAM {fmtGB(vramUsedMb)} / {fmtGB(vramTotalMb)} GB</div>
    {:else}
      <div class="mp-sub">No GPU detected (CPU-only mode)</div>
    {/if}

    {#if vram && ramTotalMb > 0}
      <div class="mp-row" style="margin-top: 12px;">
        <span class="mp-label">System RAM</span>
        <span class="mp-pct" class:hot={ramPct > 85}>{ramPct}%</span>
      </div>
      <div class="mp-bar">
        <div class="mp-bar-fill" class:hot={ramPct > 85} style="width: {ramPct}%"></div>
      </div>
      <div class="mp-sub">RAM {fmtGB(ramUsedMb)} / {fmtGB(ramTotalMb)} GB</div>
    {/if}
  </section>

  <!-- Loaded models -->
  <section class="mp-section">
    <h3 class="mp-h3">Loaded ({loaded.length})</h3>
    {#if loaded.length === 0}
      <div class="mp-empty">No models loaded.</div>
    {:else}
      {#each loaded as m (m.identifier)}
        <div class="mp-row mp-item">
          <div class="mp-item-name">
            <span class="mp-dot loaded"></span>
            <span class="mp-model-key">{m.identifier}</span>
            {#if m.state}<span class="mp-tag">[{m.state}]</span>{/if}
          </div>
          {#if pending && pending.kind === 'unload' && pending.id === m.identifier}
            <LoadingCycler active label="unloading" phrases={['releasing VRAM…', 'stopping…']} />
          {:else}
            <button class="mp-btn-small danger" disabled={pending !== null} onclick={() => unloadModel(m.identifier)}>unload</button>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <!-- Router recommendations — best fits for current VRAM budget -->
  <section class="mp-section">
    <h3 class="mp-h3">Best fits for current VRAM budget</h3>
    {#if topFits.length === 0}
      <div class="mp-empty">No profiled models fit. Run profiling via `/models profile --quick` in the TUI, or `/firstfold` for the full walkthrough.</div>
    {:else}
      {#each topFits as c (c.model_key)}
        {@const fitK = maxFitK(c.model_key)}
        {@const ctxK = ctxInputs[c.model_key] ?? Math.round(c.best_ctx / 1024)}
        {@const overFit = fitK > 0 && ctxK > fitK}
        <div class="mp-item mp-item-stack">
          <div class="mp-row">
            <div class="mp-item-name">
              <span class="mp-model-key">{c.model_key}</span>
              <span class="mp-tag">≤{Math.round(c.best_ctx / 1024)}k fits · {Math.round(c.memory_mb / 1024)}G</span>
              {#if profiledSet.has(c.model_key)}<span class="mp-tag dim">profiled</span>{/if}
            </div>
            {#if loadedSet.has(c.model_key)}
              <span class="mp-tag dim">already loaded</span>
            {:else if pending && pending.kind === 'load' && pending.id === c.model_key}
              <LoadingCycler active label="loading" phrases={['allocating VRAM…', 'warming up…']} />
            {:else}
              <div class="mp-ctx-row">
                <label class="mp-ctx-label" title="Context size to load this model with (in thousands of tokens)">
                  <input
                    class="mp-ctx-input"
                    type="number"
                    min="1"
                    step="1"
                    value={ctxK}
                    oninput={(e) => ctxInputs[c.model_key] = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1)}
                  />k ctx
                </label>
                <button class="mp-btn-small" disabled={pending !== null} onclick={() => loadModel(c.model_key, ctxK)}>load</button>
              </div>
            {/if}
          </div>
          {#if overFit && !(pending && pending.id === c.model_key)}
            <div class="mp-ctx-warn">⚠ {ctxK}k exceeds the ~{fitK}k that fits the current VRAM budget — load may fail or spill to RAM.</div>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <!-- All profiled models (for reference) -->
  <section class="mp-section">
    <h3 class="mp-h3">Profile database ({profiles.length})</h3>
    {#if profiles.length === 0}
      <div class="mp-empty">No profiles yet. Run `/models profile --quick` or `/firstfold`.</div>
    {:else}
      {#each profiles as p (p.model_key + '-' + p.pool)}
        {@const seedK = swapInputs[p.model_key] ?? maxCtxK(p)}
        {@const isLoaded = loadedSet.has(p.model_key)}
        <div class="mp-item mp-item-stack" class:dim={p.pool !== 'vram'}>
          <div class="mp-row">
            <div class="mp-item-name">
              <span class="mp-model-key">{p.model_key}</span>
              <span class="mp-tag">{p.pool.toUpperCase()} · base {fmtGB(p.base_memory_mb)}G · {p.profiles.length} ctx pts</span>
            </div>
            {#if p.pool === 'vram'}
              {#if isLoaded}
                <span class="mp-tag dim">active</span>
              {:else if pending && pending.id === p.model_key}
                <LoadingCycler active label="swapping" phrases={['unloading current…', 'loading…', 'verifying…']} />
              {:else}
                <div class="mp-ctx-row">
                  <label class="mp-ctx-label" title="Swap to this model, loaded at this context size (thousands of tokens)">
                    <input
                      class="mp-ctx-input"
                      type="number"
                      min="1"
                      step="1"
                      value={seedK}
                      oninput={(e) => swapInputs[p.model_key] = Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1)}
                    />k ctx
                  </label>
                  <button class="mp-btn-small" disabled={pending !== null} onclick={() => swapModel(p.model_key, seedK)}>swap</button>
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </section>

  {#if lastRefresh}
    <footer class="mp-footer">
      Last refresh: {new Date(lastRefresh).toLocaleTimeString()}
    </footer>
  {/if}
</div>

<style>
  .model-panel {
    padding: 12px 16px;
    overflow-y: auto;
    height: 100%;
    color: var(--og-text, #dcdde0);
    font-size: 12px;
  }
  .mp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .mp-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mp-mode-line {
    font-size: 10px;
    color: var(--og-text, #dcdde0);
    margin-bottom: 12px;
    padding: 4px 8px;
    background: var(--og-pane-header, #1e1f24);
    border-radius: 3px;
  }
  .mp-mode-line .dim {
    color: var(--og-dim, #8a8a90);
    margin-left: 4px;
  }
  .mp-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--og-accent-2, #d4a84b);
  }
  .mp-section {
    margin-bottom: 20px;
  }
  .mp-h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--og-dim, #8a8a90);
    margin: 0 0 8px 0;
    font-weight: 600;
  }
  .mp-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
  }
  .mp-item {
    padding: 6px 8px;
    border-radius: 3px;
    background: var(--og-pane-header, #1e1f24);
    margin-bottom: 4px;
  }
  .mp-item.dim { opacity: 0.7; }
  .mp-item-name {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }
  .mp-label { color: var(--og-text, #dcdde0); font-weight: 500; }
  .mp-model-key {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mp-tag {
    font-size: 10px;
    color: var(--og-dim, #8a8a90);
    background: var(--og-border, #33343a);
    padding: 1px 6px;
    border-radius: 2px;
  }
  .mp-tag.dim { opacity: 0.6; }
  .mp-pct {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: #66bb6a;
  }
  .mp-pct.warn { color: #ffb74d; }
  .mp-pct.hot { color: #ef5350; }
  .mp-bar {
    width: 100%;
    height: 6px;
    background: var(--og-border, #33343a);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 4px;
  }
  .mp-bar-fill {
    height: 100%;
    background: #66bb6a;
    transition: width 300ms ease;
  }
  .mp-bar-fill.warn { background: #ffb74d; }
  .mp-bar-fill.hot { background: #ef5350; }
  .mp-sub {
    font-size: 10px;
    color: var(--og-dim, #8a8a90);
    margin-top: 2px;
  }
  .mp-empty {
    font-style: italic;
    color: var(--og-dim, #8a8a90);
    padding: 8px 0;
  }
  .mp-error {
    color: #ef5350;
    background: rgba(239, 83, 80, 0.1);
    padding: 8px 12px;
    border-radius: 3px;
    margin-bottom: 12px;
    font-size: 11px;
  }
  .mp-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    background: #66bb6a;
  }
  .mp-dot.loaded { background: #66bb6a; }
  .mp-btn {
    background: var(--og-border, #33343a);
    border: 1px solid var(--og-border, #33343a);
    color: var(--og-text, #dcdde0);
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .mp-btn:hover { background: var(--og-pane-header, #1e1f24); }
  .mp-btn:disabled { opacity: 0.5; cursor: wait; }
  .mp-btn-small {
    background: transparent;
    border: 1px solid var(--og-border, #33343a);
    color: var(--og-text, #dcdde0);
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 10px;
  }
  .mp-btn-small:hover { background: var(--og-border, #33343a); }
  .mp-btn-small.danger {
    color: #ef5350;
    border-color: rgba(239, 83, 80, 0.3);
  }
  .mp-btn-small.danger:hover { background: rgba(239, 83, 80, 0.1); }
  .mp-btn-small:disabled { opacity: 0.5; cursor: wait; }
  .mp-item-stack { display: flex; flex-direction: column; gap: 4px; }
  .mp-ctx-row { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
  .mp-ctx-label {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: var(--og-dim, #8a8a90);
  }
  .mp-ctx-input {
    width: 46px;
    background: var(--og-bg, #16171b);
    border: 1px solid var(--og-border, #33343a);
    color: var(--og-text, #dcdde0);
    border-radius: 2px;
    padding: 2px 4px;
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .mp-ctx-warn {
    font-size: 10px;
    color: #ffb74d;
    padding-left: 2px;
  }
  .mp-footer {
    font-size: 10px;
    color: var(--og-dim, #8a8a90);
    text-align: right;
    margin-top: 16px;
  }
</style>
