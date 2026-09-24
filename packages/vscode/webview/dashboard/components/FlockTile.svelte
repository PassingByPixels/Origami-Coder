<script lang="ts">
  // ONE TILE. Flock has six nouns and each is one of these.
  //
  // The shell only: an icon, a small-caps head, whatever the head carries on
  // its right (a count pill, a state pill, the friends search), and the body.
  // Every tile in the grid is therefore the same 16px padding, the same
  // hairline and the same 6px radius by construction rather than by six files
  // agreeing — which is the failure the mock was drawn to end.
  //
  // `edge` is one of the two variations, and only the Front Desk uses it: it is
  // the tile that can be BROKEN (no model = every question refused), so it
  // carries a coloured left edge and the eye finds the fact before it finds a
  // control.
  //
  // `fill` is the other, and the bottom row uses it: those three tiles are
  // given the pane's whole remaining height, so their LIST has to scroll inside
  // the tile instead of growing the page. That needs a real box around the
  // body, which is why one is always rendered — `display: contents` everywhere
  // else, so a tile that does not fill lays out exactly as it did when the body
  // was the section's own children.
  interface Props {
    /** A symbol id from FlockChrome.svelte, without the `#`. */
    icon: string;
    title: string;
    /** The left edge, when this tile has a state worth colouring. */
    edge?: 'ok' | 'broken';
    /** Take the row's whole height and scroll the body inside it. */
    fill?: boolean;
    /** The right-hand end of the head row: a pill, a count, a search box. */
    head?: import('svelte').Snippet;
    children: import('svelte').Snippet;
  }
  let { icon, title, edge, fill = false, head, children }: Props = $props();
</script>

<section class="fk-tile" class:fill class:ok={edge === 'ok'} class:broken={edge === 'broken'}>
  <div class="fk-tile-head">
    <svg class="fk-ico head-ico" aria-hidden="true"><use href={`#${icon}`} /></svg>
    <span class="fk-caps">{title}</span>
    {#if head}{@render head()}{/if}
  </div>
  <div class="fk-tile-body">{@render children()}</div>
</section>

<style>
  .fk-tile {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px;
    padding: 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0;
  }
  .fk-tile.ok { border-left: 3px solid var(--og-success); }
  .fk-tile.broken { border-left: 3px solid var(--og-error); }
  /* WRAP: a squeezed tile drops the head's snippet under icon+title. */
  .fk-tile-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fk-tile-head .fk-caps { flex: 1; min-width: 0; }
  .head-ico { color: var(--og-text-muted); }
  /* Not a box at all unless the tile fills: the body's children stay the
     section's own flex items, so `margin-top: auto` on a footer still reaches
     the tile floor. */
  .fk-tile-body { display: contents; }
  .fk-tile.fill { min-height: 0; }
  .fk-tile.fill .fk-tile-body {
    display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow-y: auto;
  }
</style>
