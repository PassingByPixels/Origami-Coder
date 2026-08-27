<script lang="ts">
  // Tweak 2 — while a turn is running, mirror the most recent user message as a
  // compact sticky header pinned to the top of the transcript, so the user can
  // always see what they last asked while agent output scrolls away below.
  // Display-only mirror: the real message row stays in the log; this never
  // removes or replaces it. Renders nothing when there is no text to pin.
  interface Props {
    /** The last user message's text. Empty string renders nothing. */
    text: string;
  }
  let { text }: Props = $props();
</script>

{#if text}
  <div class="pinned-user" title={text}>
    <span class="pinned-label">You:</span>
    <span class="pinned-text">{text}</span>
  </div>
{/if}

<style>
  /* Sticky inside the transcript scroll container: it sits at the very top and
     stays pinned as the agent's output scrolls under it. Compact, one line. */
  .pinned-user {
    position: sticky;
    top: 0;
    z-index: 6;
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0 0 8px 0;
    padding: 5px 10px;
    font-size: 11.5px;
    background: color-mix(in srgb, var(--og-surface, #1e1e2e) 92%, transparent);
    backdrop-filter: blur(3px);
    border: 1px solid var(--og-border);
    border-left: 3px solid var(--og-chat);
    border-radius: 5px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  }
  .pinned-label {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--og-chat);
  }
  .pinned-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--og-text-secondary);
  }
</style>
