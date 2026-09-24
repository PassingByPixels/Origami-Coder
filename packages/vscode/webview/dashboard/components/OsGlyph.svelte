<script lang="ts">
  // OsGlyph.svelte — the OS mark on a desk row (t-s9jr6u, mock round 4).
  // PLACEHOLDERS, as in the mock: four squares for Windows, the command sign
  // for macOS, a prompt for Linux, a plain screen when the OS is not known.
  // The repo has no OS vendor marks yet (vendorMarks.ts holds AI vendors only).
  import { tip } from '../../shared/WarmTooltip.svelte';
  import { osWord, type DeskOs } from './nestsStatus';
  let { os }: { os: DeskOs } = $props();
</script>

<span class="os" use:tip={osWord(os)} data-os={os || 'unknown'}>
  {#if os === 'windows'}
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="5.5" height="5.5" rx=".6"/><rect x="8.5" y="2" width="5.5" height="5.5" rx=".6"/><rect x="2" y="8.5" width="5.5" height="5.5" rx=".6"/><rect x="8.5" y="8.5" width="5.5" height="5.5" rx=".6"/></svg>
  {:else if os === 'macos'}
    <svg viewBox="0 0 16 16" aria-hidden="true"><text x="8" y="13" text-anchor="middle" font-size="14" fill="currentColor">⌘</text></svg>
  {:else if os === 'linux'}
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6.5 8 3 11.5M8 12h5"/></svg>
  {:else}
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 14h4M8 11v3"/></svg>
  {/if}
</span>

<style>
  .os { width: 16px; height: 16px; flex: 0 0 auto; color: var(--og-text-secondary); display: inline-flex; }
  .os svg { width: 14px; height: 14px; display: block; margin: 1px; }
</style>
