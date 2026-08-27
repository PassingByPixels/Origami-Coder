<script lang="ts">
  // t-r7c757 — the new-chat empty state, extracted out of ChatPane.svelte
  // (which was sitting at its architecture cap) so the rotating-tip feature
  // had room to land. Mounted ONLY while ChatPane's `hasConversation` gate is
  // false (its own {#if}) — so this component's own mount lifecycle IS the
  // "stops forever at the first message" rule: Svelte destroys it the moment
  // a real turn lands, and the $effect below returns its clearInterval
  // teardown, so the rotation timer can never outlive the empty state. No
  // separate bookkeeping needed; nothing to duplicate here.
  //
  // W9 round 2 — A BOT CHAT OPENS UNDER ITS OWN CREATURE. The first ruling put
  // the glyph on the EDITOR TAB; it failed live UAT and was reversed (tabIcon.ts
  // records why). Here it is ordinary markup, so it is a component swap. Tips
  // untouched: the glyph says WHO, the tip says what you can do.
  import CraneMark from '../../shared/CraneMark.svelte';
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import { archetypeGlyph } from './archetypeGlyphs';
  import { EMPTY_STATE_TIPS, nextTipIndex, startTipIndex, PINNED_SETUP_TIP } from './emptyStateTips';

  interface Props {
    /** Honest connectivity for THIS chat (mirrors ChatPane's own online
     *  check) — drives the rotating tip vs the offline setup guidance. */
    online: boolean;
    providerLocal: boolean;
    providerLabel: string;
    /** t-r7c757 round 2 — true while this workspace has never been folded.
     *  Overrides online/offline entirely: pins PINNED_SETUP_TIP, no rotation. */
    needsSetup: boolean;
    /** The `glyph:` of the bot this chat runs AS, when it runs as one. */
    botGlyph?: string;
  }
  let { online, providerLocal, providerLabel, needsSetup, botGlyph }: Props = $props();

  // GATED ON THE TABLE, not the string — the ArchetypeGlyph house rule (a
  // caller that gates draws its OWN fallback). An unmapped id renders an
  // initial-letter TILE: right for a roster row, wrong for a 56px hero, where a
  // lone letter reads as a broken image. So an undrawn creature gets the crane.
  const creature = $derived(botGlyph && archetypeGlyph(botGlyph) ? botGlyph : '');

  // The ONLY call to Math.random in this feature. Kept out of
  // emptyStateTips.ts so its pure functions stay deterministic under test —
  // a component test can mock this one call site instead.
  let tipIndex = $state(startTipIndex(Math.random()));

  const TIP_INTERVAL_MS = 8000;
  $effect(() => {
    // An un-folded workspace pins ONE tip — no rotation to drive, so no
    // interval to schedule. Re-runs live if needsSetup flips (firstfoldDone).
    if (needsSetup) return;
    const id = setInterval(() => {
      tipIndex = nextTipIndex(tipIndex);
    }, TIP_INTERVAL_MS);
    return () => clearInterval(id);
  });
</script>

<div class="chat-empty">
  <!-- SAME wrapper, same 112px, same --og-crane: two chats must open with the
       hero in one place at one weight, or switching reads as the layout moving.
       Both marks are 64x64 currentColor, so the colour is inherited here.
       56 -> 112 (owner call): at 56 the brand mark read as an icon rather than
       the thing the empty pane is built around, and a menagerie creature's
       polygons were too small to tell one animal from another. Doubled on BOTH
       branches in one edit — a size that differs by branch is the layout
       jumping between two chats, which is what this wrapper exists to stop. -->
  <div class="chat-empty-crane" style="color: var(--og-crane)">
    {#if creature}
      <ArchetypeGlyph id={creature} size={112} />
    {:else}
      <CraneMark size={112} />
    {/if}
  </div>
  {#if needsSetup}
    <p class="chat-empty-hint chat-empty-tip">{PINNED_SETUP_TIP}</p>
  {:else if online}
    {#key tipIndex}
      <p class="chat-empty-hint chat-empty-tip">{EMPTY_STATE_TIPS[tipIndex]}</p>
    {/key}
  {:else}
    <p class="chat-empty-hint">
      {#if providerLocal}
        New here? Load your first model in the Setup panel.
      {:else}
        {providerLabel || 'Provider'} unreachable — check the server.
      {/if}
    </p>
    <p class="chat-empty-sub">
      Then run <code>/firstfold</code> to set up your workspace, and <code>/wrap</code> to close out each session.
    </p>
  {/if}
</div>

<style>
  /* Chat empty state — centred crane + honest hint, filling the thread
     area above the (untouched) composer. Themed entirely via --og-*
     tokens so it reads correctly in all four palettes. */
  .chat-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    min-height: 100%;
    padding: 32px 24px;
    text-align: center;
    box-sizing: border-box;
  }
  .chat-empty-crane {
    display: flex;
    line-height: 0;
    opacity: 0.9;
  }
  .chat-empty-hint {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--og-text);
    max-width: 30ch;
    line-height: 1.5;
  }
  .chat-empty-sub {
    margin: 0;
    font-size: 11px;
    color: var(--og-text-muted);
  }
  /* Tips run longer than the old fixed hint — a bit more width before wrap.
     The fade is a plain @keyframes rather than a CSS `transition`: {#key}
     recreates the element on each tip change, and a transition only fires
     on a property change of the SAME element. */
  .chat-empty-tip {
    max-width: 42ch;
    animation: chat-empty-tip-fade 320ms ease;
  }
  @keyframes chat-empty-tip-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-empty-tip {
      animation: none;
    }
  }
</style>
