<script lang="ts">
  // The per-turn TERMINAL VERDICT row — the one-line "how did that turn end"
  // anchored inline at the end of the turn it resolved.
  //
  // EXTRACTED VERBATIM from ChatTranscript.svelte, which stood at 319 of its
  // 320-line cap when the second-opinion card needed a branch. Its own note
  // named this exact seam as the first candidate ("`verdict` (~8 lines + ~35 of
  // scoped rules)"), so this is the extraction that file asked for rather than a
  // convenient one.
  //
  // THE STYLES CAME WITH IT, all of them. Svelte scopes <style> per component,
  // so a `.turn-verdict` rule left behind in the transcript simply stops
  // matching markup that moved — no error, no warning, and vitest.config.mts
  // never puts a <style> element in the test DOM, so no test in this repo could
  // see it either. The class names are unchanged for the same reason: the
  // transcript's own tests select `div.turn-verdict`, and a rename here would
  // be a silent behaviour change dressed as a move.
  //
  // It owns NO state and posts nothing. `incomplete` is red on purpose: a
  // budget-walled, no-progress, errored or parked-infra turn must never read as
  // benign progress.
  import type { TurnVerdict } from '../panes/turnVerdict';

  interface Props {
    /** The turn's own verdict — `kind` drives the colour, `reason` the title. */
    verdict: TurnVerdict;
    /** The line the row shows. Composed by the pane (verdictLabel), not here. */
    text: string;
  }
  let { verdict, text }: Props = $props();
</script>

<div class="turn-verdict verdict-{verdict.kind}" title={verdict.reason}>
  <span class="verdict-dot" aria-hidden="true"></span>
  <span class="verdict-text">{text}</span>
</div>

<style>
  .turn-verdict {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 6px 0 10px 0;
    padding: 4px 10px;
    font-size: 11px;
    border-radius: 6px;
    border: 1px solid var(--og-border);
    background: var(--og-surface-alt);
  }
  .turn-verdict .verdict-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: var(--og-text-muted);
  }
  .turn-verdict .verdict-text {
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn-verdict.verdict-done .verdict-dot { background: var(--og-success); }
  .turn-verdict.verdict-done .verdict-text { color: var(--og-text); }
  .turn-verdict.verdict-parked .verdict-dot { background: var(--og-warning); }
  /* Incomplete/failed terminal — red. The thesis headline: this can
     never collapse to a benign "Continue". */
  .turn-verdict.verdict-incomplete {
    border-color: color-mix(in srgb, var(--og-error) 45%, var(--og-border));
    background: color-mix(in srgb, var(--og-error) 10%, var(--og-surface-alt));
  }
  .turn-verdict.verdict-incomplete .verdict-dot { background: var(--og-error); }
  .turn-verdict.verdict-incomplete .verdict-text { color: var(--og-error); font-weight: 600; }
</style>
