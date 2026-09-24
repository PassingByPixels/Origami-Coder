<script lang="ts">
  // TodoClearButton.svelte — the Todo panel header's "Clear completed" control
  // (t-h8gv8w). Its own file because TodoStrip.svelte was at 348/360 when the
  // control landed and the ratchet's remedy is an extraction, not a raise; the
  // seam is real enough anyway — the strip owns the panel, the header and the
  // list, this owns one action and how it looks when there is nothing to do.
  //
  // WHAT IT DOES NOT DO. It holds no state and knows no keys: which rows are
  // hidden is todoClear.ts's rule and the pane's state. This reports a click.
  //
  // DISABLED, NEVER HIDDEN. A control that appears the moment the agent ticks
  // an item off and vanishes when the list is rewritten makes the header jump
  // under the eye. It is always drawn, and greys out when there is nothing
  // completed on the selected tab.
  interface Props {
    /** Nothing completed on this tab — the click would be a no-op. */
    disabled: boolean;
    onClear: () => void;
  }
  let { disabled, onClear }: Props = $props();
</script>

<!-- stopPropagation because the header is itself a click target in the
     re-expandable snapshot mode: clearing must not also fold the list. -->
<button
  class="todo-clear"
  title="Hide the completed items on this tab (the agent's own list is untouched)"
  {disabled}
  onclick={(e) => { e.stopPropagation(); onClear(); }}
>Clear completed</button>

<style>
  /* Quiet by default, legible on hover: clearing is a deliberate act, not the
     thing the eye should land on first. `margin-left: auto` puts it at the
     panel's right edge, away from the counts it must not be misread as.
     t-qn0lpl — a quiet 18px BUTTON, not an underlined link. The underline was
     the only link in a panel of buttons, and it read as a hyperlink out of the
     chat. The border is transparent until hover, so the box never moves. */
  .todo-clear {
    margin-left: auto;
    flex: 0 0 auto;
    height: 18px;
    padding: 0 6px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 9.5px;
    font-weight: 400;
    color: var(--og-muted, #6c7086);
  }
  .todo-clear:hover:not(:disabled) { color: var(--og-text, #cdd6f4); border-color: var(--og-border, #45475a); }
  .todo-clear:disabled { cursor: default; opacity: 0.45; }
</style>
