<script lang="ts">
  // The Browser card's reveal row: when the agent's browser tab may be brought to
  // the front. A leaf of its own rather than three more blocks in
  // BrowserSettings.svelte, which was at 160 of its 175-line cap — and it earns
  // the split: it owns one setting end to end, so it moves with the card when
  // t-qc1d69 carries the card to Insights.
  //
  // MIRROR of src/browserReveal.ts's RevealPolicy. A webview .ts/.svelte cannot
  // import a runtime value from src/ (rootDir), so the three values are written
  // here too; browserSettings.test.ts reads BOTH files and fails if they drift.
  //
  // Host wire: browserViewportUpdate carries `reveal`; this posts setBrowserReveal.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import SettingRow from './SettingRow.svelte';

  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();

  const POLICIES = [
    { value: 'never', label: 'Never' },
    { value: 'first', label: 'First open' },
    { value: 'always', label: 'Always' },
  ];

  let reveal = $state('first');

  function commit() {
    vscode.postMessage({ type: 'setBrowserReveal', value: reveal });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type !== 'browserViewportUpdate') return;
      if (typeof msg.reveal === 'string') reveal = msg.reveal;
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<SettingRow id="browserReveal" {filter}>
  {#snippet control()}
    <select class="pick" aria-label="Bring the browser tab to the front" bind:value={reveal} onchange={commit}>
      {#each POLICIES as policy (policy.value)}
        <option value={policy.value}>{policy.label}</option>
      {/each}
    </select>
  {/snippet}
</SettingRow>

<style>
  .pick {
    font: inherit; font-size: 10.5px; padding: 2px 4px; color: var(--og-text); background: var(--og-bg);
    border: 1px solid var(--og-input-border); border-radius: 5px; min-width: 96px;
  }
</style>
