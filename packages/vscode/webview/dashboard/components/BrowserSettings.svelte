<script lang="ts">
  // Settings › Browser (t-s9jr6u: three rows in the Settings view, no longer a
  // card in Insights): the page viewport the agent's screenshots are taken at,
  // when its tab may come to the front (BrowserRevealRow), and whether it opens
  // beside the chat. The three rows render as siblings, with no wrapper, so the
  // group box draws one divider between each visible pair.
  //
  // The viewport is a SETTING rather than a per-capture argument because the
  // embedded browser tab can be any size the user leaves it, and a screenshot
  // taken at tab size is a different picture from the one the user is being
  // shown. 1920x1080 is the default; the host clamps what is typed here to the
  // bounds the workbench's own emulation inputs accept (50..9999).
  //
  // Host wire: requestBrowserViewport -> browserViewportUpdate, then
  // setBrowserViewport / setBrowserOpenBeside. All GLOBAL, never per-session.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import BrowserRevealRow from './BrowserRevealRow.svelte';
  import OnOffSwitch from './OnOffSwitch.svelte';
  import SettingRow from './SettingRow.svelte';

  let { filter = '' }: { filter?: string } = $props();

  const vscode = getVsCodeApi();

  const DEFAULT_WIDTH = 1920;
  const DEFAULT_HEIGHT = 1080;

  let width = $state(DEFAULT_WIDTH);
  let height = $state(DEFAULT_HEIGHT);
  let beside = $state(true);

  function commit() {
    vscode.postMessage({ type: 'setBrowserViewport', width, height });
  }

  function toggleBeside(next: boolean) {
    beside = next;
    vscode.postMessage({ type: 'setBrowserOpenBeside', value: beside });
  }

  function reset() {
    width = DEFAULT_WIDTH;
    height = DEFAULT_HEIGHT;
    commit();
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type !== 'browserViewportUpdate') return;
      if (typeof msg.width === 'number') width = msg.width;
      if (typeof msg.height === 'number') height = msg.height;
      beside = msg.beside !== false;
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'requestBrowserViewport' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<SettingRow id="browserViewport" {filter}>
  {#snippet control()}
    <span class="vp">
      <input class="num" type="number" min="50" max="9999" aria-label="Screenshot viewport width" bind:value={width} onchange={commit} />
      <span class="times">×</span>
      <input class="num" type="number" min="50" max="9999" aria-label="Screenshot viewport height" bind:value={height} onchange={commit} />
      <button class="reset" onclick={reset} title="Back to 1920x1080">Reset</button>
    </span>
  {/snippet}
</SettingRow>
<BrowserRevealRow {filter} />
<SettingRow id="browserBeside" {filter}>
  {#snippet control()}<OnOffSwitch checked={beside} label="Open the browser beside the chat" onchange={toggleBeside} />{/snippet}
</SettingRow>

<style>
  .vp { display: inline-flex; align-items: center; gap: 6px; }
  .num {
    width: 64px; background: var(--og-bg); border: 1px solid var(--og-input-border); color: var(--og-text);
    border-radius: 6px; padding: 4px 8px; font: inherit; font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .num:focus { outline: none; border-color: var(--og-chat); }
  .times { color: var(--og-text-muted); font-size: 11px; }
  .reset { font: inherit; font-size: 10.5px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--og-text-secondary); }
  .reset:hover { color: var(--og-text); text-decoration: underline; }
</style>
