<script lang="ts">
  // Sub-agents this chat has out, as a left-edge slide-out drawer. A
  // fan-out's only trace in the transcript is N tool cards that scroll away,
  // so this answers "is anything still running, and for how long".
  //
  // Left, not right: the right edge already belongs to the per-turn todo
  // overlay. The pull-tab interaction copies TodoStrip's; the top-strip
  // layout is its own, since this is an edge drawer.
  //
  // Collapsed by default: a background roster is something to consult, not
  // something that should cover the reply being read.
  //
  // Two levels of collapse, each on its own precedent: `open` (the whole
  // drawer) is session-persisted, since checking the roster is a deliberate
  // act worth remembering. `listOpen` (the row list) is plain local $state
  // and no longer resets between fan-outs, so settled rows persist.
  //
  // Two groups, Running and Complete, so a settled agent still gets a row
  // instead of vanishing from the roster; an empty band draws nothing. The
  // Complete band is a HISTORY (t-h8gv8w): nothing sweeps it and there is no
  // bulk clear, only the per-row × the owner presses on purpose.
  //
  // The EDGE HANDLE left for SubagentTab.svelte (t-dclj7z) when the panel head
  // gained the agent-map button.
  import { rosterSummary } from '../panes/subagentFormat';
  import { groupSubagents } from '../panes/subagentRows';
  import type { SubagentDrawerProps } from '../panes/subagentProps';
  import SubagentGroup from './SubagentGroup.svelte';
  import SubagentTab from './SubagentTab.svelte';
  import { createReveal, revealFirstRunning } from './subagentAutoOpen';
  import { tick } from 'svelte';

  // The prop SHAPE lives in subagentProps.ts — see that file's header.
  let { rows, open, onToggle, onDismiss, onOpen, onStop, onMap, limitMs = 0 }: SubagentDrawerProps = $props();

  const groups = $derived(groupSubagents(rows));
  const running = $derived(rows.filter((r) => r.state === 'running').length); // not the band: it holds queued too
  const summary = $derived(rosterSummary(rows));

  // Collapsed by default — see the header comment above.
  let listOpen = $state(false);
  // The COMPLETE band's own fold, shut by default. A finished roster is a
  // record, not a thing to watch: a chat that has spawned twenty agents over an
  // afternoon otherwise pushes the two that are still working off a 220px list.
  // It lives HERE, not in SubagentGroup.svelte, because the band is re-created
  // on every re-render of the roster (the drawer re-derives once a second while
  // anything is out) and a fold owned by the band would spring open on each
  // tick. Running never folds: hiding what is still working is the one thing
  // this drawer exists to prevent.
  let completeOpen = $state(false);

  // A CHILD GOING OUT REVEALS THE ROSTER, once, and never after the user has
  // shut this surface by hand. Both halves of that rule: subagentAutoOpen.ts.
  const reveal = createReveal();
  let groupsEl = $state<HTMLDivElement | null>(null); // the scroll box the first running row lives in
  $effect(() => {
    if (!reveal.arrived(groups.running.length)) return;
    listOpen = true;
    if (!open) onToggle();
    tick().then(() => revealFirstRunning(groupsEl));
  });
  /** Every way the user shuts this surface by hand. */
  const userCollapse = (next: () => void) => { reveal.stop(); next(); };
</script>

<!-- No rows, no drawer — not even the tab. A handle that opens onto "nothing
     running" is a permanent piece of furniture advertising an empty room. -->
{#if rows.length > 0}
  <aside class="sa-drawer" class:collapsed={!open}>
    <div class="sa-panel">
      <!-- The list's own fold: a real <button> header keeps the count visible
           even when collapsed, so a big roster costs one line until expanded. -->
      <div class="sa-head-row">
        <button class="sa-head" aria-expanded={listOpen} onclick={() => (listOpen ? userCollapse(() => (listOpen = false)) : (listOpen = true))}>
          <span class="sa-head-chevron" aria-hidden="true">{listOpen ? '▾' : '▸'}</span>
          <span class="sa-title">Sub-agents</span>
          <span class="sa-count">{summary}</span>
        </button>
        <!-- The map is offered from the PULL-OUT rather than from the chat's
             own chrome: it is a view OF this roster, so it belongs to the
             surface that lists it. Live session only — Labyrinth draws the
             history (SubagentMap.svelte). -->
        <button class="sa-map-btn" title="Open the agent map" aria-label="Open the agent map" onclick={onMap}>&#9737;</button>
      </div>
      {#if listOpen}
        <!-- ONE scroll region over both bands: two 220px lists would let a
             busy chat grow the panel past the chat cell it floats over. -->
        <div class="sa-groups" bind:this={groupsEl}>
          <!-- Stop reaches the RUNNING band only; the Complete band below gets no
               `onStop`, so a settled row cannot draw a control over a dead job. -->
          <SubagentGroup label="Running" rows={groups.running} {onDismiss} {onOpen} {onStop} {limitMs} />
          <SubagentGroup
            label="Complete"
            rows={groups.complete}
            collapsed={!completeOpen}
            onToggleCollapse={() => (completeOpen = !completeOpen)}
            {onDismiss}
            {onOpen}
            {limitMs}
          />
        </div>
      {/if}
    </div>
    <SubagentTab {open} {running} onToggle={() => (open ? userCollapse(onToggle) : onToggle())} />
  </aside>
{/if}

<style>
  /* Mirror of the todo overlay's geometry, flipped to the left edge. */
  .sa-drawer {
    position: absolute;
    top: 50%;
    left: 8px;
    transform: translateY(-50%);
    display: flex;
    align-items: stretch;
    width: min(240px, 80%);
    max-height: 60%;
    z-index: 6;
    transition: transform 0.22s ease;
  }
  /* Slide LEFT by the panel's width, leaving the tab on screen. The vertical
     centring has to be restated inside the same transform — a second
     `transform` rule would replace it, not compose with it, and the drawer
     would jump to the top of the pane on collapse. */
  .sa-drawer.collapsed {
    transform: translateY(-50%) translateX(calc(-100% + 18px));
  }

  .sa-panel {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* Belt-and-braces: .sa-groups caps and scrolls itself at 220px whatever the
       ancestor chain does, but if .sa-drawer's own 60% resolves smaller than
       that, clip here rather than spill past the panel's border. */
    overflow: hidden;
    padding: 7px 9px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-right: 4px solid var(--og-accent);
    border-radius: 6px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  }

  .sa-head-row { display: flex; align-items: baseline; gap: 4px; flex: 0 0 auto; margin-bottom: 5px; min-width: 0; }
  .sa-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .sa-head-chevron { flex: 0 0 auto; font-size: 8px; color: var(--og-text-muted); }
  .sa-title { font-size: 10.5px; font-weight: 600; color: var(--og-text); }
  .sa-count { font-size: 9px; color: var(--og-text-muted); }
  .sa-map-btn {
    flex: 0 0 auto;
    background: none; border: none; padding: 0 2px; border-radius: 3px;
    color: var(--og-text-muted); cursor: pointer; font-family: inherit; font-size: 12px; line-height: 1;
  }
  .sa-map-btn:hover { color: var(--og-text); background: var(--og-btn-bg); }

  /* Explicit px cap + its own scroll, INDEPENDENT of .sa-drawer's percentage
     max-height above: a fan-out of a dozen tasks must never grow the panel
     past the chat cell, whatever the ancestor chain's height resolves to. */
  .sa-groups {
    display: flex;
    flex-direction: column;
    gap: 7px;
    flex: 1 1 auto;
    min-height: 0;
    max-height: 220px;
    overflow-y: auto;
  }
</style>
