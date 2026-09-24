<script lang="ts">
  // DensityCard.svelte — Settings › Chat › "Chat row density" (t-qn0wj5
  // proposal 26; moved from Insights to the Settings view as a row, t-s9jr6u).
  // Comfortable/Compact for the chat pane: a segmented control, read from the
  // injected global at start and written by the host. The "reload" pill on the
  // row says the value is read when the chat pane opens.
  //
  // Persisted PER WINDOW via workspaceState (chatDensity.ts, host-side). A
  // change raises an InlineToast (proposal 25) naming the density now stored.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import InlineToast from './InlineToast.svelte';
  import SettingRow from './SettingRow.svelte';
  import { chatDensityCompactFromGlobal } from '../panes/chatDensityClass';

  let { filter = '' }: { filter?: string } = $props();
  const vscode = getVsCodeApi();
  let compact = $state(chatDensityCompactFromGlobal(window));
  let toastText: string | null = $state(null);
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function commit(on: boolean): void {
    if (on === compact) return;
    compact = on;
    vscode.postMessage({ type: 'setChatDensity', compact: on });
    toastText = on ? 'Compact density' : 'Comfortable density';
  }
</script>

<SettingRow id="density" {filter}>
  {#snippet control()}
    <span class="seg" role="radiogroup" aria-label="Chat row density">
      <button role="radio" aria-checked={compact} class:is-sel={compact} onclick={() => commit(true)}>Compact</button>
      <button role="radio" aria-checked={!compact} class:is-sel={!compact} onclick={() => commit(false)}>Comfortable</button>
    </span>
  {/snippet}
</SettingRow>

{#if toastText}
  <div class="dc-toast-host">
    <InlineToast text={toastText} title="View" {reducedMotion} onDismiss={() => (toastText = null)} />
  </div>
{/if}

<style>
  /* Segmented control: the connection-tile look, one cell selected. */
  .seg { display: inline-flex; border: 1px solid var(--og-border); border-radius: 6px; overflow: hidden; }
  .seg button { font: inherit; font-size: 10.5px; padding: 3px 10px; border: 0; background: var(--og-btn-bg); color: var(--og-text-secondary); cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--og-border); }
  .seg button.is-sel { background: var(--og-btn-hover); color: var(--og-text); box-shadow: inset 0 -2px 0 var(--og-chat); }
  .dc-toast-host { position: fixed; right: 14px; bottom: 14px; z-index: 70; }
</style>
