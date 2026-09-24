<script lang="ts">
  // ONE agent column's header in the sub-agent ledger (t-f3a74m). Split out of
  // SubagentLedger.svelte when the header stopped being a single button: it now
  // carries the click-to-cycle control AND a menu, and the sheet file was at
  // 188/215 with the whole table still to draw.
  //
  // The menu holds one item today. It exists because "Reset to defaults" is the
  // one header action that is NOT a state to cycle to — it removes overrides
  // instead of writing one — and hanging it off the same click would make the
  // cycle unreachable.
  import { onCount, columnNext, type LedgerAgent, type LedgerTool } from './ledgerRows';

  let { row, tools, onColumn, onReset }: {
    row: LedgerAgent;
    tools: LedgerTool[];
    onColumn: (agent: string, next: ReturnType<typeof columnNext>) => void;
    onReset: (agent: string) => void;
  } = $props();

  let open = $state(false);
  /** The description on ONE line for the title, so a tooltip is not a wall. */
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

  function cycle(): void {
    const next = columnNext(row, tools);
    if (next) onColumn(row.agent, next);
  }
  function reset(): void {
    open = false;
    onReset(row.agent);
  }
</script>

<div class="lg-head-wrap">
  <button
    class="lg-col"
    title={`${row.description ? oneLine(row.description) + ' · ' : ''}Click: set every settable tool for ${row.agent}`}
    onclick={cycle}
  >
    <span class="lg-agent-name">{row.agent}{#if row.native}<span class="lg-tag">built-in</span>{/if}</span>
    <span class="lg-cnt">{onCount(row, tools)} of {tools.length} on</span>
  </button>
  <button
    class="lg-menu-btn"
    aria-haspopup="menu"
    aria-expanded={open}
    title={`More for ${row.agent}`}
    onclick={() => (open = !open)}
  >⋯</button>
  {#if open}
    <div class="lg-menu" role="menu">
      <button class="lg-menu-item" role="menuitem" onclick={reset}>Reset to defaults</button>
    </div>
  {/if}
</div>

<style>
  .lg-head-wrap { position: relative; }
  .lg-col { display: block; width: 100%; background: transparent; border: none; color: inherit; font: inherit; cursor: pointer; padding: 6px 4px; text-align: center; }
  .lg-col:hover { background: var(--og-btn-hover); color: var(--og-text); }
  .lg-agent-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); color: var(--og-text); }
  .lg-tag { margin-left: 4px; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); font-family: inherit; }
  .lg-cnt { display: block; font-size: 9px; color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Top-right of the header cell, out of the name's way. Always drawn, never
     hover-only: a menu nobody can find is a menu nobody uses. */
  .lg-menu-btn { position: absolute; top: 1px; right: 1px; background: transparent; border: none; color: var(--og-text-muted); font: inherit; line-height: 1; padding: 0 3px; cursor: pointer; border-radius: 3px; }
  .lg-menu-btn:hover { background: var(--og-btn-hover); color: var(--og-text); }
  .lg-menu { position: absolute; top: 100%; right: 0; z-index: 6; min-width: 132px; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 4px; padding: 3px; text-align: left; }
  .lg-menu-item { display: block; width: 100%; background: transparent; border: none; color: var(--og-text); font: inherit; font-size: 11px; text-align: left; padding: 4px 6px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .lg-menu-item:hover { background: var(--og-btn-hover); }
</style>
