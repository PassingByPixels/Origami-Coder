<script lang="ts">
  // The composer's CONNECTIVITY STRIP: the line above the model bar that stands
  // until THIS chat's provider confirms a model.
  //
  // Its own file on the ModeControl / ChangesPill precedent — the composer is a
  // stack of strips and each strip is a leaf — and because the RULE behind it
  // was already one (modelBanner.ts). A pure .ts that decides plus a .svelte
  // that draws is the shape every other composer control here has; this closes
  // the pair, and it is what let InputBar.svelte take a new wrapper without its
  // cap moving.
  //
  // What this file must never do is cry wolf. `ok: false` means BOTH "asked and
  // got nothing" and "have not asked yet", and only the first is the user's
  // problem — modelBanner.ts owns that split, this file only dresses it.
  import { bannerState, probingText } from './modelBanner';

  interface Props {
    /** A model answered for this chat. With one, there is no strip at all. */
    online?: boolean;
    /** The harness's own words for why not — also the strip's tooltip. */
    reason?: string;
    /** The provider being waited on, named in the neutral probing line. */
    providerLabel?: string;
    /** Loopback LM Studio vs a named remote: they get different instructions. */
    providerIsLocal?: boolean;
  }
  let { online = false, reason = '', providerLabel = '', providerIsLocal = true }: Props = $props();

  const banner = $derived(bannerState(online, reason, providerIsLocal));
</script>

{#if banner !== 'ok'}
  <div class="model-warning" class:probing={banner === 'probing'}
    title={banner === 'probing' ? 'Waiting for the provider to answer — this settles on its own.' : (reason || 'No model reported by the harness yet.')}>
    <span class="warn-dot"></span>
    <span class="warn-text">
      {#if banner === 'probing'}
        {probingText(providerLabel)}
      {:else if providerIsLocal}
        No model detected yet — start LM Studio and type a message to retry.
      {:else}
        {providerLabel || 'Provider'} unreachable — check the server, then type a message to retry.
      {/if}
    </span>
  </div>
{/if}

<style>
  /* Carried VERBATIM from InputBar.svelte — an extraction that also restyled
     would make the two changes impossible to tell apart in a screenshot. */
  .model-warning { display: flex; align-items: center; gap: 8px; padding: 4px 12px; background: rgba(251, 191, 36, 0.12); border-bottom: 1px solid var(--og-border); }
  /* PROBING is not a warning. It keeps the row (so the composer does not jump
     when the verdict lands) and drops every alarm cue: no amber wash, no glow,
     a muted dot. The pulse stays — something IS still happening. */
  .model-warning.probing { background: transparent; }
  .warn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--og-warning); box-shadow: 0 0 6px var(--og-warning); flex-shrink: 0; animation: pulse 1.6s infinite; }
  .model-warning.probing .warn-dot { background: var(--og-text-muted); box-shadow: none; }
  .warn-text { font-size: 10px; color: var(--og-text-secondary); }
  .model-warning.probing .warn-text { color: var(--og-text-muted); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
</style>
