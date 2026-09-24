<script lang="ts">
  // The hero chart's key: one row per connection with its colour, its window
  // length and its badge, then the two reference marks the chart draws.
  //
  // A LEGEND ROW IS A HANDLE, not only a label. Hovering one highlights that
  // connection's line, its projection and its end label, which is the only way
  // to read five bunched lines apart without a click.
  import type { GlideLane } from './glidepathMath';

  let {
    lanes,
    highlight,
    onHighlight,
  }: {
    lanes: readonly GlideLane[];
    highlight: string | null;
    onHighlight: (id: string | null) => void;
  } = $props();
</script>

<div class="gp-legend">
  {#each lanes as lane (lane.providerId + lane.label)}
    <span
      class="gp-lp"
      class:gp-dim={highlight !== null && highlight !== lane.providerId}
      title="{lane.name} — {lane.label}"
      role="presentation"
      onmouseenter={() => onHighlight(lane.providerId)}
      onmouseleave={() => onHighlight(null)}
    >
      <span class="gp-sw" style="background:{lane.colour}"></span>{lane.name}
      <!-- The LENGTH, on every entry. On a fraction axis a week and a month are
           the same width, so the only place the reader learns which is which is
           here and on the card. -->
      <span class="gp-len">{lane.lengthLabel ?? 'period unknown'}</span>
      {#if lane.status}
        <span class="gp-st gp-{lane.status.replace(' ', '-').toLowerCase()}">{lane.status}</span>
      {:else}
        <span class="gp-st gp-too-early">TOO EARLY</span>
      {/if}
    </span>
  {/each}
  <span class="gp-lp gp-ref"><span class="gp-sw gp-sw-dash"></span>fair pace</span>
  <span class="gp-lp gp-ref"><span class="gp-sw gp-sw-dot"></span>dotted = before readings began</span>
  <span class="gp-lp gp-ref"><span class="gp-sw gp-sw-reset"></span>RESET — end of window</span>
</div>

<style>
  .gp-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--og-text-secondary); margin-bottom: 6px; }
  .gp-lp { display: inline-flex; gap: 6px; align-items: center; transition: opacity 90ms linear; }
  .gp-dim { opacity: 0.35; }
  .gp-ref { color: var(--og-text-muted); }
  .gp-sw { width: 18px; height: 3px; border-radius: 2px; flex: none; }
  .gp-sw-dash { background: repeating-linear-gradient(90deg, var(--og-text-muted) 0 4px, transparent 4px 8px); }
  /* A DIFFERENT rhythm to the dashed fair pace and the dashed projection —
     the three references have to be told apart at a glance. */
  .gp-sw-dot { background: repeating-linear-gradient(90deg, var(--og-text-muted) 0 1px, transparent 1px 4px); height: 2px; }
  .gp-sw-reset { background: var(--og-text); height: 2px; }
  .gp-len { color: var(--og-text-muted); font-size: 10px; }
  /* .gp-st and the status colours are defined ONCE, in GlidepathView.svelte, so
     a badge here and a badge on a mini card cannot be worded the same and
     coloured differently. */
</style>
