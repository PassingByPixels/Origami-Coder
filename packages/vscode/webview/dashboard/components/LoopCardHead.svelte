<script lang="ts">
  // LoopCardHead — the identity + controls row of a loop card, extracted from
  // LoopCard.svelte at its cap when the reopen control landed.
  //
  // Reopen is offered ONLY where there is a chat to bring back (loopRows.ts's
  // canReopenChat): a headless loop, or one whose chat did not survive a
  // restore. On a row whose chat is already open it is absent rather than
  // present-and-inert — a control that does nothing when pressed teaches you
  // nothing about why.
  import PersistSwitch from './PersistSwitch.svelte';

  interface Props {
    /** The chat this loop belongs to. EMPTY means there is no chat identity to
     *  show (a needs-attention row) — the card says so rather than leaving a
     *  blank where a chat name goes. */
    label?: string;
    intervalLabel: string;
    persistent: boolean;
    /** Renders the reopen control. False on a row whose chat is already open. */
    canReopen: boolean;
    ontoggle: () => void;
    onreopen: () => void;
    oncancel: () => void;
  }
  const { label = '', intervalLabel, persistent, canReopen, ontoggle, onreopen, oncancel }: Props = $props();
</script>

<div class="loop-head">
  <span class="loop-chat">{label || 'Chat unavailable'}</span>
  <span class="loop-interval">every {intervalLabel}</span>
  <PersistSwitch checked={persistent} onchange={ontoggle} />
  {#if canReopen}
    <button class="loop-reopen" onclick={onreopen}
      title="Open this loop's chat in an editor tab — the runs it has been doing are in that transcript.">Reopen chat</button>
  {/if}
  <button class="loop-cancel" onclick={oncancel} title="Cancel this loop">Cancel</button>
</div>

<style>
  .loop-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .loop-chat { font-weight: 600; font-size: 12px; color: var(--og-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 80px; }
  .loop-interval { flex-shrink: 0; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--og-chat); background: var(--og-btn-bg); padding: 1px 6px; border-radius: 8px; }
  .loop-reopen, .loop-cancel {
    flex-shrink: 0; background: var(--og-btn-bg); border: 1px solid var(--og-border);
    color: var(--og-text-secondary); border-radius: 4px; cursor: pointer; padding: 1px 7px; font-size: 10px;
  }
  .loop-reopen:hover { background: var(--og-btn-hover); color: var(--og-text); border-color: var(--og-accent); }
  .loop-cancel:hover { background: var(--og-error-soft); color: var(--og-error-text); border-color: var(--og-error); }
</style>
