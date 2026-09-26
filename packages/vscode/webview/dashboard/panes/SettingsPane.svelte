<script lang="ts">
  // Settings — the Agent Manager view at the rail's foot, directly above Docs
  // (t-s9jr6u; mock rounds 5-6). It holds the switches and numbers that used
  // to sit in Insights, grouped by what they change: Chat, Agents, Browser,
  // Cache, Appearance. Insights now answers only "what goes into a prompt and
  // what it costs".
  //
  // The words and the order are settingsGroups.ts; each group mounts the row
  // components that own their wires. The filter HIDES rows (and a group with
  // none left) instead of unmounting them, so no row loses its host reply.
  import type { Component } from 'svelte';
  import DensityCard from '../components/DensityCard.svelte';
  import SubagentLimitCard from '../components/SubagentLimitCard.svelte';
  import BrowserSettings from '../components/BrowserSettings.svelte';
  import CacheWarmingCard from '../components/CacheWarmingCard.svelte';
  import BackdropSetting from '../components/BackdropSetting.svelte';
  import EngineSettingsCard from '../components/EngineSettingsCard.svelte';
  import { SETTING_COUNT, SETTING_GROUPS, groupMatches } from './settingsGroups';

  /** Which row components draw each group, in the table's row order. */
  const MOUNTS: Record<string, Component<{ filter?: string }>> = {
    Chat: DensityCard,
    Agents: SubagentLimitCard,
    Engines: EngineSettingsCard,
    Browser: BrowserSettings,
    Cache: CacheWarmingCard,
    Appearance: BackdropSetting,
  };

  let filter = $state('');
  let shut: Record<string, boolean> = $state({});
</script>

<div class="set-pane">
  <div class="bar">
    <span class="title">Settings</span>
    <span class="sum">{SETTING_COUNT} settings · each change saves at once</span>
    <span class="grow"></span>
    <input class="filter" placeholder="Filter settings" aria-label="Filter settings" bind:value={filter}
      onkeydown={(e) => e.key === 'Escape' && (filter = '')} />
  </div>
  <div class="scroll">
    <div class="col">
      {#each SETTING_GROUPS as g (g.name)}
        {@const Rows = MOUNTS[g.name]}
        <section class="sgroup" class:is-shut={shut[g.name]} data-group={g.name} hidden={!groupMatches(g, filter)}>
          <div class="shead">
            <button class="chev" aria-expanded={!shut[g.name]} aria-label={`Collapse ${g.name}`} onclick={() => (shut[g.name] = !shut[g.name])}>▾</button>
            <span class="sgname">{g.name}</span><span class="count">{g.rows.length}</span>
          </div>
          <div class="sbox">{#if Rows}<Rows {filter} />{/if}</div>
        </section>
      {/each}
      {#if !SETTING_GROUPS.some((g) => groupMatches(g, filter))}<p class="none">No setting matches “{filter.trim()}”.</p>{/if}
    </div>
  </div>
</div>

<style>
  .set-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4; }
  /* The Insights toolbar pattern: caps title, muted totals, one filter field. */
  .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); }
  .sum { font-size: 11px; color: var(--og-text-muted); }
  .grow { flex: 1 1 auto; }
  .filter {
    flex: 0 1 180px; width: 180px; min-width: 0; font: inherit; font-size: 11px; padding: 4px 8px; color: var(--og-text);
    background: var(--og-bg); border: 1px solid var(--og-input-border); border-radius: 6px;
  }
  .filter:focus { outline: none; border-color: var(--og-chat); }
  .scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .col { max-width: 760px; padding: 10px 12px 24px; display: flex; flex-direction: column; gap: 12px; }
  .sgroup[hidden] { display: none; }
  .shead { display: flex; align-items: center; gap: 5px; min-height: 21px; padding: 0 2px; }
  .chev { width: 16px; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--og-text-muted); font-size: 10px; line-height: 16px; transition: transform 160ms ease; }
  .sgroup.is-shut .chev { transform: rotate(-90deg); }
  .sgroup.is-shut .sbox { display: none; }
  .sgname { font-size: 11px; font-weight: 600; color: var(--og-text-secondary); }
  .count {
    min-width: 16px; padding: 0 5px; border: 1px solid var(--og-border); border-radius: 8px; text-align: center;
    color: var(--og-text-muted); font-size: 10px; line-height: 14px; font-variant-numeric: tabular-nums;
  }
  .sbox { margin-top: 4px; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; }
  /* One divider between two VISIBLE rows; the rows are siblings in the box. */
  .sbox :global(.srow:not([hidden]) ~ .srow:not([hidden])) { border-top: 1px solid color-mix(in srgb, var(--og-border) 70%, transparent); }
  .none { margin: 4px 2px; color: var(--og-text-muted); font-style: italic; }
</style>
