<script lang="ts">
  // BrowserFilmFrame.svelte — ONE thumbnail of the browser strip: the picture,
  // its sequence number, and whether it is the newest.
  //
  // EXTRACTED from BrowserOverlay.svelte (t-qn0lpl) rather than raising that
  // file's 250-line cap: the fixed box, the crop, the badge and the accent came
  // to about fifty lines, and the seam is the one TodoRow.svelte already takes
  // against TodoStrip — the strip owns the drawer, the slide and the scroll, a
  // frame owns itself.
  import type { BrowserFrame } from '../panes/browserFrames';

  interface Props {
    frame: BrowserFrame;
    /** 1-based, so a frame can be NAMED in a sentence: the caption under the
     *  film says which one it describes, and this is how the eye finds it. */
    seq: number;
    newest: boolean;
    /** `<action> — <url>`, built once by the strip so the tooltip, the alt text
     *  and the lightbox caption are the same sentence. */
    label: string;
    onOpen: (src: string, alt: string) => void;
  }
  let { frame, seq, newest, label, onOpen }: Props = $props();
</script>

<button
  class="browser-frame"
  class:browser-frame-new={newest}
  title={label}
  aria-label={`Enlarge browser frame: ${label}`}
  onclick={() => onOpen(frame.imageDataUrl ?? '', label)}
>
  <img src={frame.imageDataUrl} alt={label} />
  <span class="browser-frame-seq" aria-hidden="true">{seq}</span>
</button>

<style>
  /* A FIXED box, so five frames read as five of the same thing rather than five
     different shapes. The aspect the picture loses to the crop is worth less
     than a strip the eye can scan; the lightbox has the whole shot. */
  .browser-frame {
    position: relative;
    flex: 0 0 auto;
    width: 104px;
    height: 66px;
    padding: 0;
    background: none;
    border: 1px solid var(--og-border);
    border-radius: 5px;
    overflow: hidden;
    cursor: zoom-in;
    line-height: 0;
    scroll-snap-align: start;
  }
  .browser-frame:hover { border-color: var(--og-accent); }
  /* The newest wears the accent: it is the one the header and the caption both
     describe, and on a twelve-frame strip that is not otherwise obvious.
     It also snaps to its END edge rather than its start (t-ru13hb item 4):
     under `scroll-snap-type: x mandatory` the strip re-snaps after the arrival
     scroll, and a `start` alignment on the last frame is a snap position that
     leaves it hanging off the right edge. `end` puts its own right edge flush
     with the strip's, at any strip width. */
  .browser-frame-new { border-color: var(--og-accent); scroll-snap-align: end; }
  .browser-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .browser-frame-seq {
    position: absolute;
    top: 2px;
    left: 2px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--og-surface);
    color: var(--og-text-secondary);
    font-size: 8.5px;
    font-variant-numeric: tabular-nums;
    line-height: 13px;
  }
</style>
