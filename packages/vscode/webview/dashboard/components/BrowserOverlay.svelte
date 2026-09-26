<script lang="ts">
  // What the agent is looking at, as a film strip — the right-rail peer that
  // sits directly above TodoOverlay.
  //
  // WHY IT EXISTS. Driving the integrated browser needs the page LAID OUT, so
  // browserPage.ts reveals it before every verb; until browserFocus.ts landed,
  // that reveal also took the user's cursor, and the browser tab jumped in
  // front of whatever they were doing on every click the agent made. Stopping
  // the focus theft leaves the page laid out somewhere the user is not looking,
  // so the frames come to the chat instead of the chat going to the page.
  //
  // A FLIPBOOK, NOT A VIEW. An extension webview cannot embed VS Code's browser
  // page, so this is screenshots — newest on the right, at most twelve
  // (browserFrames.ts). Nothing here claims to be live, and the caption says
  // which verb produced the newest frame so a stale strip reads as stale.
  //
  // The drawer idiom — pull-tab, parent-owned collapse, list stays MOUNTED
  // behind the slide — is TodoStrip.svelte's, deliberately: two pull-outs on
  // one rail that behaved differently would be two things to learn. It is
  // copied rather than shared because the todo drawer's panel is a tree with
  // its own row component and per-row collapse, and the only common part is
  // thirty lines of CSS (the call CollabTaskDrawer.svelte's own note records).
  import type { BrowserFrame } from '../panes/browserFrames';
  import BrowserFilmFrame from './BrowserFilmFrame.svelte';
  import BrowserViewportRow from './BrowserViewportRow.svelte';
  import RailFoldHead from './RailFoldHead.svelte';

  interface Props {
    /** Oldest first. The strip is only mounted when this is non-empty, so the
     *  newest-frame reads below need no guard. */
    frames: readonly BrowserFrame[];
    /** Owned by the PARENT (per session), so the choice survives the strip
     *  being unmounted and remounted — the same contract TodoOverlay has. */
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** Enlarge a thumbnail. The pane already mounts ONE ImageLightbox for every
     *  image in the chat, and a second enlarger for this one strip would be a
     *  second Escape handler and a second dismiss rule to keep in step. */
    onOpen: (src: string, alt: string) => void;
    /** Write the newest frame out and show it in the OS file explorer. The
     *  picture is never on disk until somebody asks, so the frame travels. */
    onReveal: (frame: BrowserFrame) => void;
  }
  let { frames, collapsed, onToggleCollapse, onOpen, onReveal }: Props = $props();

  const newest = $derived(frames[frames.length - 1]);
  // t-yyz5je: the header FOLDS the strip (the header stays, with a mini of the
  // newest frame); the tab HIDES the pull-out. Fold is view state, held here.
  let folded = $state(false);

  /** Where the agent is, and what it just did there. The url is the load-
   *  bearing half — an action alone does not say which page it acted on — so it
   *  leads, and the host caps it at 2 KB before it ever gets here. */
  const caption = $derived(newest?.url ?? newest?.pageText ?? 'browser');

  // Auto-scroll to the newest. The strip is a horizontal overflow box, so a new
  // frame lands off the right edge unless the box is told; keyed on the frame
  // COUNT rather than the array, because a re-render with the same frames must
  // not yank a user who has scrolled back to look at an earlier one.
  //
  // t-ru13hb item 4: `scrollLeft = scrollWidth` reached the end of the box but
  // did not SHOW the frame. The strip snaps `x mandatory`, so the browser
  // re-snapped to the nearest snap position and cut the newest frame off at the
  // right edge — the one frame the header and caption both describe. Scrolling
  // the ELEMENT into view at its end edge lands on the snap position the newest
  // frame now declares (`scroll-snap-align: end`, BrowserFilmFrame.svelte), so
  // the scroll and the snap ask for the same place instead of fighting.
  let stripEl = $state<HTMLDivElement | null>(null);
  let drawn = $state(0);
  $effect(() => {
    const n = frames.length;
    if (!stripEl || n === drawn) return;
    drawn = n;
    const newestEl = stripEl.lastElementChild as HTMLElement | null;
    // jsdom has no scrolling at all, hence the guard AND the fallback: a host
    // without scrollIntoView still lands at the end of the box.
    if (newestEl?.scrollIntoView) newestEl.scrollIntoView({ inline: 'end', block: 'nearest' });
    else stripEl.scrollLeft = stripEl.scrollWidth;
  });

  const label = (f: BrowserFrame) => `${f.action}${f.url ? ` — ${f.url}` : ''}`;
</script>

