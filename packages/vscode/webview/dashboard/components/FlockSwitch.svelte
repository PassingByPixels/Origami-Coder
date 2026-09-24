<script lang="ts">
  // A REAL ON/OFF AFFORDANCE, not a checkbox with a word beside it.
  //
  // It is the control that decides whether a stranger's question runs a model
  // against the owner's files without asking, so it has to READ as a decision.
  // A bare checkbox in a tile head reads as a preference.
  //
  // Its own file because the pane's head row is the one place it appears and
  // the pane is the wire; a switch is markup plus nine lines of CSS, which is
  // a leaf, not a paragraph of a wire.
  interface Props {
    checked: boolean;
    /** The accessible name, always. Also the visible words unless `text` says
     *  otherwise — in a 300px rail the track alone is what fits, and the chip
     *  around it already names what is being switched. */
    label: string;
    text?: string;
    onchange: (checked: boolean) => void;
  }
  let { checked, label, text, onchange }: Props = $props();
  let words = $derived(text === undefined ? label : text);
</script>

<label class="sw">
  <input type="checkbox" {checked} aria-label={label} onchange={(e) => onchange(e.currentTarget.checked)} />
  <span class="track"></span>{#if words}<span class="fk-sec">{words}</span>{/if}
</label>

<style>
  .sw { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .sw input { position: absolute; opacity: 0; pointer-events: none; }
  .track { width: 34px; height: 18px; border-radius: 999px; background: var(--og-input-bg); border: 1px solid var(--og-border); position: relative; flex: 0 0 auto; }
  .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--og-text-muted); transition: transform 0.15s, background 0.15s; }
  input:checked + .track { background: var(--og-success-soft); border-color: var(--og-success); }
  input:checked + .track::after { transform: translateX(16px); background: var(--og-success); }
  input:focus-visible + .track { outline: 1px solid var(--og-accent); outline-offset: 2px; }
</style>
