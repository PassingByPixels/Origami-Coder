<script lang="ts">
  // TodoProgressBar.svelte — how much of the list is done, as a 2px bar under
  // the Todo panel's header (t-qn0lpl, CHANGES.md 52).
  //
  // WHY. The header already prints `2/5 done · 1 active`, which is a fraction to
  // READ. A bar is the same fact at a glance, and the panel is something the
  // owner looks at sideways while the agent works.
  //
  // ITS OWN FILE, not four lines in TodoStrip.svelte: that file was at 356 of
  // its 360-line cap and the remedy for a full file is an extraction, not a
  // raise. It also keeps the arithmetic testable — the bar's width IS the
  // assertion, and this way nothing has to render a whole panel to check it.
  //
  // It reads the MODEL's counts (TodoStrip passes `counts(todos)`), never the
  // drawn rows: "Clear completed" hides finished rows, and a bar that emptied
  // when the owner tidied the list would be a progress bar that goes backwards.
  interface Props {
    completed: number;
    total: number;
  }
  let { completed, total }: Props = $props();

  // `total` cannot be 0 here — TodoStrip only mounts this on the non-empty
  // branch — but the guard costs one expression and a 0/0 bar would be NaN%.
  const pct = $derived(total > 0 ? Math.round((completed / total) * 100) : 0);
</script>

<div class="todo-bar" title="{completed} of {total} done" aria-hidden="true">
  <i class="todo-bar-fill" style="width: {pct}%"></i>
</div>

<style>
  /* aria-hidden and `<i>`: the header's own `2/5 done` line is the accessible
     name for this number, and two readings of one fact is noise. */
  .todo-bar {
    height: 2px;
    margin: 5px 0 1px;
    border-radius: 2px;
    background: var(--og-border);
    overflow: hidden;
  }
  .todo-bar-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--og-success);
    transition: width 320ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .todo-bar-fill { transition: none; }
  }
</style>
