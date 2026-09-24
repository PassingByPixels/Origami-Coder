<script lang="ts">
  // The model picker with NOTHING configured.
  //
  // A fresh install used to land on a provider nobody added: upstream's OpenCode
  // Zen autoloaded its free tier under a public key, so the picker opened on
  // `opencode` / `big-pickle` and the composer footer named a hosted model the
  // user had never connected to (owner report, work PC, no connection). The
  // engine no longer enables it (provider/provider.ts), which leaves the picker
  // genuinely empty — and an empty dropdown is its own lie, because it looks
  // like a load that failed.
  //
  // So the empty list SAYS the thing: one non-selectable row naming the state,
  // and one control that goes where the state is fixed. The row is `aria-
  // disabled` rather than absent because a listbox with no options at all reads
  // to a screen reader as a bug, not as a step in setup.
  //
  // The picker still never establishes a connection itself — the rule
  // ModelPicker.test.ts pins. `openConnections` reveals the sidebar and asks
  // ControlStrip to open the Add-provider fold it already owns; no config is
  // written here, and nothing is probed.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { NO_CONNECTIONS_TEXT } from './modelBanner';
  const vscode = getVsCodeApi();

  interface Props {
    /** True once the host's FIRST providerStatus answer has landed. Before it,
     *  "no connections" is not yet a fact — it is an unanswered question, and
     *  flashing the empty state at every picker open would be the same kind of
     *  guess this component exists to remove. */
    ready?: boolean;
  }
  let { ready = false }: Props = $props();
</script>

<div class="nc" role="listbox" aria-label="Models">
  {#if !ready}
    <div class="nc-row" role="option" aria-selected="false" aria-disabled="true">Loading models…</div>
  {:else}
    <div class="nc-row" role="option" aria-selected="false" aria-disabled="true">{NO_CONNECTIONS_TEXT}</div>
    <button class="nc-add" onclick={() => vscode.postMessage({ type: 'openConnections' })}
      title="Open the Origami sidebar's connection settings and start a new provider">
      &#65291; Add provider
    </button>
  {/if}
</div>

<style>
  .nc { display: flex; flex-direction: column; gap: 6px; padding: 6px; }
  /* Same muted weight .mp-empty carried, so the swap is a change of CONTENT
     and not of loudness. */
  .nc-row { font-size: 10px; color: var(--og-text-muted); line-height: 1.35; cursor: default; }
  .nc-add {
    align-self: flex-start;
    padding: 4px 9px;
    font-size: 10px;
    font-family: inherit;
    color: var(--og-text);
    background: transparent;
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease;
  }
  .nc-add:hover { border-color: var(--og-chat); color: var(--og-chat); }
</style>
