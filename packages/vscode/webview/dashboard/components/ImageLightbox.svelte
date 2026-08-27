<script lang="ts">
  // ENLARGE-TO-FIT, and nothing else. A pasted screenshot is drawn at 48px in
  // the composer strip and at most 280x200 in the transcript, which is too
  // small to read the thing the screenshot was taken OF — so a click opens the
  // same picture at viewport size. No zoom, no pan, no gallery paging: the
  // whole feature is "show me that one, bigger", and every part beyond that
  // would be machinery with its own failure modes.
  //
  // WEBVIEW-LOCAL by construction. The `src` handed in is already a `data:`
  // URL held by the composer or the transcript row, so there is nothing to
  // fetch, nothing to ask the host for, and no $state proxy crossing
  // postMessage (which would throw DataCloneError).
  //
  // Mirrors ConfirmModal.svelte's overlay shape — fixed backdrop, window-level
  // Escape, click-through-to-close with stopPropagation on the content — so a
  // second dismissible overlay in this webview behaves like the first one.
  interface Props {
    /** The image to show. null / '' IS the shut state — there is no separate
     *  `open` flag to disagree with it. */
    src: string | null;
    /** Alt text of the image that was clicked, carried through so the enlarged
     *  copy is not less accessible than the thumbnail. */
    alt?: string;
    onClose: () => void;
  }
  let { src, alt = '', onClose }: Props = $props();

  // Guarded on `src` because <svelte:window> stays bound while this component
  // is mounted, and it is mounted for the whole life of the chat pane — an
  // unguarded handler would swallow Escape from every other surface.
  function onKey(e: KeyboardEvent) {
    if (!src) return;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if src}
  <div class="il-backdrop" role="presentation" onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img
      class="il-image"
      {src}
      alt={alt || 'Enlarged image'}
      onclick={(e) => e.stopPropagation()}
    />
    <!-- stopPropagation: the ✕ sits INSIDE the backdrop, so without it one
         press dispatches onClose twice (caught red by ImageLightbox.test.ts).
         Harmless while the parent only nulls a field, and a trap the moment it
         does anything else there. -->
    <button
      class="il-close"
      aria-label="Close image"
      onclick={(e) => { e.stopPropagation(); onClose(); }}
    >&times;</button>
  </div>
{/if}

<style>
  /* z-index 90: above every popover, dropdown and the question modal (≤ 60),
     below ConfirmModal's 100 — a confirm raised over a lightbox must still be
     the thing you can reach. The literal rgba is the same call ConfirmModal
     and QuestionModal make: a dimming veil is opacity over whatever is behind
     it, not a themed surface, so it is deliberately not an --og-* var and this
     file is deliberately not in THEMED_FILES. */
  .il-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.78);
    animation: il-fade 120ms ease-out;
  }
  /* `contain`, never `cover`: a cropped screenshot is a different picture from
     the one that was sent — the same rule the thumbnails already follow. */
  .il-image {
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border-radius: 6px;
    border: 1px solid var(--og-border);
  }
  .il-close {
    position: absolute;
    top: 12px;
    right: 16px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    line-height: 1;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .il-close:hover {
    background: var(--og-btn-hover);
  }
  @keyframes il-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .il-backdrop { animation: none; }
  }
</style>
