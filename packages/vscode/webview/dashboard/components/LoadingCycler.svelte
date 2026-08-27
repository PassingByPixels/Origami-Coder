<script lang="ts">
  // B5 (production-readiness pass, 2026-06-06) — a small reusable
  // "working…" indicator. The KEY design rule: visibility is driven by
  // the parent's `active` prop, which the parent flips from real ACP
  // state events (stream start/done, model action started/actionDone),
  // NOT a blind timer. Only the *phrase text* rotates on a timer — a
  // cosmetic touch so a long wait doesn't look frozen. When the real
  // event lands, the parent sets active=false and this disappears, so
  // the indicator can never out-live the operation it describes.

  interface Props {
    active: boolean;
    /** Phrases to rotate through while active. */
    phrases?: string[];
    /** Optional static prefix, e.g. "Loading qwen…". */
    label?: string;
    /** Phrase rotation interval (ms). */
    interval?: number;
  }

  let {
    active,
    phrases = ['working…', 'thinking…', 'composing…'],
    label,
    interval = 1600,
  }: Props = $props();

  let idx = $state(0);

  $effect(() => {
    // Re-runs when `active`, `phrases`, or `interval` change.
    if (!active || phrases.length <= 1) {
      idx = 0;
      return;
    }
    const t = setInterval(() => {
      idx = (idx + 1) % phrases.length;
    }, interval);
    return () => clearInterval(t);
  });

  let current = $derived(phrases[idx % phrases.length] ?? '');
</script>

{#if active}
  <span class="loading-cycler" role="status" aria-live="polite">
    <span class="lc-spinner" aria-hidden="true"></span>
    <span class="lc-text">{label ? label + ' ' : ''}{current}</span>
  </span>
{/if}

<style>
  .loading-cycler {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-muted, #6c7086);
  }

  .lc-spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--og-border, #45475a);
    border-top-color: var(--og-accent, #89b4fa);
    border-radius: 50%;
    flex: 0 0 auto;
    animation: lc-spin 0.8s linear infinite;
  }

  .lc-text {
    animation: lc-pulse 1.4s ease-in-out infinite;
  }

  @keyframes lc-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes lc-pulse {
    0%, 100% { opacity: 0.55; }
    50%      { opacity: 1; }
  }
</style>
