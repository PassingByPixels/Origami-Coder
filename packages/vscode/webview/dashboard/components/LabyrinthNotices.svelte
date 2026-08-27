<script lang="ts">
  // What the map must SAY about its own completeness, extracted VERBATIM from
  // LabyrinthPane.svelte (at its architecture cap) so the pane had room to
  // mount the spend strip. Two notices, both load-bearing:
  //  - truncation: a 500-step PREFIX drawn as the whole run is the worst thing
  //    this view could do, so it is stated in words and in numbers;
  //  - clock: thread and flight position by time, and when the run's clock
  //    cannot carry that the map says so instead of implying a timing.
  let { truncated, loaded, total, notice }: {
    truncated: boolean; loaded: number; total: number; notice: string | null;
  } = $props();
</script>

{#if truncated}
  <div class="lab-truncated">
    Showing the first {loaded.toLocaleString()} of {total.toLocaleString()} steps — this run is
    truncated by the engine's step cap. The map below is a PREFIX, not the whole run.
  </div>
{/if}
{#if notice}<div class="lab-note">{notice}</div>{/if}

<style>
  .lab-truncated { margin: 10px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-warning-text, var(--og-text)); background: var(--og-warning-soft); border: 1px solid var(--og-border); border-left: 3px solid var(--og-warning); border-radius: 4px; flex-shrink: 0; }
  .lab-note { margin: 10px 12px 0; padding: 7px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 4px; flex-shrink: 0; }
</style>
