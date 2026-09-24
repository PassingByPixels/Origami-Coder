<script lang="ts">
  // SubagentRow.svelte — ONE row of the sub-agent drawer: its state dot, name,
  // age, token spend, model and live-activity tail.
  //
  // EXTRACTED from SubagentDrawer.svelte (t-kgryh1 polish round). Its own three
  // icon controls left for SubagentRowActions.svelte (t-dclj7z) when the token
  // figure and the time-limit warning needed room. Pure presentation — no
  // lifecycle decisions here: those stay in subagentEntry.ts / subagentRows.ts,
  // and WHICH controls it gets in subagentRowControls.ts.
  import { elapsedText } from '../panes/subagentFormat';
  import { subagentLabel } from '../panes/subagentLabel';
  import { tokensTitle, tokensTotalText } from '../panes/subagentTokens';
  import { limitWarning } from '../panes/subagentWarn';
  import { rowControls } from '../panes/subagentRowControls';
  import type { SubagentRowProps } from '../panes/subagentProps';
  import SubagentRowActions from './SubagentRowActions.svelte';
  import SubagentThinkingLine from './SubagentThinkingLine.svelte';

  // The prop SHAPE lives in subagentProps.ts, where the type gate can see it — see
  // that file's header for why a Props block written here would be a declaration
  // nothing ever checks.
  let { row, onDismiss, onOpen, onStop, limitMs = 0 }: SubagentRowProps = $props();

  // `<type> · T<n> · <description>`, never the card's own header — that header
  // is the word `task` on every sub-agent this chat has (subagentLabel.ts).
  const name = $derived(subagentLabel(row));
  const age = $derived(elapsedText(row.elapsedMs));
  // The spend figure (t-f9jxl1) — `54k tokens · 3 steps · 19k context` since
  // t-ffziaz, never the old in/out pair, which lives in this span's `title=`.
  // One vocabulary with the chat's context pill: the first part is a SUM over
  // the run, the last is ONE step's window. compact() is subagentTokens.ts's.
  const tokens = $derived(tokensTotalText(row.tokens));
  // '' when there is nothing to warn about, so the amber dot and its tooltip
  // read the SAME answer and cannot drift apart (subagentWarn.ts).
  const warning = $derived(limitWarning(row.elapsedMs, row.settled, limitMs));
  // Per-entry collapse (t-kgryh1 round 2, reversed by t-f9jxl1): a fan-out of
  // several running agents used to open every stream tail at once, which is the
  // opposite of a glance surface. Every row — running ones too — now starts
  // FOLDED; the chevron is for the one you actually want to watch.
  let expanded = $state(false);
  const controls = $derived(rowControls(row, !!onStop));
</script>

