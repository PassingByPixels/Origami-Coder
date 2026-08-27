<script lang="ts">
  // YOUR OWN PRICES — the small panel behind the gear beside the run index's
  // reload. Nothing here is shipped knowledge: there is NO bundled price list,
  // because a stale rate presented as fact is worse than no figure at all. The
  // table starts empty and holds exactly what the user typed.
  //
  // One row per model that actually ran in the open run (labyrinthCost's
  // modelsUsed), so the panel asks about the models the reader is looking at
  // rather than a catalog of everything that exists.
  //
  // Presentation + local edit state only. The PANE owns the table and the host
  // round trip, so there is one writer. Colours are theme vars ONLY.
  import { CACHED_INPUT_FACTOR, type ModelPrice, type ModelUsage, type PriceTable } from './labyrinthCost';

  let {
    models, prices, onSave, onClose,
  }: {
    models: readonly ModelUsage[];
    prices: PriceTable;
    onSave: (next: PriceTable) => void;
    onClose: () => void;
  } = $props();

  /** The provider default, as a percent, so the placeholder states the rule. */
  const DEFAULT_CACHED_PERCENT = CACHED_INPUT_FACTOR * 100;

  /**
   * A committed box becomes a number, or ERASES that field. An unparseable
   * string is dropped rather than stored as NaN, which would price the whole
   * run at NaN.
   *
   * ON CHANGE, NOT ON INPUT, and that is load-bearing. The stored table is
   * echoed straight back by the host and re-renders these values, so saving per
   * keystroke would normalise a half-typed "1." to "1" under the cursor and the
   * decimal could never be typed at all. Committing on blur/Enter is also the
   * idiom the pane's column widths already use: the gesture, not each frame.
   */
  function edit(model: string, field: keyof ModelPrice, raw: string): void {
    const value = raw.trim() === '' ? undefined : Number(raw);
    const next: ModelPrice = { ...(prices[model] ?? {}) };
    if (value === undefined || !Number.isFinite(value) || value < 0) delete next[field];
    else next[field] = value;
    const table: PriceTable = { ...prices };
    if (Object.keys(next).length === 0) delete table[model];
    else table[model] = next;
    onSave(table);
  }
  const show = (n: number | undefined): string => (n === undefined ? '' : String(n));
</script>

<div class="lp-panel" role="dialog" aria-label="Model prices">
  <div class="lp-head">
    <span class="lp-title">Model prices</span>
    <button class="lp-close" onclick={onClose} aria-label="Close model prices">&times;</button>
  </div>
  <div class="lp-note">
    Your own numbers, in US dollars per million tokens. Nothing is supplied — an empty row simply produces no
    figure. A cache read bills at <strong>{DEFAULT_CACHED_PERCENT}%</strong> of input unless you say otherwise.
    Every total drawn from these is labelled <strong>indicative</strong>, never a bill.
  </div>
  {#if models.length === 0}
    <div class="lp-empty">Open a run first — its models are the rows to price.</div>
  {:else}
    <div class="lp-rows">
      <div class="lp-row lp-header">
        <span class="lp-model">Model</span><span>$ / Mtok in</span><span>$ / Mtok out</span><span>cached %</span>
      </div>
      {#each models as m (m.model)}
        <div class="lp-row">
          <span class="lp-model" title={m.model}>{m.model}</span>
          <input class="lp-num" type="number" min="0" step="0.01" aria-label={`Input price for ${m.model}`}
            value={show(prices[m.model]?.input)} onchange={(e) => edit(m.model, 'input', e.currentTarget.value)} />
          <input class="lp-num" type="number" min="0" step="0.01" aria-label={`Output price for ${m.model}`}
            value={show(prices[m.model]?.output)} onchange={(e) => edit(m.model, 'output', e.currentTarget.value)} />
          <input class="lp-num" type="number" min="0" step="1" placeholder={String(DEFAULT_CACHED_PERCENT)}
            aria-label={`Cached input percent for ${m.model}`}
            value={show(prices[m.model]?.cachedPercent)} onchange={(e) => edit(m.model, 'cachedPercent', e.currentTarget.value)} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .lp-panel { margin: 0 12px 8px; padding: 8px 10px; border: 1px solid var(--og-border); border-radius: 4px; background: var(--og-surface-alt); flex-shrink: 0; }
  .lp-head { display: flex; align-items: center; gap: 8px; }
  .lp-title { flex: 1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-secondary); }
  .lp-close { background: none; border: none; color: var(--og-text-muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px; font-family: inherit; }
  .lp-close:hover { color: var(--og-text); }
  .lp-note { margin-top: 4px; font-size: 10px; line-height: 1.5; color: var(--og-text-muted); }
  .lp-rows { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
  .lp-row { display: grid; grid-template-columns: 1fr 62px 62px 52px; gap: 4px; align-items: center; }
  .lp-header { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--og-text-muted); }
  .lp-model { font-size: 10px; color: var(--og-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lp-num { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 3px; padding: 2px 4px; font-size: 10px; font-family: inherit; font-variant-numeric: tabular-nums; width: 100%; box-sizing: border-box; }
  .lp-num:focus { outline: 1px solid var(--og-accent); }
  .lp-empty { margin-top: 6px; font-size: 10px; font-style: italic; color: var(--og-text-muted); }
</style>
