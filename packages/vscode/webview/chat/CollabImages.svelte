<script lang="ts">
  // The images a human attached to a collab message, as thumbnails under the
  // bubble's text. Mirrors MessageRow.svelte's `.attached-images` idiom, so an
  // attachment reads the same in a chat and in a room.
  //
  // Its OWN component rather than a branch inside CollabMessageBubble.svelte,
  // which sat two lines under its architecture cap when this landed — the
  // ratchet's remedy is a module, never a raise.
  //
  // A `data:` URL is the whole picture, so there is nothing to fetch and
  // nothing to fail: an ABSENT `images` key (every message before this, and
  // every agent message) draws nothing at all, which is why the guard is on
  // presence rather than on a length that an absent field does not have.

  interface Props {
    /** `data:` URLs, straight off the wire. ABSENT on almost every message. */
    images?: string[];
  }
  let { images }: Props = $props();
</script>

{#if images && images.length > 0}
  <div class="cs-images">
    {#each images as src, i (i)}
      <img class="cs-image" {src} alt={`attachment ${i + 1}`} />
    {/each}
  </div>
{/if}

<style>
  .cs-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0 2px;
  }
  /* Bounded in BOTH directions: a tall screenshot must not push the rest of the
     turn off the pane, and a wide one must not force the bubble past its own
     max-width. `contain` rather than `cover` — a cropped screenshot is a
     different picture from the one that was sent. */
  .cs-image {
    max-width: 240px;
    max-height: 180px;
    border-radius: 6px;
    border: 1px solid var(--og-border);
    object-fit: contain;
  }
</style>