<li class="sa-row">
  <!-- Row 1: identity + the row's buttons. -->
  <div class="sa-line1">
    <!-- Amber OVER the state colour, never instead of the dot: the row is still
         running, it is just close to the ceiling. `title` on the dot, because
         that is the thing that changed colour. -->
    <span class="sa-dot sa-{row.state}" class:sa-warn={!!warning} title={warning} aria-label={warning || undefined}></span>
    <span class="sa-name" title={name}>{name}</span>
    <SubagentRowActions
      title={name} {...controls} {expanded}
      onOpen={() => onOpen(row)}
      onToggle={() => (expanded = !expanded)}
      onDismiss={() => onDismiss(row.key)}
      onStop={() => onStop?.(row)}
    />
  </div>
  <!-- Row 2, the METADATA line: tokens, elapsed, then WHICH model. Any part can
       be absent, but the ORDER never changes. t-qn0lpl: the model was a third
       line of its own, and three lines per row cost eighteen lines of a 280px
       rail on a fan-out of six. -->
  <div class="sa-line2">
    <!-- What it SPENT. Absent entirely against an engine that rides no token
         rider — blank is the honest answer there, and `0 tokens` would claim
         a figure nobody sent (subagentTokens.ts). The full in/out/reasoning/
         cache/cost breakdown lives in this span's tooltip. -->
    {#if tokens}<span class="sa-tokens" title={tokensTitle(row.tokens)}>{tokens}</span>{/if}
    <!-- Unknown age: blank while LIVE ("0s" on an agent out for a minute is
         worse than silence), an em dash once STOPPED, where a blank reads as
         "no time" rather than "nobody timed it" — subagentTiming.ts. -->
    {#if age}<span class="sa-age">{age}</span>{:else if row.settled}<span class="sa-age sa-age-unknown" title="This sub-agent finished, but nothing recorded when">&mdash;</span>{/if}
    <!-- WHICH model, because a sub-agent routinely does NOT run on the one the
         chat shows — a flock binding or this chat's sub-agent override sends it
         elsewhere, and a slow agent's model is the first thing you want to
         know. Absent when the card had none. -->
    {#if row.model}<span class="sa-model" title={row.model}>{row.model}</span>{/if}
  </div>
  <!-- t-gvz8t0: the thinking heartbeat, while the child reasons and only then. -->
  {#if row.thinking}<SubagentThinkingLine note={row.thinking} thought={row.thought} />{/if}
  <!-- The last few lines of what it is DOING. Collapsed to a fixed tail
       (never a scrolling log): the drawer answers "still alive, and on
       what", and the transcript's own card holds the rest. Hidden entirely
       when this ONE row is folded. -->
  {#if expanded && row.activity}<pre class="sa-activity">{row.activity}</pre>{/if}
</li>

<style>
  /* A card, matching the row-card convention used across the dashboard
     (ArchetypeAgentCard.svelte, CacheStatsCard.svelte): surface-alt fill,
     border, small radius. Rows used to be borderless flush text; a fan-out of
     several agents read as one grey block with no way to tell where one row
     ended and the next began. */
  .sa-row {
    display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 4px 6px;
    background: var(--og-surface-alt); border: 1px solid var(--og-border);
    border-radius: 6px; transition: border-color 140ms ease;
  }
  /* The row is an OBJECT you can point at, so it answers the pointer. */
  .sa-row:hover { border-color: var(--og-accent); }
  .sa-line1 { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 16px; font-size: 11px; }
  /* Row 2: tokens, elapsed, model — all quiet, all tabular. None of them is
     what the drawer exists to answer, and an empty row (no rider, no age, no
     model) costs one blank line rather than reflowing the other. */
  .sa-line2 {
    display: flex; align-items: center; gap: 6px; min-width: 0;
    padding-left: 12px; min-height: 11px;
    font-size: 9.5px; color: var(--og-text-muted); font-variant-numeric: tabular-nums;
  }
  .sa-model { min-width: 0; font-size: 9.5px; color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The tail is a QUOTE from the run — so it is set as one, with a rule down
     its left edge instead of the raw <pre> block it was. `max-height` is the
     load-bearing part: a child that prints a forty-line stack trace must not
     stretch the drawer past the rail it lives in. */
  .sa-activity {
    margin: 3px 0 0; padding: 3px 0 0 7px; font-size: 9.5px; line-height: 1.35;
    border-left: 1px solid var(--og-border);
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted); opacity: 0.85;
    white-space: pre-wrap; word-break: break-word; overflow: hidden; max-height: 34px;
  }
  .sa-name {
    flex: 1 1 auto; min-width: 0; color: var(--og-text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Size, colour and tabular figures come from `.sa-line2` now that all three
     of its parts are the same kind of fact. The spend stays quieter still: it
     is context for the row, not the thing the drawer exists to answer. */
  .sa-age, .sa-tokens { flex: 0 0 auto; }
  .sa-tokens { opacity: 0.85; }

  /* State in colour AND in motion: a queued agent is a still dot, a running one
     pulses. Colour alone would be one cue in a five-theme board. */
  .sa-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--og-text-muted); }
  .sa-dot.sa-running { background: var(--og-accent); animation: sa-pulse 1.6s infinite; }
  /* A spawn that never happened, and a child that ran and ERRORED: still, and
     the error colour — the count line names both, because colour alone is one
     cue in a five-theme board. A clean finish takes the success tone rather
     than the muted default, which would read as "queued". */
  .sa-dot.sa-failed, .sa-dot.sa-error { background: var(--og-error); }
  .sa-dot.sa-done { background: var(--og-success); }
  /* Past 80% of the ceiling. LAST in the cascade so it beats `.sa-running`'s
     accent, and it keeps the pulse: the agent has not stopped, it is running
     out of time. A ring as well as a fill, so the change is a shape change too
     and not colour alone. */
  .sa-dot.sa-warn { background: var(--og-warning); box-shadow: 0 0 0 2px var(--og-surface-alt), 0 0 0 3px var(--og-warning); }
  @keyframes sa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
