<script lang="ts">
  // TodoStatusDot.svelte — a todo row's state, as a DOT.
  //
  // WHY A DOT (t-qn0lpl, CHANGES.md 52). The row used to print a glyph — ☐ ▶ ✓
  // — in a monospace column. The chat list and the sub-agent drawer already say
  // state with a coloured dot (SubagentRow.svelte's `.sa-dot`), so a reader had
  // to learn two vocabularies for one idea. This is the third user of the same
  // one: muted = pending, accent + pulse = in progress, success = done.
  //
  // ITS OWN FILE, not six more lines in TodoRow.svelte, because that file was at
  // 139 of its 140-line cap: the ratchet's remedy is an extraction, not a raise
  // (docs/WORKING_ON_ORIGAMI_CODER.md part 4), and the seam is real — the row
  // owns text, indent and tally, this owns one state and how it is coloured.
  //
  // The state is carried for ASSISTIVE readers too. The glyph this replaces was
  // text, so a screen reader read it; a bare coloured circle would not be read
  // at all, which is why the dot keeps a `title` and an `aria-label`.
  interface Props {
    status: 'pending' | 'in_progress' | 'completed';
  }
  let { status }: Props = $props();

  const LABEL: Record<Props['status'], string> = {
    pending: 'To do',
    in_progress: 'In progress',
    completed: 'Done',
  };
</script>

<span class="todo-status-dot todo-dot-{status}" title={LABEL[status]} aria-label={LABEL[status]} role="img"></span>

<style>
  /* 6px inside an 8px cell, centred on the row's own line box rather than its
     baseline: a circle has no baseline to sit on and would ride low beside
     text. Never grows — the row height (22px) is the panel's rhythm. */
  .todo-status-dot {
    flex: 0 0 auto;
    align-self: center;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--og-text-muted);
    opacity: 0.5;
  }
  /* State in colour AND in motion, exactly as `.sa-dot` does it: colour alone is
     one cue across five themes. */
  .todo-dot-in_progress {
    background: var(--og-accent);
    opacity: 1;
    animation: todo-dot-pulse 1.6s ease-in-out infinite;
  }
  .todo-dot-completed {
    background: var(--og-success);
    opacity: 0.85;
  }
  @keyframes todo-dot-pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--og-accent); }
    55% { box-shadow: 0 0 0 3px transparent; }
  }
  @media (prefers-reduced-motion: reduce) {
    .todo-dot-in_progress { animation: none; }
  }
</style>
