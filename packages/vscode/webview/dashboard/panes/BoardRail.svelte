<script lang="ts">
  // BoardRail.svelte — the Agents board's left nav rail, extracted from
  // BoardShell.svelte (t-s9jr6u) when that file sat at 189 of its 190 cap and
  // the Settings view needed a second place on the rail: the FOOT.
  //
  // Two stacks around one flex spacer. The top stack is every VIEWS row in
  // table order; the foot is the rows marked `foot` (Settings, a real view with
  // an active state) and then Docs alone — a LINK to the website, never a view,
  // so it has no active state and never joins VIEWS (owner ruling).
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/WarmTooltip.svelte';
  import { DOCS_ICON } from './boardLinkIcons';
  import type { NavEntry, ViewId } from './boardViews';

  let { views, active, onSelect }: { views: NavEntry[]; active: ViewId; onSelect: (id: ViewId) => void } = $props();

  const vscode = getVsCodeApi();
  let top = $derived(views.filter((v) => !v.foot));
  let foot = $derived(views.filter((v) => v.foot));

  // Round-2 proposal 16 / CHANGES.md change 33: the rail expands on hover or
  // focus to full names, icons-only collapsed. JS state (not a `:hover` CSS
  // rule alone) so the expanded/collapsed state is a DOM class a test can
  // assert directly — jsdom has no layout engine to prove a width transition.
  let expanded = $state(false);

  // t-selspn: a dot on Nests while the mother base's tail pulls (`tail` rides every nest index push).
  let tailing = $state(false);
  $effect(() => {
    const on = (e: MessageEvent) => { if (e.data?.type === 'origami/nestIndex') tailing = e.data.tail?.running === true; };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  });
</script>

{#snippet navButton(v: NavEntry)}
  <button
    class="nav-btn"
    class:active={active === v.id}
    data-view-id={v.id}
    use:tip={v.title}
    aria-label={v.title}
    aria-current={active === v.id ? 'page' : undefined}
    onclick={() => onSelect(v.id)}
  >
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{@html v.icon}</svg>
    <span class="nav-label">{expanded ? v.name : v.label}</span>
    {#if v.id === 'nests' && tailing}<span class="sync-dot" data-tailing aria-label="Syncing chats to the mother base"></span>{/if}
  </button>
{/snippet}

<nav class="board-nav" class:rail-expanded={expanded} aria-label="Board views"
  onpointerenter={() => (expanded = true)} onpointerleave={() => (expanded = false)}
  onfocusin={() => (expanded = true)} onfocusout={() => (expanded = false)}>
  {#each top as v (v.id)}{@render navButton(v)}{/each}
  <div class="nav-spacer"></div>
  {#each foot as v (v.id)}{@render navButton(v)}{/each}
  <!-- Docs: a link out to the website, not a pane. The URL is host-owned —
       see botsManager's boardOpenDocs. -->
  <button
    class="nav-btn"
    use:tip={'Docs — the Origami website'}
    aria-label="Docs — opens the Origami website in your browser"
    onclick={() => vscode.postMessage({ type: 'boardOpenDocs' })}
  >
    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">{@html DOCS_ICON}</svg>
    <span class="nav-label">Doc</span>
  </button>
</nav>

<style>
  .board-nav {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    width: 48px;
    flex-shrink: 0;
    padding: 8px 0;
    border-right: 1px solid var(--og-border);
    background: var(--og-bg);
    /* The rail SCROLLS rather than squashing. Fifteen views plus Docs need
       ~630px, and an editor tab in a split row is routinely shorter than that;
       without this the flex children shrink and the icons crush into slivers,
       which is a silent failure — nothing disappears, everything just stops
       being legible. Paired with flex-shrink:0 below, which is what makes the
       overflow real instead of absorbed. */
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    transition: width 150ms ease;
  }
  /* Expand on hover/focus (proposal 16 / change 33): full names, LineSidebar
     look, minus its proximity falloff. */
  .board-nav.rail-expanded { width: 168px; }
  .board-nav::-webkit-scrollbar { width: 0; }
  .nav-btn {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    flex-shrink: 0;
    padding: 0 0 0 11px;
    background: transparent;
    color: var(--og-text-secondary);
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
  }
  .nav-btn:hover:not(.active) {
    background: var(--og-btn-bg);
    color: var(--og-text);
  }
  .nav-btn.active {
    background: var(--og-accent);
    color: var(--og-text);
    border-color: transparent;
  }
  .nav-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }
  .nav-label {
    font-size: 11px;
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    transition: max-width 150ms ease;
  }
  .board-nav.rail-expanded .nav-label { max-width: 110px; }
  .sync-dot { position: absolute; top: 5px; left: 26px; width: 6px; height: 6px; border-radius: 50%; background: var(--og-success); }
  .nav-spacer {
    flex: 1;
  }
</style>
