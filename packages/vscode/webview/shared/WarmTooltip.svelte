<script module lang="ts">
  // WARM TOOLTIP — the one box every `use:tip` control shares.
  //
  // API for other lanes (the A2 chat pane reuses this verbatim):
  //   import WarmTooltip from '../shared/WarmTooltip.svelte';
  //   import { tip } from '../shared/warmTip';
  //   <WarmTooltip />                                  once per webview root
  //   <button use:tip={'Chat history'}>…</button>      per control
  //   use:tip={{ text: '…', anchor: 'composer' }}      lines up with the composer
  //
  // `use:tip` REPLACES a native `title` — write one or the other, never both,
  // or the browser draws its own tooltip underneath this one. The label is
  // read at open time, so a label that changes needs no re-binding, and `''`
  // disables the tip for that control. Mount it ONCE: two mounted copies both
  // register as the sink and only the later one draws, which reads as a
  // tooltip that stopped working.
  //
  // Timings and the warm-window rule live in warmTip.ts, placement in
  // tipPlace.ts (both pure and unit-tested); this file owns only the element
  // and its look. The colours are --og-* tokens, NOT the react-bits browns:
  // against a blue-teal theme the brown read as a foreign panel, and its cream
  // text was near-invisible on the light `ember` theme.
  import { tip } from './warmTip';
  export { tip };
</script>

<script lang="ts">
  import { setTipSink, isWideLabel } from './warmTip';
  import { placeTip } from './tipPlace';
  import { onMount } from 'svelte';

  let text = $state('');
  let host: HTMLElement | null = $state(null);
  let box: HTMLDivElement | undefined = $state();
  let x = $state(0);
  let y = $state(0);
  let capped = $state(0); // a cap from the anchor box; 0 = the CSS cap applies
  let anchored = $state(false);

  onMount(() => setTipSink((node, label, anchor) => {
    host = node; text = label; anchored = anchor === 'composer';
  }));

  // Measure AFTER the text has landed: the box is width:max-content, so its
  // size is not knowable until it holds the label it is about to show.
  // Placement, including the composer case, is tipPlace.ts's.
  $effect(() => {
    void text;
    if (!host || !box) return;
    const area = anchored ? host.closest('.input-area') : null;
    const p = placeTip({
      host: host.getBoundingClientRect(),
      box: { w: box.offsetWidth, h: box.offsetHeight },
      area: area ? area.getBoundingClientRect() : null,
      view: { w: window.innerWidth, h: window.innerHeight },
    });
    x = p.x; y = p.y; capped = p.maxWidth;
  });
</script>

<div
  class="og-tip"
  class:is-in={!!host}
  class:is-wide={isWideLabel(text)}
  role="tooltip"
  aria-hidden={host ? undefined : 'true'}
  bind:this={box}
  style="left: {x}px; top: {y}px;{capped ? ` max-width: ${capped}px;` : ''}"
>{text}</div>

<style>
  .og-tip {
    position: fixed;
    z-index: 100000;
    padding: 5px 9px;
    border-radius: 7px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    color: var(--og-text);
    /* A theme surface sits close to whatever the tip floats over, so the lift
       the react-bits brown used to give is the shadow's job here. */
    box-shadow: 0 8px 22px color-mix(in srgb, var(--og-bg) 70%, transparent);
    font-size: 11px;
    line-height: 1.3;
    font-family: inherit;
    /* pre-line keeps explicit breaks and still wraps a long label.
       max-content keeps the box independent of how much room is left to the
       right edge; max-width then caps and wraps it. */
    white-space: pre-line;
    width: max-content;
    max-width: 240px;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    transform: translate(-50%, 4px) scale(0.96);
    filter: blur(3px);
    transition: opacity 160ms ease, transform 160ms cubic-bezier(0.22, 1, 0.36, 1), filter 160ms ease;
  }
  .og-tip.is-in {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
    filter: blur(0);
  }
  /* Long help text reads as a paragraph rather than a squeezed pill. */
  .og-tip.is-wide {
    max-width: 320px;
    text-align: left;
    line-height: 1.35;
  }
  @media (prefers-reduced-motion: reduce) {
    .og-tip { transition: opacity 160ms ease; transform: translate(-50%, 0); filter: none; }
    .og-tip.is-in { transform: translate(-50%, 0); }
  }
</style>
