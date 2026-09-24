<script lang="ts">
  // SubagentRowActions.svelte — the three icon controls at the right-hand end
  // of a sub-agent row: open the transcript (↗), fold the activity tail (▾),
  // dismiss a failed spawn (×).
  //
  // EXTRACTED from SubagentRow.svelte at 129/130, when the token figure and the
  // time-limit warning needed room on the header line (t-dclj7z). The split is
  // the one FlockRowActions.svelte already made one pane over: a row's CONTENT
  // (what it says) and a row's CONTROLS (what you can do to it) are two jobs,
  // and the controls carry a whole shared button style of their own.
  //
  // Presentation only. WHICH controls a row gets is still decided by the row —
  // this draws the ones it is handed.
  interface Props {
    /** Names the control for a screen reader, and the transcript's own header. */
    title: string;
    /** The child has a session of its own, so there is a transcript to open.
     *  A spawn that never made one gets no ↗ rather than one onto an empty page. */
    canOpen: boolean;
    /** The row has an activity tail worth folding. */
    canFold: boolean;
    /** Only a FAILED spawn — it never settles on its own, so it needs a way out. */
    canDismiss: boolean;
    /** t-q910fo: the child is RUNNING and has a session, so there is a job to abort. */
    canStop: boolean;
    expanded: boolean;
    onOpen: () => void;
    onToggle: () => void;
    onDismiss: () => void;
    onStop: () => void;
  }
  let { title, canOpen, canFold, canDismiss, canStop, expanded, onOpen, onToggle, onDismiss, onStop }: Props = $props();
</script>

<!-- NO CONFIRM, deliberately: a sub-agent costs one launch to start again, and a
     modal over a 240px drawer costs more than the mistake does. The label names
     the child so the act is still addressed, not anonymous. -->
{#if canStop}<button class="sa-stop" title="Stop this sub-agent" aria-label="Stop {title}" onclick={onStop}>Stop</button>{/if}
{#if canOpen}<button class="sa-pop" title="Open transcript" aria-label="Open {title}" onclick={onOpen}>&#8599;</button>{/if}
{#if canFold}<button class="sa-fold" aria-expanded={expanded} aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`} onclick={onToggle}>{expanded ? '▾' : '▸'}</button>{/if}
<!-- The tip says what dismissing does NOT do: a row that vanishes from the
     roster reads as a run that was killed, and this one only stops listing it. -->
{#if canDismiss}<button class="sa-dismiss" title="Dismiss this row — the run is untouched" aria-label="Dismiss {title}" onclick={onDismiss}>&times;</button>{/if}

<style>
  /* Dismiss, open-in-tab and per-row fold share one small icon-button look —
     they are three ends of the same "row-level control" family. */
  .sa-dismiss, .sa-pop, .sa-fold, .sa-stop {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
    border-radius: 3px;
    font-family: inherit;
  }
  .sa-dismiss:hover, .sa-pop:hover, .sa-fold:hover { color: var(--og-text); background: var(--og-btn-bg); }
  /* The one WORD among three glyphs — a stop is the only destructive control
     here, and an icon would be guessed rather than read. */
  .sa-stop { font-size: 9px; }
  .sa-stop:hover { color: var(--og-error); background: var(--og-btn-bg); }
  .sa-fold { font-size: 8px; color: var(--og-text-muted); }
</style>
