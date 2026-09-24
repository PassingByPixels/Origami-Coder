<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // The composer's SECOND OPINION trigger — the scales, immediately left of the
  // focus eye at the right-hand end of the changes row.
  //
  // Its OWN file on the pattern FocusEye.svelte set beside it: the row is a row,
  // and what sits at either end of it is a leaf. The glyph is drawn inline (a
  // beam, a pillar, two pans) because the webview ships no icon library and a
  // single 13px pair of scales does not justify pulling one in — the same
  // reasoning, verbatim, that the eye next to it carries.
  //
  // It owns NO state. Whether the flyout is open is the row's business (a grid
  // can show twelve composers and only one menu may be open in each), and
  // whether the button is live at all is the composer's: a turn in flight has no
  // completed work to review.
  interface Props {
    /** The flyout is open — the button reads as pressed. */
    open: boolean;
    /** A turn is running. The review reads the LAST COMPLETED turn, so offering
     *  it mid-turn would either review the previous turn while the user is
     *  looking at a newer one, or race the one being written. */
    disabled?: boolean;
    /** Open or close the flyout. The caller owns the flag. */
    onToggle: () => void;
  }
  let { open, disabled = false, onToggle }: Props = $props();
</script>

<button
  class="second-opinion"
  class:on={open}
  aria-pressed={open}
  aria-label="Second opinion"
  {disabled}
  use:tip={disabled
    ? 'Second opinion — available once the current turn finishes'
    : 'Second opinion — have another model review this turn'}
  onclick={onToggle}
>
  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 4v16" />
    <path d="M7 20h10" />
    <path d="M4 7h16" />
    <path d="M4 7 1.5 13h5Z" />
    <path d="M20 7l2.5 6h-5Z" />
  </svg>
</button>

<style>
  /* Borrows the eye's muted-outline idiom exactly — the two sit shoulder to
     shoulder, and a different resting weight would read as one of them being
     lit. No vertical margin: the row it sits in has no vertical padding on
     purpose (0.4.60 UAT), and a margin here would put it back.
     NO `margin-left: auto` either, unlike the eye: flexbox splits leftover
     space EQUALLY between every auto margin on a line, so a second one would
     have parked the scales in the middle of the row instead of beside the eye.
     The row positions the pair (ChangesPill's `.row-end`); this leaf does not
     decide where it sits. */
  .second-opinion {
    display: inline-flex;
    align-items: center;
    padding: 1px 5px;
    font: inherit;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    opacity: 0.8;
  }
  .second-opinion:hover:not(:disabled) { opacity: 1; color: var(--og-text-secondary); border-color: var(--og-border); }
  .second-opinion:focus-visible { outline: 1px solid var(--og-chat); outline-offset: 1px; }
  /* OPEN is carried by colour AND a border, the eye's rule: a 13px glyph on a
     17px strip cannot signal state by tint alone. */
  .second-opinion.on {
    color: var(--og-accent);
    border-color: var(--og-accent);
    opacity: 1;
  }
  /* Visibly dead rather than merely inert — a control that swallows clicks
     without looking disabled reads as a broken button. */
  .second-opinion:disabled { opacity: 0.35; cursor: default; }
</style>
