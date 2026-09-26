<script lang="ts">
  // CacheWarmingCard.svelte — Settings › Cache › "Keep the prompt cache warm".
  //
  // Born in Insights beside CacheStatsCard; moved to the Settings view as a row
  // in t-s9jr6u (owner: Insights shows nothing but insights, and cache warming
  // is a switch). The "reload" pill says the engine reads it at spawn.
  //
  // Its own component on the SubagentLimitCard.svelte precedent, and the
  // setting is written by the HOST (cacheWarmingPane.ts), never from here: a
  // webview naming a configuration key is a webview choosing what the extension
  // writes.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import OnOffSwitch from './OnOffSwitch.svelte';
  import SettingRow from './SettingRow.svelte';
  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();

  // ON until the host says otherwise — the same default both halves ship with,
  // so the box never flickers to the wrong state on first paint.
  let enabled = $state(false);
  let error: string | null = $state(null);

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'cacheWarmingData') return;
    enabled = msg.enabled === true;
    error = typeof msg.error === 'string' ? msg.error : null;
  });

  vscode.postMessage({ type: 'requestCacheWarming' });

  // One-way, like the sibling card: the box shows what the HOST last reported,
  // so a refused write corrects itself rather than leaving the switch claiming
  // a state the settings file does not hold.
  function commit(next: boolean): void {
    vscode.postMessage({ type: 'cacheWarmingSet', enabled: next });
  }
</script>

<SettingRow id="cacheWarming" {filter}>
  {#snippet control()}<OnOffSwitch checked={enabled} label="Keep the prompt cache warm" onchange={commit} />{/snippet}
  {#snippet extra()}{#if error}<div class="cw-error">{error}</div>{/if}{/snippet}
</SettingRow>

<style>
  .cw-error { font-size: 10.5px; color: var(--og-error); }
</style>
