<script lang="ts">
  // The composer's ATTACHED-IMAGE strip, extracted VERBATIM from
  // InputBar.svelte — the same move SamplingControl, SlashDropdown and
  // PinnedUserMessage made before it, and for the same reason: that file was at
  // its architecture cap when the collab composer needed the strip too.
  //
  // Purely presentational. Which images exist, how they were validated and
  // where they are sent all stay in the composer; this draws the row and
  // reports a click on an ✕.

  interface Props {
    /** The live attachments, in the order they were added. `id` is the
     *  composer's own key — stable across a removal, which an index is not. */
    images: { id: number; name: string; dataUrl: string }[];
    onRemove: (id: number) => void;
    /** Thumbnail clicked — the parent opens it enlarged. OPTIONAL, so a
     *  composer mounted with no lightbox above it keeps the old inert strip
     *  (and shows no zoom cursor promising one). The 48px thumb is `cover`,
     *  i.e. a CROP: without this the user cannot see what they attached. */
    onOpen?: (src: string, alt: string) => void;
  }
  let { images, onRemove, onOpen }: Props = $props();
</script>

<div class="image-strip">
  {#each images as img (img.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="image-thumb"><img class:zoomable={!!onOpen} src={img.dataUrl} alt={img.name} onclick={() => onOpen?.(img.dataUrl, img.name)} /><button class="image-remove" onclick={() => onRemove(img.id)}>&times;</button></div>
  {/each}
</div>

<style>
  .image-strip { display: flex; gap: 6px; padding: 6px 12px; overflow-x: auto; }
  .image-thumb { position: relative; width: 48px; height: 48px; border-radius: 4px; overflow: hidden; border: 1px solid var(--og-border); flex-shrink: 0; }
  .image-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .image-thumb img.zoomable { cursor: zoom-in; }
  .image-remove { position: absolute; top: 0; right: 0; width: 16px; height: 16px; background: var(--og-error); color: white; border: none; border-radius: 0 0 0 4px; font-size: 11px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
</style>
