<script lang="ts">
  // SubagentCardFace.svelte — the two lines of ONE sub-agent card, shared by the
  // pull-out row (SubagentRow.svelte) and the agent map (SubagentMap.svelte), so
  // the two views print the same object (t-yyz57i, redesign R3).
  //
  // Line 1: state dot, `type · T<n> ·` (muted), the job, then the caller's
  // controls. Line 2: what subagentCard.ts chose — the latest activity line, the
  // failure reason, or the totals — or the thinking heartbeat while it reasons.
  import type { Snippet } from 'svelte';
  import { cardJob, cardLine2, cardWho } from '../panes/subagentCard';
  import { subagentLabel } from '../panes/subagentLabel';
  import { tokensTitle } from '../panes/subagentTokens';
  import { tip } from '../../shared/warmTip';
  import type { SubagentRow } from '../panes/subagentRows';
  import SubagentThinkingLine from './SubagentThinkingLine.svelte';

  interface Props {
    row: SubagentRow;
    /** Amber time-limit warning for the dot (subagentWarn.ts); '' for none. */
    warning?: string;
    actions?: Snippet;
  }
  let { row, warning = '', actions }: Props = $props();
  const line2 = $derived(cardLine2(row));
  const job = $derived(cardJob(row));
</script>

<div class="sa-line1">
  <span class="sa-dot sa-{row.state}" class:sa-warn={!!warning} use:tip={warning} aria-label={warning || undefined}></span>
  <!-- `.sa-name`'s text is subagentLabel()'s: who, ` · `, job; a missing job drops the separator. -->
  <span class="sa-name" use:tip={subagentLabel(row)}><span class="sa-who">{cardWho(row)}{job ? ' · ' : ''}</span>{#if job}<span class="sa-job">{job}</span>{/if}</span>
  {@render actions?.()}
</div>
{#if row.thinking}
  <SubagentThinkingLine note={row.thinking} thought={row.thought} />
{:else}
  <div class="sa-line2" class:sa-line2-fail={line2.kind === 'reason'}>
    {#if line2.kind === 'reason'}
      <span class="sa-reason" use:tip={line2.text}>{line2.text}</span>
    {:else if line2.kind === 'activity'}
      <span class="sa-act" use:tip={line2.text}>{line2.text}</span>
      {#if line2.age}<span class="sa-age">{line2.age}</span>{/if}
    {:else}
      {#if line2.tokens}<span class="sa-tokens" use:tip={tokensTitle(row.tokens)}>{line2.tokens}</span>{/if}
      {#if line2.age}<span class="sa-age">{line2.age}</span>{:else if row.settled}<span class="sa-age sa-age-unknown" use:tip={'This sub-agent finished, but nothing recorded when'}>&mdash;</span>{/if}
    {/if}
  </div>
{/if}

<style>
  .sa-line1 { display: flex; align-items: center; gap: 7px; min-width: 0; min-height: 16px; font-size: 11.5px; }
  .sa-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--og-text); }
  .sa-who { font-size: 10px; color: var(--og-text-muted); }
  .sa-line2 {
    display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 13px;
    margin-left: 14px; font-size: 10px; color: var(--og-text-muted);
    font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .sa-line2-fail { color: var(--og-error); }
  .sa-act, .sa-reason { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .sa-act { font-family: var(--vscode-editor-font-family, monospace); animation: sa-tail-in 220ms ease-out; }
  .sa-age, .sa-tokens { flex: 0 0 auto; }
  .sa-tokens { opacity: 0.85; min-width: 0; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; }
  @keyframes sa-tail-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

  /* State in colour AND motion: a running dot pulses, the rest are still. */
  .sa-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--og-text-muted); }
  .sa-dot.sa-queued { background: transparent; box-shadow: inset 0 0 0 1.5px var(--og-text-muted); }
  .sa-dot.sa-running { background: var(--og-chat); animation: sa-pulse 1.4s infinite; }
  .sa-dot.sa-failed, .sa-dot.sa-error { background: var(--og-error); }
  .sa-dot.sa-done { background: var(--og-success); }
  /* Past 80% of the time limit: amber with a ring, LAST so it beats running. */
  .sa-dot.sa-warn { background: var(--og-warning); box-shadow: 0 0 0 2px var(--og-surface-alt), 0 0 0 3px var(--og-warning); }
  @keyframes sa-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
