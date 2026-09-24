<script lang="ts">
  // THE INVITE QR IS BLACK ON WHITE AND STAYS THAT WAY.
  //
  // Its own component for exactly the reason RemotePairCard.svelte is kept out
  // of the themed-files list: a QR needs a real white ground behind real black,
  // some phone cameras refuse a tinted one, and contrast here is a FUNCTION and
  // not a decoration. Isolating the two literals means every other file in this
  // feature can still be held to theme vars only.
  //
  // The SVG string is built host-side by src/remote/qr.ts (the webview tsconfig
  // does not see src/), so this component only frames what it is handed.

  interface Props {
    /** An `<svg>…</svg>` string, or '' when the invite was too long to encode. */
    svg: string;
  }
  let { svg }: Props = $props();
</script>

{#if svg}
  <div class="qr" role="img" aria-label="Your flock invite as a QR code">{@html svg}</div>
{:else}
  <p class="qr-none">Too long for a QR — send the text below instead.</p>
{/if}

<style>
  /* ONE size, and it is 216px rather than the tile grid's old 116. A real v2
     invite is 162 bytes bare and 190 with the relay segment, which the encoder
     puts at version 9 and 10: a 61- to 65-module span once the SVG's 4-module
     quiet zone is counted. The 116px tile gave 1.5 CSS px per module — a
     picture of a QR, not a QR. 216px (200px inside the padding) gives 3.1 to
     3.3, the most this tile can carry; see the report for what would buy more. */
  .qr { width: 100%; max-width: 216px; aspect-ratio: 1; background: #ffffff; border-radius: 8px; padding: 8px; box-sizing: border-box; }
  .qr :global(svg) { width: 100%; height: 100%; display: block; }
  .qr-none { margin: 0; font-size: 11px; color: var(--og-text-secondary); }
</style>
