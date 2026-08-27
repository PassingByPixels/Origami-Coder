<script lang="ts">
  // Tweak 3 (0.2.176) — a small origami animal that rotates through the brand
  // menagerie while a model is streaming its reasoning. Reuses the existing
  // ArchetypeGlyph renderer + archetypeGlyphs data (no new SVGs). Visibility +
  // the rotation timer are driven ENTIRELY by the `active` prop, which the
  // parent flips from real ACP state (a thought is only "live" while it streams
  // in an in-flight turn). The $effect owns a single setInterval and returns its
  // clearInterval teardown, so the timer can never out-live `active` — Svelte
  // runs the teardown when `active` flips false or the component unmounts.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';

  interface Props {
    active: boolean;
    /** Glyph edge length in px. */
    size?: number;
    /** Swap interval (ms). Default 720ms — inside the 600–900ms band: brisk
     *  enough to feel alive, slow enough to register each animal. */
    interval?: number;
  }

  let { active, size = 14, interval = 720 }: Props = $props();

  // The full brand menagerie: crane, dragon, elephant, cat, fox, wolf, deer.
  // Each id maps to a real harvested glyph in archetypeGlyphs.ts.
  const IDS = ['tsuru', 'plan', 'architect', 'ask', 'debug', 'orchestrator', 'cartographer'];

  let idx = $state(0);

  $effect(() => {
    if (!active) {
      idx = 0;
      return;
    }
    const t = setInterval(() => {
      idx = (idx + 1) % IDS.length;
    }, interval);
    return () => clearInterval(t);
  });
</script>

{#if active}
  <span class="thinking-glyph" aria-hidden="true">
    <ArchetypeGlyph id={IDS[idx]} size={size} />
  </span>
{/if}

<style>
  /* Brand contrast tint + a gentle pulse so the swap reads as a soft cross-fade
     rather than a hard cut. Small and inline — it sits next to the thought label. */
  .thinking-glyph {
    display: inline-flex;
    align-items: center;
    color: var(--og-chat);
    animation: tg-pulse 0.72s ease-in-out infinite;
  }
  @keyframes tg-pulse {
    0%, 100% { opacity: 0.55; }
    50%      { opacity: 1; }
  }
</style>
