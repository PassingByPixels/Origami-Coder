<script lang="ts">
  // BrowserViewportRow.svelte — the line UNDER the film strip: what size the
  // newest picture is, and the way out to the picture itself (t-qn0lpl).
  //
  // ITS OWN FILE rather than ten more lines in BrowserOverlay.svelte, which was
  // at 239 of its 250-line cap: the ratchet's remedy is an extraction, not a
  // raise. The seam is real — the overlay owns the drawer, its slide and the
  // film; this owns one caption and one button.
  //
  // WHAT THE CAPTION IS FOR. A screenshot with no dimensions cannot be compared
  // with anything: two frames of the same page at two viewports look identical
  // at 104px wide. The number is the HOST's (src/browserSnapshot.ts attaches the
  // viewport the capture was taken at), never a measurement of the decoded
  // <img> — that answers how big the bitmap is, not what size the page was.
  import { viewportCaption, type BrowserFrame } from '../panes/browserFrames';

  interface Props {
    /** Oldest first, exactly as the strip holds them. */
    frames: readonly BrowserFrame[];
    /** Ask for the newest frame to be written out and shown in the OS file
     *  explorer. The frame is passed whole because the BYTES are what has to
     *  travel: the picture is never on disk until somebody asks for it. */
    onReveal: (frame: BrowserFrame) => void;
  }
  let { frames, onReveal }: Props = $props();

  const caption = $derived(viewportCaption(frames));
  const newest = $derived(frames[frames.length - 1]);
</script>

{#if caption}
  <div class="browser-viewport">
    <span class="browser-viewport-size">{caption}</span>
    <!-- stopPropagation: the panel around this is itself a click target. -->
    <button
      class="browser-reveal"
      title="Save this frame and show it in the file explorer"
      onclick={(e) => { e.stopPropagation(); onReveal(newest); }}
    >&#9649; Reveal shot</button>
  </div>
{/if}

<style>
  .browser-viewport {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
    color: var(--og-text-muted);
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }
  /* Quiet until pointed at, like the Todo panel's own Clear control: the border
     is transparent rather than absent, so hovering never moves the box. */
  .browser-reveal {
    margin-left: auto;
    flex: 0 0 auto;
    height: 16px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--og-text-muted);
    font: inherit;
    font-size: 9px;
    cursor: pointer;
  }
  .browser-reveal:hover { color: var(--og-text); border-color: var(--og-border); }
</style>
