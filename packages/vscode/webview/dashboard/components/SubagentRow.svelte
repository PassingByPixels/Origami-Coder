<script lang="ts">
  // SubagentRow.svelte — ONE row of the sub-agent drawer: its state dot, name,
  // age, token spend, model and live-activity tail.
  //
  // EXTRACTED from SubagentDrawer.svelte (t-kgryh1 polish round). Its own three
  // icon controls left for SubagentRowActions.svelte (t-dclj7z) when the token
  // figure and the time-limit warning needed room. Pure presentation — no
  // lifecycle decisions here: those stay in subagentEntry.ts / subagentRows.ts,
  // and WHICH controls it gets in subagentRowControls.ts.
  import { subagentLabel } from '../panes/subagentLabel';
  import { tokensTitle } from '../panes/subagentTokens';
  import { limitWarning } from '../panes/subagentWarn';
  import { rowControls } from '../panes/subagentRowControls';
  import type { SubagentRowProps } from '../panes/subagentProps';
  import SubagentRowActions from './SubagentRowActions.svelte';
  import SubagentCardFace from './SubagentCardFace.svelte';
  import { tip } from '../../shared/warmTip';

  // The prop SHAPE lives in subagentProps.ts, where the type gate can see it — see
  // that file's header for why a Props block written here would be a declaration
  // nothing ever checks.
  let { row, onDismiss, onOpen, onStop, limitMs = 0 }: SubagentRowProps = $props();

  // `<type> · T<n> · <description>`, never the card's own header — that header
  // is the word `task` on every sub-agent this chat has (subagentLabel.ts).
  const name = $derived(subagentLabel(row));
  // t-yyz57i: the model and the full spend breakdown live in the tooltip now;
  // the card face (SubagentCardFace.svelte) keeps two lines.
  const rowTitle = $derived([name, row.model, tokensTitle(row.tokens)].filter(Boolean).join(' · '));
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

<li class="sa-row" data-s={row.state} use:tip={rowTitle}>
  <!-- t-yyz57i: the card's two lines are SubagentCardFace.svelte, shared with
       the agent map. The model and the spend breakdown moved to the tooltip. -->
  <SubagentCardFace {row} {warning}>
    {#snippet actions()}
      <SubagentRowActions
        title={name} {...controls} {expanded}
        onOpen={() => onOpen(row)}
        onToggle={() => (expanded = !expanded)}
        onDismiss={() => onDismiss(row.key)}
        onStop={() => onStop?.(row)}
      />
    {/snippet}
  </SubagentCardFace>
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
    display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 6px 8px 7px;
    background: var(--og-bg); border: 1px solid var(--og-border);
    border-radius: 8px; transition: border-color 140ms ease;
  }
  /* t-yyz57i: a running card carries a faint chat-blue border. */
  .sa-row[data-s='running'] { border-color: color-mix(in srgb, var(--og-chat) 45%, var(--og-border)); }
  /* The row is an OBJECT you can point at, so it answers the pointer. */
  .sa-row:hover { border-color: var(--og-text-muted); }
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
</style>
