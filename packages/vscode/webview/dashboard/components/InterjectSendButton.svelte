<script lang="ts">
  // InterjectSendButton.svelte — t-ru13hb item 1.
  //
  // WHY IT EXISTS. While a turn runs the composer's single control is Stop, and
  // stopping is a 600ms HOLD: a plain click on it does nothing on purpose
  // (holdToStop.ts). Enter was therefore the ONLY way to put a line into a
  // running turn, and a user working with the mouse had no route in at all.
  //
  // This is that route: a smaller glyph of the same `.action-btn` family, left
  // of Stop, shown only while a turn runs AND the textarea has text. It calls
  // the composer's own `doSend`, so the message, the queue rules and the
  // attachments are whatever Enter already does — one send path, not two.
  //
  // Its own file because InputBar.svelte is a capped file and this is a whole
  // control (its own arrow, its own size, its own appear rule), the same seam
  // SendStopButton.svelte took.
  import { tip } from '../../shared/warmTip';

  interface Props {
    onSend: () => void;
    disabled?: boolean;
  }
  let { onSend, disabled = false }: Props = $props();
</script>

<button
  class="action-btn interject-send"
  type="button"
  {disabled}
  aria-label="Send into the running turn"
  onclick={onSend}
  use:tip={'Send this into the running turn (same as Enter)'}
>
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
    fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
    <path d="M12 4.5L18.5 11L14.25 11L14.25 19.5L9.75 19.5L9.75 11L5.5 11Z" />
  </svg>
</button>

<style>
  /* Deliberately NOT the 34px send/stop square: this is the secondary of the
     two, and equal weight would read as two competing sends. Quiet surface,
     accent ink — it is an addition to a turn, not the turn's own control. */
  .interject-send {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--og-border);
    border-radius: 7px;
    background: var(--og-btn-bg);
    color: var(--og-accent);
    cursor: pointer;
    transition: background-color 200ms ease, color 200ms ease;
  }
  .interject-send:hover { background: var(--og-btn-hover); color: var(--og-chat); }
  .interject-send:disabled { opacity: 0.45; cursor: not-allowed; }
  .interject-send:focus-visible { outline: 2px solid var(--og-chat); outline-offset: 2px; }
  /* Nothing here animates on mount, so there is no motion to reduce — the
     transition above is a hover colour and already honours the media query
     through the rule below. */
  @media (prefers-reduced-motion: reduce) {
    .interject-send { transition: none; }
  }
</style>
