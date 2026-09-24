<script lang="ts">
  // ONE tab button in the picker's type (tier-1) or source (tier-1b) column —
  // extracted so ModelPicker.svelte, which renders two near-identical `{#each}`
  // loops over this markup, stays under its line cap while the columns gain a
  // mark. A LEAF: it posts nothing, ModelPicker owns pickTop/pickGroup and
  // passes them in as `onClick`.
  //
  // Two mark kinds, decided by the caller (modelPickerMarks.ts is the pure
  // logic; this file only draws what it is given):
  //  - 'type'   — an SVG glyph (server/cloud/flask/box), one per
  //    ConnectionSection, drawn from plain rect/path data so no `{@html}` is
  //    needed for a value this component does not own.
  //  - 'source' — for one of twelve big vendors (t-qi0qrh), an inline
  //    monochrome SVG mark (webview/shared/vendorMarks.ts, ten of twelve are
  //    the vendor's real Simple Icons mark — CC0) tinted with the vendor's
  //    colour; every other source falls back to the coloured monogram badge
  //    (vendor initials on the vendor's own colour).
  //
  // Column layout lives in ModelPicker.svelte's grid; this file owns the row's
  // OWN look (list row, not the old wrapped chip), including the base
  // `.mp-provider`/`.mp-dot` styling that used to live there.

  import type { TypeGlyph, VendorMark } from './modelPickerMarks';
  import { tip } from '../../shared/warmTip';
  import { matchVendorMarkId, VENDOR_MARK_PATHS } from '../../shared/vendorMarks';

  type Mark = { kind: 'type'; glyph: TypeGlyph } | { kind: 'source'; mark: VendorMark };

  let { label, active, live, tip: tipText, mark, sub = false, onClick }: {
    label: string;
    active: boolean;
    live: boolean;
    tip: string;
    mark: Mark;
    /** True for a tier-1b (source) tab — same look, slightly lighter weight. */
    sub?: boolean;
    onClick: () => void;
  } = $props();

  // A 'source' mark whose vendor is one of the twelve named ones draws its
  // own SVG glyph; every other source keeps the monogram badge.
  let vendorMark = $derived(
    mark.kind === 'source' ? VENDOR_MARK_PATHS[matchVendorMarkId(label) ?? ''] : undefined,
  );
</script>

<button
  class="mp-provider"
  class:mp-group-sub={sub}
  class:active
  class:live
  role="tab"
  aria-selected={active}
  onclick={onClick}
  use:tip={tipText}
>
  {#if mark.kind === 'type'}
    <svg class="mp-dot mp-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {#each mark.glyph.rects ?? [] as r (r.x + ',' + r.y)}
        <rect x={r.x} y={r.y} width={r.width} height={r.height} rx={r.rx ?? 0} />
      {/each}
      {#each mark.glyph.paths ?? [] as d}
        <path {d} />
      {/each}
    </svg>
  {:else if vendorMark}
    <svg class="mp-dot mp-vendor-icon" viewBox="0 0 24 24" fill="currentColor"
      style="color:{mark.mark.color}" aria-hidden="true">
      <path d={vendorMark.path} fill-rule={vendorMark.fillRule} />
    </svg>
  {:else}
    <span class="mp-dot mp-source-badge" style="background:{mark.mark.color}" aria-hidden="true">{mark.mark.monogram}</span>
  {/if}
  <span class="mp-provider-label">{label}</span>
</button>

<style>
  .mp-provider {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    color: var(--og-text-secondary);
    background: var(--og-input-bg);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .mp-provider:hover { border-color: var(--og-chat); color: var(--og-text); }
  .mp-provider.active { border-color: var(--og-chat); color: var(--og-text); background: color-mix(in srgb, var(--og-chat) 12%, transparent); }
  .mp-group-sub { font-weight: 500; }

  .mp-dot { flex-shrink: 0; }
  .mp-type-icon { width: 13px; height: 13px; color: inherit; }
  .mp-vendor-icon { width: 14px; height: 14px; }
  .mp-source-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    color: #fff;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
  }
  .mp-provider-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Live status used to be the plain dot's own colour; the dot now carries the
     type/source mark instead, so a small corner tick keeps the signal instead
     of dropping it outright. */
  .mp-provider.live .mp-provider-label::after {
    content: '';
    display: inline-block;
    width: 5px;
    height: 5px;
    margin-left: 5px;
    border-radius: 50%;
    background: var(--og-success);
    vertical-align: middle;
  }
</style>