<aside class="browser-overlay">
  <div class="browser-strip" class:collapsed>
    <!-- Always mounted, in both states, so a shut drawer can be pulled back
         out — TodoStrip's rule, and the reason its own tab rides the slide. -->
    <button
      class="browser-tab"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Show browser preview' : 'Hide browser preview'}
      title={collapsed ? 'Show browser preview' : 'Hide browser preview'}
      onclick={onToggleCollapse}
    >
      <span class="browser-tab-glyph" aria-hidden="true">{collapsed ? '⟨' : '⟩'}</span>
      {#if collapsed}<span class="rail-tab-count">{frames.length}</span>{/if}
    </button>
    <div class="browser-panel">
      <!-- t-yyz5je: where the agent is + what it just did, as the rail's folding header. -->
      <div class="browser-header">
        <RailFoldHead open={!folded} onToggle={() => { folded = !folded; drawn = 0; }}>
          <span class="browser-icon" aria-hidden="true">◱</span>
          <span class="browser-caption" title={caption}>{caption}</span>
          <!-- The verb is a STATE, so it rides the header line as a chip. -->
          {#if newest}<span class="browser-action">{newest.action}</span>{/if}
          {#snippet peek()}<span class="browser-mini"><img src={newest.imageDataUrl} alt="" /></span>{/snippet}
        </RailFoldHead>
      </div>
      {#if !folded}
        <div class="browser-film" bind:this={stripEl}>
          {#each frames as frame, i (frame.seq)}
            <BrowserFilmFrame {frame} seq={i + 1} newest={i === frames.length - 1} label={label(frame)} {onOpen} />
          {/each}
        </div>
        <BrowserViewportRow {frames} {onReveal} />
      {/if}
    </div>
  </div>
</aside>

<style>
  /* A rail CHILD: ChatPane's .right-rail owns where the column is and how wide;
     this owns only how tall the band may get. Slim on purpose — the strip is
     something to glance at beside the chat, not a viewer. */
  .browser-overlay {
    width: 100%;
    max-height: 40%;
    overflow-y: auto;
    /* Clips the panel as it slides off toward the docked edge, the same way
       TodoOverlay clips its own drawer. */
    overflow-x: clip;
    flex: 0 0 auto;
    /* The rail itself is click-through (it is mounted even when empty). */
    pointer-events: auto;
  }
  /* Positioning shell with a gutter for the pull-tab; the visible panel is
     .browser-panel and slides right on collapse, leaving the tab behind. */
  .browser-strip {
    position: relative;
    padding: 0 0 0 16px;
    transition: transform 0.22s ease;
  }
  .browser-strip.collapsed {
    transform: translateX(calc(100% - 16px));
  }
  .browser-panel {
    padding: 6px 8px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-left: 4px solid var(--og-accent);
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    transition: box-shadow 0.22s ease;
  }
  /* A box-shadow spreads in every direction, so a panel that has slid off the
     edge would bleed its blur back on-screen without this. */
  .browser-strip.collapsed .browser-panel {
    box-shadow: none;
  }
  .browser-tab {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 44px;
    padding: 0;
    color: var(--og-text);
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 5px 0 0 5px;
    cursor: pointer;
  }
  .browser-tab:hover {
    color: var(--og-accent);
    border-color: var(--og-accent);
  }
  .browser-tab-glyph {
    font-size: 11px;
    line-height: 1;
  }
  .browser-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 10.5px;
    color: var(--og-text);
  }
  .browser-icon {
    color: var(--og-accent);
    opacity: 0.7;
  }
  .rail-tab-count { position: absolute; bottom: 3px; font-size: 8.5px; font-weight: 600; color: var(--og-accent); }
  .browser-mini { flex: 0 0 auto; width: 30px; height: 19px; border: 1px solid var(--og-border); border-radius: 3px; overflow: hidden; line-height: 0; }
  .browser-mini img { width: 100%; height: 100%; object-fit: cover; }
  /* ONE LINE, ellipsised from the LEFT. A url is long and the panel is 280px,
     and the end of a path is what tells one frame from another — `direction:
     rtl` puts the ellipsis at the front, where the scheme and host are the
     parts you already know. The full text is on the title attribute. */
  .browser-caption {
    direction: rtl;
    text-align: left;
    unicode-bidi: plaintext;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 0;
    font-weight: 400;
    font-size: 10px;
    color: var(--og-text);
  }
  /* A chip, not a word: the verb is the page's STATE after the agent acted. */
  .browser-action {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    height: 15px;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--og-btn-bg);
    color: var(--og-accent);
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .browser-film {
    display: flex;
    gap: 4px;
    margin-top: 5px;
    overflow-x: auto;
    scroll-behavior: smooth;
    scroll-snap-type: x mandatory;
  }
  @media (prefers-reduced-motion: reduce) {
    .browser-strip,
    .browser-panel {
      transition: none;
    }
    .browser-film {
      scroll-behavior: auto;
    }
  }
</style>
