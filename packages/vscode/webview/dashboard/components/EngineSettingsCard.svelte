<script lang="ts">
  // EngineSettingsCard.svelte — Settings › Engines (t-xf2e9q): the seven
  // `origamicoder.elastic.*` settings, as one card of sibling rows, the
  // BrowserSettings.svelte precedent for a group with more than one row.
  //
  // The setting is written by the HOST (enginesPane.ts), never from here: a
  // webview naming a configuration key is a webview choosing what the
  // extension writes. One read/write wire for all seven, since they are one
  // section (origamicoder.elastic) and one host reply already carries every
  // value the row-order in settingsGroups.ts needs.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import OnOffSwitch from './OnOffSwitch.svelte';
  import SettingRow from './SettingRow.svelte';
  import EngineTimeline from './EngineTimeline.svelte';

  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();

  let enabled = $state(true);
  let warmSpare = $state(true);
  let warming = $state(false); // 0.4.184: off by default; t-z6ytkw: the cache-warming setting, for the chart's warm blips
  let idleAfterMinutes = $state(5);
  let parkAfterMinutes = $state(20); // t-ze0hwh: the package.json defaults
  let parkUntimedAfterMinutes = $state(20);
  let trimAfterMinutes = $state(0);
  let retrimMinutes = $state(10);
  let mins: Record<string, number> = $state({
    idleAfterMinutes: 1,
    trimAfterMinutes: 0,
    retrimMinutes: 1,
    parkAfterMinutes: 0,
    parkUntimedAfterMinutes: 0,
  });
  let error: string | null = $state(null);

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'engineSettingsData') return;
    enabled = msg.enabled !== false;
    warmSpare = msg.warmSpare !== false;
    warming = msg.cacheWarming === true;
    if (typeof msg.idleAfterMinutes === 'number') idleAfterMinutes = msg.idleAfterMinutes;
    if (typeof msg.parkAfterMinutes === 'number') parkAfterMinutes = msg.parkAfterMinutes;
    if (typeof msg.parkUntimedAfterMinutes === 'number') parkUntimedAfterMinutes = msg.parkUntimedAfterMinutes;
    if (typeof msg.trimAfterMinutes === 'number') trimAfterMinutes = msg.trimAfterMinutes;
    if (typeof msg.retrimMinutes === 'number') retrimMinutes = msg.retrimMinutes;
    if (msg.mins && typeof msg.mins === 'object') mins = { ...mins, ...msg.mins };
    error = typeof msg.error === 'string' ? msg.error : null;
  });

  vscode.postMessage({ type: 'requestEngineSettings' });

  function setBool(key: 'enabled' | 'warmSpare', next: boolean): void {
    vscode.postMessage({ type: 'engineSettingsSet', key, value: next });
  }

  // One-way, like the sibling number rows in Settings: the box shows what the
  // HOST last reported, so a refused write corrects itself rather than the box
  // claiming a value that was never stored.
  function commitNumber(key: keyof typeof mins, current: number, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const next = Number(raw);
    if (!raw.trim() || !Number.isFinite(next) || next < mins[key]) {
      (event.target as HTMLInputElement).value = String(current);
      error = `${key} must be at least ${mins[key]}.`;
      return;
    }
    vscode.postMessage({ type: 'engineSettingsSet', key, value: next });
  }
</script>

<!-- t-xq22sx: the chart follows the values the HOST last reported, so it redraws on each write. -->
{#if !filter.trim()}
  <EngineTimeline settings={{ enabled, idleAfterMinutes, trimAfterMinutes, retrimMinutes, parkAfterMinutes, parkUntimedAfterMinutes, warming }} />
{/if}
<SettingRow id="elasticEnabled" {filter}>
  {#snippet control()}<OnOffSwitch checked={enabled} label="Elastic engines" onchange={(v) => setBool('enabled', v)} />{/snippet}
</SettingRow>
<SettingRow id="warmSpare" {filter}>
  {#snippet control()}<OnOffSwitch checked={warmSpare} label="Warm spare" onchange={(v) => setBool('warmSpare', v)} />{/snippet}
</SettingRow>
<SettingRow id="idleAfter" {filter}>
  {#snippet control()}
    <label class="eng-field">
      <input class="eng-input" type="number" min={mins.idleAfterMinutes} value={idleAfterMinutes}
        aria-label="Idle after, minutes" onchange={(e) => commitNumber('idleAfterMinutes', idleAfterMinutes, e)} />
      <span class="eng-unit">min</span>
    </label>
  {/snippet}
</SettingRow>
<SettingRow id="parkAfter" {filter}>
  {#snippet control()}
    <label class="eng-field">
      <input class="eng-input" type="number" min={mins.parkAfterMinutes} value={parkAfterMinutes}
        aria-label="Park idle chats after, minutes" onchange={(e) => commitNumber('parkAfterMinutes', parkAfterMinutes, e)} />
      <span class="eng-unit">min</span>
    </label>
  {/snippet}
</SettingRow>
<SettingRow id="parkUntimedAfter" {filter}>
  {#snippet control()}
    <label class="eng-field">
      <input class="eng-input" type="number" min={mins.parkUntimedAfterMinutes} value={parkUntimedAfterMinutes}
        aria-label="Park after, for providers with no published cache life, minutes"
        onchange={(e) => commitNumber('parkUntimedAfterMinutes', parkUntimedAfterMinutes, e)} />
      <span class="eng-unit">min</span>
    </label>
  {/snippet}
</SettingRow>
<SettingRow id="trimAfter" {filter}>
  {#snippet control()}
    <label class="eng-field">
      <input class="eng-input" type="number" min={mins.trimAfterMinutes} value={trimAfterMinutes}
        aria-label="Trim after, minutes" onchange={(e) => commitNumber('trimAfterMinutes', trimAfterMinutes, e)} />
      <span class="eng-unit">min</span>
    </label>
  {/snippet}
</SettingRow>
<SettingRow id="retrim" {filter}>
  {#snippet control()}
    <label class="eng-field">
      <input class="eng-input" type="number" min={mins.retrimMinutes} value={retrimMinutes}
        aria-label="Re-trim every, minutes" onchange={(e) => commitNumber('retrimMinutes', retrimMinutes, e)} />
      <span class="eng-unit">min</span>
    </label>
  {/snippet}
  {#snippet extra()}{#if error}<div class="eng-error">{error}</div>{/if}{/snippet}
</SettingRow>

<style>
  .eng-field { display: flex; align-items: center; gap: 6px; }
  .eng-input {
    width: 64px; padding: 4px 8px; background: var(--og-bg); color: var(--og-text); border: 1px solid var(--og-input-border);
    border-radius: 6px; font-family: inherit; font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .eng-input:focus { outline: none; border-color: var(--og-chat); }
  .eng-unit { font-size: 11px; color: var(--og-text-muted); }
  .eng-error { font-size: 10.5px; color: var(--og-error); }
</style>
