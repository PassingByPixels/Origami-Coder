<script lang="ts">
  // TodoTabs.svelte â€” the one-line tab strip above the todo list: `Main`, plus
  // one tab per sub-agent keeping a list of its own. A FINISHED child keeps its
  // tab (t-geo4n3), drawn dim with its done count.
  //
  // A TEXT ROW with an underline on the open tab (t-qn0lpl), not the boxed
  // pills this shipped as: the pills carried a border each, around a count that
  // carried another, for a switch between two lists inside a bordered panel.
  //
  // A SEPARATE component rather than markup inside TodoOverlay.svelte, on that
  // file's own precedent: the overlay owns the drawer's geometry and its slide,
  // this owns a row of buttons. WHICH tabs exist is todoTabs.ts's rule.
  //
  // The class prefix is `todo-listtab`, NOT `todo-tab`: TodoStrip.svelte owns
  // `.todo-tab` for its own pull-tab and the two render in the same overlay. A
  // shared selector makes every test query ambiguous â€” how this was found.
  //
  // Drawn only when there is a CHOICE to make: with no sub-agent lists the strip
  // is one tab reading "Main" over the only list there is, which spends a line of
  // a narrow panel saying nothing. TodoOverlay gates on that.
  import type { TodoTab } from './todoTabs';

  interface Props {
    tabs: TodoTab[];
    /** The tab id showing. Owned by the PANE (per session), so a choice survives
     *  this overlay remounting next turn â€” the same reason `collapsed` does. */
    selected: string;
    onSelect: (id: string) => void;
    /** Full identity by tab id, for the hover â€” `T3` is not addressable alone. */
    titles: Record<string, string>;
  }
  let { tabs, selected, onSelect, titles }: Props = $props();

  // The number a glance wants, which differs by state: open items while the
  // agent is out, DONE items once it has stopped (t-geo4n3 â€” a stopped agent's
  // open items are abandoned, not live work). Blank at zero, never a bare `0`.
  const open = (tab: TodoTab): number => tab.todos.filter((t) => t.status !== 'completed').length;
  const done = (tab: TodoTab): number => tab.todos.filter((t) => t.status === 'completed').length;
  const count = (tab: TodoTab): number => (tab.settled ? done(tab) : open(tab));
</script>

<div class="todo-listtabs og-scrollbar-visible" role="tablist" aria-label="Todo lists">
  {#each tabs as tab (tab.id)}
    <button
      class="todo-listtab"
      class:todo-listtab-on={tab.id === selected}
      class:todo-listtab-settled={tab.settled}
      role="tab"
      aria-selected={tab.id === selected}
      title={titles[tab.id] ?? tab.label}
      onclick={() => onSelect(tab.id)}
    >
      <span class="todo-listtab-label">{tab.label}</span>
      {#if count(tab) > 0}<span class="todo-listtab-count">{count(tab)}</span>{/if}
    </button>
  {/each}
</div>

<style>
  /* One scrolling line, never a wrapping block: a fan-out of six sub-agents must
     not push the list it labels off the panel, and the page never gains a
     scrollbar of its own.
     t-qn0lpl â€” and the strip's own scrollbar is no longer SUPPRESSED. It used
     to set `scrollbar-width: none` and a `display: none` webkit rule, so nine
     tabs looked like five with nothing to say the rest were off the right edge.
     t-ru0p04 â€” the house thin bar only painted mid-scroll, not at rest; the
     `og-scrollbar-visible` class (shared/theme.css, on the markup below) fixes
     that, reusably, so no local `::-webkit-scrollbar` lives in this file. The
     4px of bottom padding is the bar's room. */
  .todo-listtabs {
    display: flex; gap: 2px; min-width: 0;
    /* t-fh4zpc â€” NO horizontal inset of its own: the strip is the first row
       INSIDE TodoStrip's `.todo-panel`, so the panel's padding sets both ends
       and the border-bottom spans its content box. The old hand-made inset
       (from OUTSIDE the panel) would now be applied twice. */
    padding: 0 2px 4px 0; margin: 0 0 4px 0;
    overflow-x: auto;
    border-bottom: 1px solid var(--og-border);
  }

  /* t-qn0lpl â€” a TEXT ROW on a hairline, not a row of boxed pills. Each tab was
     a bordered pill holding a bordered count: two borders deep for a switch
     between two lists, inside a panel that has a border of its own. What is
     left is the word, the figure and â€” on the open one â€” a 2px underline.
     border-box + an explicit height stays, for its original reason: content-box
     let padding stack on the line height, so "Main 1" and "T4 2" measured
     differently although nothing set a height. */
  .todo-listtab {
    flex: 0 0 auto;
    box-sizing: border-box;
    display: flex; align-items: center; gap: 4px;
    max-width: 130px;
    height: 22px;
    padding: 0 8px;
    background: none;
    color: var(--og-text-muted);
    border: 0;
    border-radius: 5px 5px 0 0; /* rounded on top, square where it meets the list */
    box-shadow: inset 0 -2px 0 transparent; /* the underline's own space, always reserved */
    cursor: pointer;
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    transition: color 140ms ease, box-shadow 140ms ease;
  }
  .todo-listtab:hover { color: var(--og-text); }
  /* The open tab, said with an UNDERLINE the way a browser tab strip says it.
     Never touches height/padding/border-width: only colour and an INSET shadow,
     which paints inside the fixed border-box above and cannot grow it. */
  .todo-listtab-on {
    color: var(--og-text);
    box-shadow: inset 0 -2px 0 var(--og-accent);
  }
  /* A FINISHED sub-agent's tab (t-geo4n3): still there, visibly past tense.
     COLOUR ONLY, so t-f9jxl1's equal-height guarantee holds for every state. */
  .todo-listtab-settled { opacity: 0.55; }
  .todo-listtab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* A muted FIGURE beside the name, not a badge: the tab it sits on is no
     longer a box, so a second box inside it had nothing left to belong to. */
  .todo-listtab-count { flex: 0 0 auto; color: var(--og-text-muted); font-size: 9px; font-variant-numeric: tabular-nums; }
</style>
