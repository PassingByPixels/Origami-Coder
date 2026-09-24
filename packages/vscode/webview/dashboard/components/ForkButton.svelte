<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // The composer's FORK trigger (t-v5qv6u) — immediately left of the
  // second-opinion scales. It replaced the `/btw` slash command, which wrote a
  // '/btw' user row into the chat being forked.
  //
  // Its own leaf on SecondOpinionButton.svelte's pattern: the glyph is inline
  // (one node on top, two below, the branch between them) because the webview
  // ships no icon library. It owns NO state and posts nothing itself: the row
  // posts, so the message and the chat it names are decided in one place.
  interface Props {
    /** A turn is running. A fork copies the stored transcript, and a turn
     *  still being written would be cut at an arbitrary point. */
    disabled?: boolean;
    onFork: () => void;
  }
  let { disabled = false, onFork }: Props = $props();
</script>

<button
  class="fork-chat"
  aria-label="Fork chat"
  {disabled}
  use:tip={disabled
    ? 'Fork — available once the current turn finishes'
    : 'Fork — open a copy of this chat in a new tab. This chat does not change.'}
  onclick={onFork}
>
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="19" r="2" />
    <path d="M6 7v10" />
    <path d="M6 12c0 3 12 1 12 5" />
  </svg>
</button>

<style>
  /* The scales' idiom exactly: the two sit shoulder to shoulder, and a
     different resting weight would read as one of them being lit. The row
     positions the group (ComposerUtilityRow's `.row-end`). */
  .fork-chat {
    display: inline-flex;
    align-items: center;
    padding: 1px 5px;
    font: inherit;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    opacity: 0.8;
  }
  .fork-chat:hover:not(:disabled) { opacity: 1; color: var(--og-text-secondary); border-color: var(--og-border); }
  .fork-chat:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .fork-chat:disabled { opacity: 0.35; cursor: default; }
</style>
