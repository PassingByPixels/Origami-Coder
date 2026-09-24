<script lang="ts">
  // SubagentThinkingLine.svelte — the drawer row's THINKING heartbeat: the
  // count and age of the thought a child is having right now, and the last
  // line of it (t-gvz8t0).
  //
  // Its own component, on SubagentRowActions.svelte's precedent: SubagentRow
  // sits four lines under its architecture cap, and the ratchet's rule is to
  // extract rather than raise. The split is also the honest one — a row's
  // identity, age and spend are facts about a RUN, this is a fact about one
  // STEP, and it appears and disappears several times within a run.
  //
  // ALWAYS SHOWN, never behind the row's fold. The defect this fixes is that a
  // child thinking for two minutes printed NOTHING on its row, and a line the
  // reader must open a chevron to see prints nothing to a reader who is
  // wondering whether the agent has hung.
  //
  // Both strings are computed in subagentThinking.ts, so what "thinking" means
  // is one answer shared with the map card, not a second one written in markup.
  interface Props {
    /** `thinking · ~5.4k tokens · 2m 05s`. Never rendered when ''. */
    note: string;
    /** The last line of the thought. May be '' — a count with no line is still
     *  worth printing, because the count alone answers "is it working". */
    thought: string;
  }
  let { note, thought }: Props = $props();
</script>

<div class="sa-think-line">
  <span class="sa-think">{note}</span>
  {#if thought}<span class="sa-thought" title={thought}>{thought}</span>{/if}
</div>

<style>
  /* The count takes the ACCENT tone the running dot takes, because it says the
     same thing — this agent is alive — and the thought line beside it takes the
     muted body tone, clipped to ONE line: a 7k-token thought must not be able
     to push the rest of the roster off the panel. */
  .sa-think-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding-left: 12px; }
  .sa-think { flex: 0 0 auto; font-size: 9px; color: var(--og-accent); font-variant-numeric: tabular-nums; }
  .sa-thought {
    flex: 1 1 auto; min-width: 0; font-size: 9px;
    color: var(--og-text-muted); opacity: 0.85;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
