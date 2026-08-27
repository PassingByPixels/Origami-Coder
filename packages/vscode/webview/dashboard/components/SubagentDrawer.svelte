<script lang="ts">
  // The sub-agents this chat has out, as a LEFT-edge slide-out drawer.
  //
  // WHY IT EXISTS. A fan-out puts N sub-agents to work and the only trace of
  // them in the transcript is N tool cards, which scroll away. "Is anything
  // still running, and how long has it been?" then had no answer short of
  // scrolling back and reading statuses one at a time.
  //
  // WHY LEFT. The right edge already belongs to the per-turn todo overlay. Two
  // panels fighting for the same corner is worse than either.
  //
  // The pull-tab INTERACTION is TodoStrip's (a persistent tab, the panel
  // sliding off toward its docked edge, the list always mounted so reopening is
  // instant). Its top-strip LAYOUT is not: this is an edge drawer, so the
  // geometry is its own and the two are copied, not factored — the same call
  // CollabTaskDrawer.svelte's cap comment already records for the right edge.
  //
  // Collapsed by DEFAULT: a background roster is a thing you consult, not a
  // thing that should cover the reply you are reading.
  //
  // TWO LEVELS OF COLLAPSE (t-kgryh1 polish), on purpose, each following a
  // DIFFERENT existing precedent:
  //   `open` — the whole drawer sliding to/from the edge — is SESSION-
  //     PERSISTED (cellSession.subagentsOpen in ChatPane), because "let me
  //     check the roster" is a deliberate act worth remembering across turns,
  //     the same reasoning TodoOverlay's own collapse already carries.
  //   `listOpen` below — the ROW LIST inside an open panel — is plain local
  //     $state, CollabTaskDrawer.svelte's precedent ("a drawer is a glance,
  //     not a setting"). It no longer resets between fan-outs: settled rows
  //     persist now, so the {#if} below stops unmounting this component.
  //
  // TWO GROUPS, Running and Complete (groupSubagents in subagentRows.ts): a
  // settled agent used to have no row at all, so the drawer emptied itself
  // exactly when you wanted to read what it did. An empty band draws nothing.
  import { rosterSummary } from '../panes/subagentFormat';
  import { groupSubagents, type SubagentRow as SubagentRowT } from '../panes/subagentRows';
  import SubagentGroup from './SubagentGroup.svelte';

  interface Props {
    rows: SubagentRowT[];
    open: boolean;
    onToggle: () => void;
    onDismiss: (key: string) => void;
    onOpen: (row: SubagentRowT) => void;
  }
  let { rows, open, onToggle, onDismiss, onOpen }: Props = $props();

  const groups = $derived(groupSubagents(rows));
  const running = $derived(rows.filter((r) => r.state === 'running').length); // not the band: it holds queued too
  const summary = $derived(rosterSummary(rows));

  // Collapsed by default — see the header comment above.
  let listOpen = $state(false);
</script>

<!-- No rows, no drawer — not even the tab. A handle that opens onto "nothing
     running" is a permanent piece of furniture advertising an empty room. -->
{#if rows.length > 0}
  <aside class="sa-drawer" class:collapsed={!open}>
    <div class="sa-panel">
      <!-- The list's own fold: a real <button> header (count always visible,
           collapsed or not) so a roster of many tasks costs one line until
           asked to expand. -->
      <button class="sa-head" aria-expanded={listOpen} onclick={() => (listOpen = !listOpen)}>
        <span class="sa-head-chevron" aria-hidden="true">{listOpen ? '▾' : '▸'}</span>
        <span class="sa-title">Sub-agents</span>
        <span class="sa-count">{summary}</span>
      </button>
      {#if listOpen}
        <!-- ONE scroll region over both bands: two 220px lists would let a
             busy chat grow the panel past the chat cell it floats over. -->
        <div class="sa-groups">
          <SubagentGroup label="Running" rows={groups.running} {onDismiss} {onOpen} />
          <SubagentGroup label="Complete" rows={groups.complete} {onDismiss} {onOpen} />
        </div>
      {/if}
    </div>
    <!-- The handle rides with the panel so it lands flush at the docked edge,
         and is always present so a hidden drawer can be pulled back out. -->
    <button
      class="sa-tab"
      aria-expanded={open}
      aria-label={open ? 'Hide sub-agents' : `Show sub-agents (${running} running)`}
      title={open ? 'Hide sub-agents' : `${running} sub-agent${running === 1 ? '' : 's'} running`}
      onclick={onToggle}
    >
      <span class="sa-tab-glyph" aria-hidden="true">{open ? '⟨' : '⟩'}</span>
      {#if !open && running > 0}<span class="sa-tab-count">{running}</span>{/if}
    </button>
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

  .sa-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    flex: 0 0 auto;
    background: transparent;
    border: none;
    padding: 0;
    margin-bottom: 5px;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .sa-head-chevron { flex: 0 0 auto; font-size: 8px; color: var(--og-text-muted); }
  .sa-title { font-size: 10.5px; font-weight: 600; color: var(--og-text); }
  .sa-count { font-size: 9px; color: var(--og-text-muted); }

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

  .sa-tab {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 18px;
    padding: 0;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-left: none;
    border-radius: 0 6px 6px 0;
    cursor: pointer;
    font-family: inherit;
  }
  .sa-tab:hover { color: var(--og-text); background: var(--og-btn-hover); }
  .sa-tab-glyph { font-size: 10px; line-height: 1; }
  .sa-tab-count { font-size: 9px; font-weight: 600; color: var(--og-accent); }
</style>
