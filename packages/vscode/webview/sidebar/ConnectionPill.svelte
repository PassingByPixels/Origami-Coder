<script lang="ts">
  // ONE square in the sidebar's connection strip: two initials, a traffic-light
  // wash, a click.
  //
  // EXTRACTED from ControlStrip.svelte, which sat EXACTLY on its 1241 cap when
  // Claude Code needed a square of its own. That is the honest reason, but not
  // the only one: "match the provider squares exactly" is a promise CSS in two
  // places cannot keep. The row is read as a row — eight 26px squares, one line
  // — and a second copy of the box model drifts by a pixel the first time
  // either side is touched. One component, one set of dimensions, by
  // construction rather than by review.
  //
  // The passthrough square is the same box with a DOTTED border: Claude Code is
  // not a provider (no endpoint, no key, nothing probed), so it must not read as
  // one at a glance — and a dotted edge says "different kind of thing" without
  // spending a colour that already means Live/Idle/Error here.
  import { tip } from '../shared/warmTip';
  interface Props {
    /** Two characters. Longer is not truncated here — the caller decides what
     *  the initials of its own thing are (providerGrid.ts does it for a name). */
    label: string;
    /** The provider NAME on up to two short centred lines (change 4). When
     *  present it replaces the initials: at the carousel's tile width the name
     *  itself fits, and a name beats two letters every time. Empty keeps the
     *  initials, which is what the Claude Code square still wants. */
    lines?: string[];
    /** The full name + status. Carried as the warm tip AND aria-label, as the
     *  square itself is initials and a colour: neither is readable alone. */
    title: string;
    /** '' = the neutral idle square. */
    light?: 'green' | 'red' | 'yellow' | '';
    /** This square's settings fold is open — a ring, not a colour change. */
    open?: boolean;
    /** Not a provider: same box, dotted edge, crane tone. */
    dotted?: boolean;
    /** This tile's provider is the one the active chat's model is on right
     *  now (change 30) — a ring, like `open`, not a second colour: the
     *  traffic light already spends green/red/yellow on reachability. */
    inuse?: boolean;
    onclick: () => void;
  }
  let { label, lines = [], title, light = '', open = false, dotted = false, inuse = false, onclick }: Props = $props();
</script>

<button
  class="grid-square"
  class:light-green={light === 'green'}
  class:light-red={light === 'red'}
  class:light-yellow={light === 'yellow'}
  class:open
  class:dotted
  class:inuse
  class:named={lines.length > 0}
  use:tip={title}
  aria-label={title}
  {onclick}
>{#if lines.length > 0}{#each lines as line}<span class="grid-line">{line}</span>{/each}{:else}{label}{/if}</button>

<style>
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
  /* change 30 — marks the provider the active chat's model is actually on. */
  .grid-square.inuse { border-color: var(--og-accent); box-shadow: 0 0 0 1px var(--og-accent); }
  /* A tile in the connections carousel. The WIDTH is solved for by
     connectionCarouselFit.ts and published as --conn-tile-w on the track, so
     a whole number of tiles spans it exactly and none is ever half-cut; the
     fallback keeps a square wherever no carousel sets the var. */
  /* HEIGHT and FONT are the 26px square's own (t-qhzy4k): a card that
     replaces an element inherits that element's scale, and 44px tall cards in
     10px type were what made the sidebar read as zoomed in. Two 9px lines at
     1.15 come to 20.7px, which clears the 24px inside the border. */
  .grid-square.named { flex-direction: column; gap: 0; width: var(--conn-tile-w, 26px); min-width: 0; height: 26px; padding: 0 3px; line-height: 1.15; scroll-snap-align: start; }
  .grid-line { display: block; max-width: 100%; font-size: 9px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } /* t-vikozs: never a mid-word break */
  /* A harness, not a connection. Dotted + the crane tone; the border WIDTH is
     unchanged, so the box stays exactly the size of the squares beside it. */
  .grid-square.dotted {
    border-style: dotted;
    border-color: var(--og-crane);
    color: var(--og-crane);
  }
</style>
