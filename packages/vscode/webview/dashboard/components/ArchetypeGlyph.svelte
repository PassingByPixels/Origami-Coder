<script lang="ts">
  // Agent Manager (S11): the brand-menagerie glyph for a typed archetype — a
  // small, muted origami animal drawn beside the agent-type label (card + create
  // form). Data lives in archetypeGlyphs.ts; this just renders the polygon list
  // in currentColor so it matches the surrounding text.
  //
  // Folds Board D7: callers gating on archetypeGlyph(id) !== null (CollabStream/
  // CollabRoster/AgentTypeSelect draw their OWN fallback disc) never reach the
  // else below. An unconditional caller used to draw nothing for an unmapped
  // id; it now gets a letter tile, so no card is ever left with an empty slot.
  import { archetypeGlyph } from './archetypeGlyphs';
  interface Props { id: string; size?: number; }
  let { id, size = 12 }: Props = $props();
  let glyph = $derived(archetypeGlyph(id));
  let letter = $derived((id.replace(/^collab-/, '')[0] ?? '?').toUpperCase());
</script>

{#if glyph}
  <svg class="am-glyph" style="width: {size}px; height: {size}px" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    {#each glyph as poly (poly.pts)}<polygon points={poly.pts} opacity={poly.op} />{/each}
  </svg>
{:else}
  <span class="am-glyph-tile" style="width: {size}px; height: {size}px; font-size: {size * 0.55}px">{letter}</span>
{/if}

<style>
  .am-glyph { flex: none; align-self: center; }
  .am-glyph-tile {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    align-self: center;
    border-radius: 4px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    font-weight: 700;
  }
</style>
