<script lang="ts">
  // InlineToast.svelte — t-qn0wj5, proposal 25 (port of Mock-Redesign
  // CHANGES.md #40's SwipeToast, react-bits Micro/SwipeToast). The webview's
  // own in-page toast, used by the density/backdrop switches (InsightsSettingsCards)
  // rather than a native VS Code notification: those confirmations are about a
  // setting the pane itself just changed, not something worth interrupting the
  // editor for.
  //
  // Two ways to dismiss: a downward swipe past 40px (pointer events, no
  // dependency), or the fuse burning out on its own after 4s. The fuse is a CSS
  // animation (`animationend` drives the auto-dismiss) rather than a JS rAF
  // loop, which is both simpler and, unlike the mock's canvas-free-but-still-JS
  // burn, trivially skippable under reduced motion: the animation is removed by
  // CSS and a plain setTimeout takes over for the SAME duration, so a toast
  // still goes away in 4s either way — reduced motion changes how it looks,
  // never whether it dismisses.
  interface Props {
    text: string;
    title?: string;
    onDismiss: () => void;
    reducedMotion?: boolean;
    /** An action taken BEFORE the fuse burns — "Undo" on a chat close
     *  (t-ru13hb item 2). Absent on every toast that only reports something,
     *  which is every earlier caller. */
    actionLabel?: string;
    onAction?: () => void;
  }
  let { text, title, onDismiss, reducedMotion = false, actionLabel, onAction }: Props = $props();

  const SWIPE_DISMISS_PX = 40;
  const FUSE_MS = 4000;

  let dy = $state(0);
  let dragging = $state(false);
  let y0 = 0;
  let dismissed = false;

  function dismissOnce() {
    if (dismissed) return;
    dismissed = true;
    onDismiss();
  }

  $effect(() => {
    if (!reducedMotion) return;
    const t = setTimeout(dismissOnce, FUSE_MS);
    return () => clearTimeout(t);
  });

  function pointerdown(e: PointerEvent) {
    y0 = e.clientY;
    dragging = true;
  }
  function pointermove(e: PointerEvent) {
    if (!dragging) return;
    dy = Math.max(0, e.clientY - y0);
    if (dy > SWIPE_DISMISS_PX) {
      dragging = false;
      dy = 0;
      dismissOnce();
    }
  }
  function pointerend() {
    dragging = false;
    dy = 0;
  }
</script>

<div
  class="og-toast"
  class:og-toast-swiping={dragging}
  style={dy ? `transform: translateY(${dy}px)` : undefined}
  role="status"
  aria-live="polite"
  onpointerdown={pointerdown}
  onpointermove={pointermove}
  onpointerup={pointerend}
  onpointercancel={pointerend}
>
  <div class="og-toast-body">
    {#if title}<div class="og-toast-title">{title}</div>{/if}
    <div class="og-toast-desc">{text}</div>
  </div>
  {#if actionLabel && onAction}
    <!-- Its own button, not the whole toast: a toast is swipeable and a
         pointerdown on the body starts that drag, so the action has to be a
         target of its own or a slight drag would fire it. -->
    <button class="og-toast-action" type="button" onclick={onAction}>{actionLabel}</button>
  {/if}
  {#if !reducedMotion}
    <div class="og-toast-fuse" onanimationend={dismissOnce}></div>
  {/if}
</div>

<style>
  .og-toast {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(300px, calc(100vw - 28px));
    padding: 10px 12px;
    overflow: hidden;
    border: 1px solid var(--og-border);
    border-radius: 10px;
    background: var(--og-surface);
    color: var(--og-text);
    font-size: 12px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    cursor: grab;
    touch-action: none;
    user-select: none;
    transition: transform 200ms ease;
  }
  .og-toast-swiping { cursor: grabbing; transition: none; }
  .og-toast-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .og-toast-title { font-weight: 600; font-size: 11px; color: var(--og-text); }
  .og-toast-desc { color: var(--og-text-secondary); font-size: 11px; line-height: 1.4; }
  .og-toast-action {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 3px 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-accent);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .og-toast-action:hover { background: var(--og-btn-hover); color: var(--og-chat); }
  .og-toast-action:focus-visible { outline: 2px solid var(--og-chat); outline-offset: 1px; }
  .og-toast-fuse {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    background: var(--og-warning);
    transform-origin: left center;
    animation: og-toast-burn 4000ms linear forwards;
    pointer-events: none;
  }
  @keyframes og-toast-burn {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .og-toast { transition: none; }
    .og-toast-fuse { animation: none; }
  }
</style>
