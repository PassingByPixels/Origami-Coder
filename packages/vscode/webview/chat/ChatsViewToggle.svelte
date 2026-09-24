<script lang="ts">
  // t-s9k0q6 (round 7 rule 1): the "Here | Nest" control under the CHATS
  // label. Two equal segments, full width. Mounted ONLY while Nests is on and
  // another desk is registered (ChatsHereNest.svelte decides); the choice is
  // per viewer (webview state), not a setting. HistoryKindToggle.svelte is the
  // precedent for a small labelled control that decides nothing itself.
  import { tip } from '../shared/WarmTooltip.svelte';
  import NestGlyph from '../shared/NestGlyph.svelte';

  let { view, onChange, selfName, deskCount, running }: {
    view: 'here' | 'nest';
    onChange: (next: 'here' | 'nest') => void;
    /** This desk's name, for the Here tooltip ('' when the host did not say). */
    selfName: string;
    deskCount: number;
    /** Turns running on the other desks: the Nest segment's dot. */
    running: number;
  } = $props();

  const hereTip = $derived(selfName ? `Chats on this desk (${selfName})` : 'Chats on this desk');
  const nestTip = $derived(`Chats on the other desks: ${deskCount} desks in the nest${running ? `, ${running} turn${running === 1 ? '' : 's'} running` : ''}`);
</script>

<div class="chats-view-toggle" role="tablist" aria-label="Chats on this desk or on the other desks">
  <button role="tab" aria-selected={view === 'here'} onclick={() => onChange('here')} use:tip={hereTip}>Here</button>
  <button role="tab" aria-selected={view === 'nest'} onclick={() => onChange('nest')} use:tip={nestTip}>
    <NestGlyph />
    Nest
    {#if running}<span class="run-dot" aria-label="a turn is running on another desk"></span>{/if}
  </button>
</div>

<style>
  .chats-view-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    margin: 2px 12px 6px;
    padding: 2px;
    border: 1px solid var(--og-border);
    border-radius: 7px;
    background: var(--og-input-bg);
    flex-shrink: 0;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--og-text-muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  button:hover { color: var(--og-text); }
  button[aria-selected='true'] {
    background: var(--og-btn-hover);
    color: var(--og-text);
    font-weight: 600;
    box-shadow: 0 0 0 1px var(--og-border);
  }
  button:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .run-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--og-chat);
    animation: run-pulse 1.6s ease-in-out infinite;
  }
  @keyframes run-pulse { 50% { opacity: 0.45; } }
  @media (prefers-reduced-motion: reduce) { .run-dot { animation: none; } }
</style>
