<script lang="ts">
  // SystemAlertRow.svelte — a dropped provider stream, drawn as a SYSTEM card
  // (t-q90gj9). NOT a MessageRow: the point is that the agent's name comes off.
  // The engine reported this, and it used to arrive as agent prose wearing the
  // agent's name, several attempts running together in one bubble.
  //
  // Three states, all on theme tokens from webview/shared/theme.css — retrying
  // (--og-warning, pulsing icon), recovered (--og-success), stopped
  // (--og-error, with Retry). There is no --og-green/-yellow/-red; every colour
  // here is a token that exists on all four palettes.
  //
  // Layout follows the mock in projects/Mock-Redesign (redesign.css .rd-alert).
  // The chat's own engine starting / failed / stopped uses this card too (t-v5qn37): it passes
  // `alert`, already worded by panes/engineNotice.ts, in place of a stream-drop `row`.
  import { streamDropState, streamDropTitle, type StreamDropRow } from '../panes/streamDropNotice';
  import { tip } from '../../shared/warmTip';

  interface Props {
    row?: StreamDropRow;
    alert?: { state: 'retrying' | 'recovered' | 'stopped'; title: string; detail: string };
    /** Send the turn again. Omitted in a read-only transcript, which hides Retry. */
    onRetry?: () => void;
  }
  let { row, alert, onRetry }: Props = $props();

  const state = $derived(alert?.state ?? (row ? streamDropState(row) : 'stopped'));
  const title = $derived(alert?.title ?? (row ? streamDropTitle(state, row.notice) : ''));
  const detail = $derived(alert?.detail ?? row?.notice.detail ?? '');
  const icon = $derived(state === 'recovered' ? '\u2713' : state === 'stopped' ? '!' : '\u21bb');
</script>

<div class="alert" class:is-retrying={state === 'retrying'} class:is-ok={state === 'recovered'}
     class:is-stopped={state === 'stopped'} role="status" data-state={state}>
  <span class="alert-icon" aria-hidden="true">{icon}</span>
  <span class="alert-body">
    <span class="alert-title">{title}</span>
    <span class="alert-text">{detail}</span>
  </span>
  {#if state === 'stopped' && onRetry}
    <button class="alert-retry" type="button" onclick={onRetry}
      use:tip={alert ? "Start this chat's engine again. A message that waits is sent once it is up." : 'Send your last message again'}>Retry</button>
  {/if}
</div>

<style>
  .alert {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin: 6px 0;
    padding: 9px 11px;
    border: 1px solid;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.4;
  }
  .alert-icon {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    margin-top: 1px;
    border: 1px solid currentColor;
    border-radius: 50%;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
  }
  .alert-body { flex: 1 1 auto; min-width: 0; }
  .alert-title { display: block; font-weight: 700; }
  .alert-text {
    display: block;
    margin-top: 1px;
    overflow-wrap: anywhere;
    opacity: 0.85;
  }
  .alert-retry {
    flex: 0 0 auto;
    align-self: center;
    padding: 4px 9px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 4px;
    cursor: pointer;
  }
  .alert-retry:hover { background: var(--og-surface); }
  .alert-retry:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .alert.is-retrying {
    color: var(--og-warning-text);
    background: var(--og-warning-soft);
    border-color: var(--og-warning);
  }
  .alert.is-ok {
    color: var(--og-success-text);
    background: var(--og-success-soft);
    border-color: var(--og-success);
  }
  .alert.is-stopped {
    color: var(--og-error-text);
    background: var(--og-error-soft);
    border-color: var(--og-error);
  }
  /* A live dot, so "retrying" reads as happening now rather than having happened. */
  .alert.is-retrying .alert-icon { animation: alert-pulse 1.4s ease-in-out infinite; }
  @keyframes alert-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
