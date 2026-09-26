<script module lang="ts">
  // Claude (subscription, experimental) — the Connections card (t-tsw90t)
  // and its tile in the connection strip (t-ty02bb).
  //
  // The status lives HERE, module-wide, because two places read it: the tile
  // (ControlStrip.svelte adds `claudeSubscriptionTiles(...)` to its carousel)
  // and this card, which opens and closes from that tile exactly as a
  // provider's settings fold does. On 0.4.170 the card sat above the strip
  // whenever the setting was on and could not be hidden.
  //
  // Readiness, the label and the fix line are all computed HOST-SIDE
  // (claudeSubscriptionCard.ts): nothing here is mirrored from src/, it only
  // renders the strings it is sent. The Connections Refresh answer
  // (`modelListsRefreshed`) asks again: the engine re-ran Gate B on that press.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { gridLabel, lightOf } from './providerGrid';

  export const CLAUDE_SUB_TILE_ID = '__claude-subscription';
  const status = $state({ enabled: false, ready: false, label: '', fixLine: '', cli: '' });
  let asked = false;

  function requestStatus(): void {
    asked = true;
    getVsCodeApi().postMessage({ type: 'requestClaudeSubscriptionStatus' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'modelListsRefreshed') requestStatus();
    if (msg.type !== 'claudeSubscriptionStatus') return;
    status.enabled = !!msg.enabled;
    status.ready = !!msg.ready;
    status.label = typeof msg.label === 'string' ? msg.label : '';
    status.fixLine = typeof msg.fixLine === 'string' ? msg.fixLine : '';
    status.cli = typeof msg.cli === 'string' ? msg.cli : '';
  });

  /** The strip's tile: none while the setting is off. Coloured and labelled by
   *  providerGrid.ts, the rule every provider tile uses. The first call asks
   *  the host (not the import: the webview API is not ready then in tests). */
  export function claudeSubscriptionTiles(open: boolean, inuse: boolean) {
    if (!asked) requestStatus();
    if (!status.enabled) return [];
    // t-xu5o64: the short name, as in the model picker ("Claude (Sub)/<model>"). The tile has
    // no "Pill name" fold to shorten it, and "Claude (subscription)" was cut to "Claude (subscri...".
    const light = { name: 'Claude (Sub)', live: status.ready, reason: status.fixLine || undefined };
    return [{ id: CLAUDE_SUB_TILE_ID, label: 'CS', title: gridLabel(light), light: lightOf(light), open, dotted: false, inuse }];
  }
</script>

<script lang="ts">
  const vscode = getVsCodeApi();

  function disconnect(): void {
    vscode.postMessage({ type: 'claudeSubscriptionDisconnect' });
  }

  // Mounted when the tile opens it: ask again, so an open card is never stale.
  requestStatus();
</script>

{#if status.enabled}
  <div class="claude-sub-card">
    <div class="claude-sub-head">
      <span class="claude-sub-title">Claude (subscription, experimental)</span>
      <span class="claude-sub-status" class:live={status.ready}>{status.label}</span>
    </div>
    {#if status.fixLine}
      <span class="claude-sub-hint">{status.fixLine}</span>
    {/if}
    {#if status.cli}
      <span class="claude-sub-hint">{status.cli}</span>
    {/if}
    <span class="claude-sub-hint">An open chat keeps its current engine. Start a new chat to use this connection.</span>
    <div class="claude-sub-row">
      <button class="claude-sub-disconnect" onclick={disconnect}>Disconnect</button>
    </div>
  </div>
{/if}

<style>
  .claude-sub-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 12px 10px;
    background: var(--og-pane-header);
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
  }
  .claude-sub-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .claude-sub-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: var(--og-text);
  }
  .claude-sub-status {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--og-warning);
  }
  .claude-sub-status.live { color: var(--og-success); }
  .claude-sub-hint {
    font-size: 10px;
    color: var(--og-text-muted);
    line-height: 1.35;
  }
  .claude-sub-row {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .claude-sub-disconnect {
    padding: 5px 12px;
    font-size: 11px;
    background: transparent;
    color: var(--og-error, #ef5350);
    border: 1px solid color-mix(in srgb, var(--og-error, #ef5350) 40%, var(--og-border));
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: background 0.12s ease;
  }
  .claude-sub-disconnect:hover { background: color-mix(in srgb, var(--og-error, #ef5350) 12%, transparent); }
</style>
