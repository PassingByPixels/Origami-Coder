<script lang="ts">
  // Insights — the cache-hit-ratio card (t-kgtw47). Answers "is prompt
  // caching actually saving tokens here", for this session and over the
  // workspace's lifetime. Self-contained: owns its own request/reply wire
  // (cacheStats / cacheStatsData), like PromptCaptureSection, so
  // InstructionsPane only has to mount it.
  //
  // Three numbers per row — fresh input, cache read, cache write — plus the
  // read ratio. WRITE is never framed as a "miss": see cacheRatio.ts.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { cacheReadRatio, type CacheTokens } from './cacheRatio';

  const vscode = getVsCodeApi();

  interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

  let current: Tokens | null = $state(null);
  let lifetime: Tokens | null = $state(null);
  let sessionCount = $state(0);
  let error: string | null = $state(null);
  let loaded = $state(false);

  function refresh(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'cacheStats' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'cacheStatsData') return;
    current = msg.current ?? null;
    lifetime = msg.lifetime ?? null;
    sessionCount = typeof msg.sessionCount === 'number' ? msg.sessionCount : 0;
    error = typeof msg.error === 'string' ? msg.error : null;
    loaded = true;
  });

  refresh();

  const ratioOf = (t: Tokens | null): number => (t ? cacheReadRatio(t as CacheTokens) : 0);
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
</script>

<div class="cs-card">
  <div class="cs-head">
    <span class="cs-title">Cache hit ratio</span>
    <button class="cs-refresh" onclick={refresh} title="Reload cache stats">↻</button>
  </div>
  {#if !loaded}
    <div class="cs-empty">Reading cache stats…</div>
  {:else if error}
    <div class="cs-error">{error}</div>
  {:else}
    <div class="cs-row">
      <span class="cs-row-label">This session</span>
      {#if current}
        <span class="cs-nums">
          {current.input.toLocaleString()} fresh · {current.cacheRead.toLocaleString()} read ·
          {current.cacheWrite.toLocaleString()} write
        </span>
        <span class="cs-ratio">{pct(ratioOf(current))} read</span>
      {:else}
        <span class="cs-nums cs-nodata">No data yet</span>
      {/if}
    </div>
    <div class="cs-row">
      <span class="cs-row-label">Lifetime ({sessionCount})</span>
      {#if lifetime}
        <span class="cs-nums">
          {lifetime.input.toLocaleString()} fresh · {lifetime.cacheRead.toLocaleString()} read ·
          {lifetime.cacheWrite.toLocaleString()} write
        </span>
        <span class="cs-ratio">{pct(ratioOf(lifetime))} read</span>
      {:else}
        <span class="cs-nums cs-nodata">No data yet</span>
      {/if}
    </div>
    <div class="cs-note">
      A provider that does not report cache usage (most local servers) shows every number here as zero — that is an
      <strong>unmeasured</strong> provider, not a session with no caching.
    </div>
  {/if}
</div>

<style>
  .cs-card { margin: 0 12px 10px; padding: 8px 10px; font-size: 11px; color: var(--og-text); background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 4px; }
  .cs-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .cs-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); flex: 1; }
  .cs-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 1px 6px; font-size: 12px; }
  .cs-refresh:hover { background: var(--og-btn-hover); }
  .cs-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; flex-wrap: wrap; }
  .cs-row-label { width: 110px; flex-shrink: 0; color: var(--og-text-secondary); }
  .cs-nums { flex: 1; font-variant-numeric: tabular-nums; color: var(--og-text); }
  .cs-nodata { font-style: italic; color: var(--og-text-muted); }
  .cs-ratio { font-weight: 600; color: var(--og-accent); font-variant-numeric: tabular-nums; }
  .cs-note { margin-top: 6px; color: var(--og-text-muted); line-height: 1.4; }
  .cs-error { color: var(--og-error); }
  .cs-empty { color: var(--og-text-muted); font-style: italic; }
</style>
