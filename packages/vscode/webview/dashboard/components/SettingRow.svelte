<script lang="ts">
  // SettingRow.svelte — one row of the Settings view (t-s9jr6u, mock round 5):
  // name, a "reload" pill when the value is read once (its tooltip says when),
  // one or two lines of help, and the control at the right. The words come
  // from settingsGroups.ts; the control is the caller's snippet.
  //
  // Filtered rows are HIDDEN, not unmounted: each row owns a live wire to the
  // host, and a row that unmounted while filtered would lose its last reply.
  import type { Snippet } from 'svelte';
  import { tip } from '../../shared/WarmTooltip.svelte';
  import { rowMatches, settingRow, type SettingId } from '../panes/settingsGroups';

  let { id, filter = '', control, extra }: { id: SettingId; filter?: string; control: Snippet; extra?: Snippet } = $props();
  let row = $derived(settingRow(id));
</script>

<div class="srow" data-setting={id} hidden={!rowMatches(row, filter)}>
  <div class="stext">
    <div class="sname">{row.name}{#if row.reload}<span class="pill" use:tip={row.reload}>{row.pill ?? 'reload'}</span>{/if}</div>
    <div class="shelp">{row.help}</div>
    {#if extra}{@render extra()}{/if}
  </div>
  <div class="sctl">{@render control()}</div>
</div>

<style>
  .srow { display: flex; align-items: center; gap: 16px; padding: 9px 12px; min-height: 44px; box-sizing: border-box; }
  .srow[hidden] { display: none; }
  /* The divider between two visible rows is SettingsPane.svelte's (.sbox). */
  .stext { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .sname { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--og-text); }
  .shelp { font-size: 11px; color: var(--og-text-muted); line-height: 1.45; max-width: 520px; }
  .sctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
  .pill {
    display: inline-flex; align-items: center; padding: 0 6px; height: 16px; border-radius: 8px; border: 1px solid var(--og-border);
    color: var(--og-text-secondary); font-size: 9.5px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
  }
  @media (max-width: 560px) { .srow { flex-direction: column; align-items: stretch; gap: 6px; } .sctl { justify-content: flex-start; } }
</style>
