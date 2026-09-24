<script module lang="ts">
  let nextId = 0;
</script>

<script lang="ts">
  // HELP POPOVER (t-vbj8xu): a "?" beside a pane title that opens a heading,
  // a few short lines and a diagram. It has the warm tooltip's look and timings
  // (WarmTooltip.svelte, warmTip.ts, tipPlace.ts), but a box of its own: the
  // warm tip is one shared, text-only label that the pointer passes through,
  // and this box holds a figure the pointer may rest on.
  //
  // Opens: hover (after TIP_FUSE), click, Enter or Space (a native button).
  // Closes: the pointer leaves the icon and the box (after TIP_GRACE), a second
  // click, Escape, or focus leaving the icon. A click pins it open against the
  // pointer leaving. No native `title` (nativeTitleGuard.test.ts).
  //
  // The diagram classes (.box, .line-hi, ...) mirror the What's-new figures in
  // src/dashboard/changelogPanel.ts; helpPopover.test.ts fails when they drift.
  import type { Snippet } from 'svelte';
  import { TIP_FUSE, TIP_GRACE } from './warmTip';
  import { tipPlacement } from './tipPlace';

  interface Props {
    /** The icon's accessible name, e.g. "How artifacts work". */
    label: string;
    heading: string;
    lines: string[];
    /** The diagram: one inline <svg role="img" aria-label=...>. */
    children: Snippet;
  }
  let { label, heading, lines, children }: Props = $props();

  const id = `og-help-${++nextId}`;
  let open = $state(false);
  let pinned = $state(false);
  let wrap: HTMLSpanElement | undefined = $state();
  let btn: HTMLButtonElement | undefined = $state();
  let box: HTMLDivElement | undefined = $state();
  let x = $state(0);
  let y = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    clearTimeout(timer);
    open = false;
    pinned = false;
  }
  function enter(): void {
    clearTimeout(timer);
    if (!open) timer = setTimeout(() => (open = true), TIP_FUSE);
  }
  function leave(): void {
    clearTimeout(timer);
    if (!pinned) timer = setTimeout(() => (open = false), TIP_GRACE);
  }
  function toggle(): void {
    if (pinned) return close();
    clearTimeout(timer);
    open = true;
    pinned = true;
  }
  function focusOut(e: FocusEvent): void {
    const to = e.relatedTarget as Node | null;
    if (!to || !wrap?.contains(to)) close();
  }
  function key(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') { e.preventDefault(); close(); }
  }
  function place(): void {
    if (!btn || !box) return;
    const p = tipPlacement(btn.getBoundingClientRect(), box.offsetWidth, box.offsetHeight, window.innerWidth, window.innerHeight);
    x = p.x;
    y = p.y;
  }

  // Placed when it opens, and again while open if the pane scrolls or resizes.
  $effect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  });
  $effect(() => () => clearTimeout(timer));
</script>

<svelte:window onkeydown={key} />

<span class="og-help" bind:this={wrap} onmouseenter={enter} onmouseleave={leave} onfocusout={focusOut} role="presentation">
  <button
    class="og-help-btn"
    type="button"
    bind:this={btn}
    aria-label={label}
    aria-expanded={open}
    aria-controls={id}
    aria-describedby={id}
    onclick={toggle}
  >?</button>
  <div class="og-help-box" class:is-in={open} {id} role="tooltip" bind:this={box} style="left: {x}px; top: {y}px;">
    <p class="og-help-head">{heading}</p>
    {#each lines as line}<p class="og-help-line">{line}</p>{/each}
    <div class="og-help-fig">{@render children()}</div>
  </div>
</span>

<style>
  .og-help { display: inline-flex; align-items: center; }
  .og-help-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--og-border);
    border-radius: 50%;
    background: transparent;
    color: var(--og-text-muted);
    font: 600 10px/1 var(--vscode-font-family, inherit);
    cursor: help;
  }
  .og-help-btn:hover,
  .og-help-btn[aria-expanded='true'] { color: var(--og-text); border-color: var(--og-text-muted); }
  .og-help-btn:focus-visible { outline: 1px solid var(--og-accent); outline-offset: 2px; }
  /* The warm tooltip's box (WarmTooltip.svelte), wider and left-aligned. */
  .og-help-box {
    position: fixed;
    z-index: 100000;
    box-sizing: border-box;
    width: min(300px, calc(100vw - 16px));
    padding: 10px 12px 12px;
    border-radius: 7px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    color: var(--og-text);
    box-shadow: 0 8px 22px color-mix(in srgb, var(--og-bg) 70%, transparent);
    font-size: 11.5px;
    line-height: 1.4;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    pointer-events: none;
    visibility: hidden;
    opacity: 0;
    transform: translate(-50%, 4px) scale(0.96);
    filter: blur(3px);
    transition: opacity 160ms ease, transform 160ms cubic-bezier(0.22, 1, 0.36, 1), filter 160ms ease, visibility 0s linear 160ms;
  }
  .og-help-box.is-in {
    pointer-events: auto;
    visibility: visible;
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
    filter: blur(0);
    transition-delay: 0s;
  }
  .og-help-head { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
  .og-help-line { margin: 0 0 2px; color: var(--og-text-secondary); }
  .og-help-fig { margin-top: 8px; }
  .og-help-fig :global(svg) { display: block; width: 100%; height: auto; }
  /* The house diagram style: the same rules as .wn-fig in changelogPanel.ts. */
  .og-help-fig :global(svg text) { fill: var(--og-text); font-family: var(--vscode-font-family); font-size: 12px; }
  .og-help-fig :global(svg .t-muted) { fill: var(--og-text-secondary); }
  .og-help-fig :global(svg .t-small) { font-size: 10.5px; }
  .og-help-fig :global(svg .t-title) { font-weight: 600; }
  .og-help-fig :global(svg .t-on) { fill: var(--og-bg); font-weight: 600; }
  .og-help-fig :global(svg .box) { fill: var(--og-surface); stroke: var(--og-border); stroke-width: 1.2; }
  .og-help-fig :global(svg .box-hi) { fill: var(--og-surface); stroke: var(--og-chat); stroke-width: 1.8; }
  .og-help-fig :global(svg .box-dim) { fill: var(--og-surface-alt); stroke: var(--og-border); stroke-width: 1.2; stroke-dasharray: 4 3; }
  .og-help-fig :global(svg .fill-chat) { fill: var(--og-chat); }
  .og-help-fig :global(svg .line) { fill: none; stroke: var(--og-text-muted); stroke-width: 1.4; }
  .og-help-fig :global(svg .line-hi) { fill: none; stroke: var(--og-chat); stroke-width: 1.8; }
  .og-help-fig :global(svg .dash) { stroke-dasharray: 4 4; }
  .og-help-fig :global(svg .head) { fill: var(--og-text-muted); }
  .og-help-fig :global(svg .head-hi) { fill: var(--og-chat); }
  @media (prefers-reduced-motion: reduce) {
    .og-help-box { transition: opacity 160ms ease, visibility 0s linear 160ms; transform: translate(-50%, 0); filter: none; }
    .og-help-box.is-in { transform: translate(-50%, 0); transition-delay: 0s; }
  }
</style>
