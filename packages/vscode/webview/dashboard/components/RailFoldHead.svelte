<script lang="ts">
  // RailFoldHead.svelte (t-yyz5je) — the FOLDING HEADER of a rail pull-out, in
  // the round-8 mockup's rail language: one button, a chevron that turns, and
  // whatever the pull-out puts in it. The header stays when the list folds, so
  // the caller passes `peek` for the one-line summary it shows while shut.
  //
  // Shared on purpose: Side quests and Browser use it now, and the sub-agent
  // pull-out (R3) can take it without touching either of them. It owns no
  // state; the pull-out decides what "open" is.
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    onToggle: () => void;
    /** The header's content (title, count, url, chip). */
    children: Snippet;
    /** Shown only while folded, after the content. */
    peek?: Snippet;
  }
  let { open, onToggle, children, peek }: Props = $props();
</script>

<button class="rail-head" aria-expanded={open} onclick={onToggle}>
  <span class="rail-chev" class:open aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></svg>
  </span>
  {@render children()}
  {#if !open && peek}{@render peek()}{/if}
</button>

<style>
  .rail-head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-width: 0;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--og-text);
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    user-select: none;
  }
  .rail-chev { display: grid; flex: 0 0 auto; color: var(--og-text-muted); transition: transform 0.24s cubic-bezier(0.23, 1, 0.32, 1); }
  .rail-chev.open { transform: rotate(90deg); }
  .rail-chev svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  @media (prefers-reduced-motion: reduce) { .rail-chev { transition: none; } }
</style>
