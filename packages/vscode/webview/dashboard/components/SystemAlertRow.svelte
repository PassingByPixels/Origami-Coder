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
  import ToolIcon from './ToolIcon.svelte';
  import TravelLine from './TravelLine.svelte';

  interface Props {
    row?: StreamDropRow;
    alert?: { state: 'retrying' | 'recovered' | 'stopped'; title: string; detail: string };
    /** Send the turn again. Omitted in a read-only transcript, which hides Retry. */
    onRetry?: () => void;
    /** t-x3a89j: the engine card's Copy details and Open engine log (only when the host sent details). */
    onCopy?: () => void;
    onOpenLog?: () => void;
  }
  let { row, alert, onRetry, onCopy, onOpenLog }: Props = $props();

  const state = $derived(alert?.state ?? (row ? streamDropState(row) : 'stopped'));
  const title = $derived(alert?.title ?? (row ? streamDropTitle(state, row.notice) : ''));
  const detail = $derived(alert?.detail ?? row?.notice.detail ?? '');
  // t-yyz5yk (Round 8 D): retry glyph + moving line while retrying; tick, still, once recovered.
  const icon = $derived(state === 'recovered' ? 'check' : state === 'stopped' ? 'alert' : 'retry');
</script>

<div class="alert" class:is-retrying={state === 'retrying'} class:is-ok={state === 'recovered'}
     class:is-stopped={state === 'stopped'} class:is-engine={!!alert} role="status" data-state={state}>
  <span class="alert-icon" aria-hidden="true"><ToolIcon name={icon} size={13} /></span>
  <span class="alert-body">
    <span class="alert-title">{title}</span>
    <span class="alert-text">{detail}</span>
  </span>
  {#if state === 'stopped' && onCopy}<button class="alert-action" type="button" onclick={onCopy} use:tip={'Copy why and when the engine failed, for a bug report'}>Copy details</button>{/if}
  {#if state === 'stopped' && onOpenLog}<button class="alert-action" type="button" onclick={onOpenLog} use:tip={'Open the engine log file (origami.log) in an editor'}>Open engine log</button>{/if}
  {#if state === 'stopped' && onRetry}
    <button class="alert-retry" type="button" onclick={onRetry}
      use:tip={alert ? "Start this chat's engine again. A message that waits is sent once it is up." : 'Send your last message again'}>Retry</button>
  {/if}
  {#if state === 'retrying'}<TravelLine color={alert ? 'var(--og-chat)' : 'var(--og-error)'} />{/if}
</div>

<style>
  /* t-yyz5yk (Round 8 D): a ROW, not a box: 2px rail, faint wash, line icon. */
  .alert {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 6px 0;
    padding: 5px 10px;
    border: 0;
    border-radius: 7px;
    overflow: hidden;
    font-size: 11px;
    line-height: 1.4;
    transition: background-color 350ms ease, box-shadow 350ms ease;
  }
  .alert-icon {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px; height: 15px;
    margin-top: 1px;
  }
  @media (prefers-reduced-motion: reduce) { .alert { transition: none; } }
  .alert-body { flex: 1 1 auto; min-width: 0; }
  .alert-title { display: block; font-weight: 700; }
  .alert-text {
    display: block;
    margin-top: 1px;
    overflow-wrap: anywhere;
    opacity: 0.85;
  }
  .alert-retry, .alert-action {
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
  .alert-retry:hover, .alert-action:hover { background: var(--og-surface); }
  .alert-retry:focus-visible, .alert-action:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .alert.is-retrying,
  .alert.is-stopped {
    color: var(--og-text);
    background: color-mix(in srgb, var(--og-error) 9%, transparent);
    box-shadow: inset 2px 0 0 var(--og-error);
  }
  .alert.is-retrying .alert-icon,
  .alert.is-stopped .alert-icon { color: var(--og-error); }
  .alert.is-stopped .alert-retry { color: var(--og-error-text); }
  /* The chat's own engine STARTING is work, not a failure: chat colour. */
  .alert.is-engine.is-retrying {
    background: color-mix(in srgb, var(--og-chat) 7%, transparent);
    box-shadow: inset 2px 0 0 var(--og-chat);
  }
  .alert.is-engine.is-retrying .alert-icon { color: var(--og-chat); }
  /* Reconnected: grey rail, a tick, and still. */
  .alert.is-ok {
    color: var(--og-text-muted);
    background: transparent;
    box-shadow: inset 2px 0 0 var(--og-border);
  }
  .alert.is-ok .alert-icon { color: var(--og-success); }
</style>
