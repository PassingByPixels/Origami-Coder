<script lang="ts">
  // The History popup's "show Claude chats too" switch (t-463pb6).
  //
  // ITS OWN COMPONENT because HistoryDropdown.svelte is the shared panel (the
  // Collabs half draws archived rooms in it) and it sits close to its 165-line
  // cap. A control only one caller passes belongs beside the panel, not inside
  // it — and the panel keeps deciding nothing about kinds.
  //
  // A LABELLED BUTTON, not a checkbox: the row it lives on is 8px type in a
  // dropdown, where a native checkbox draws at the host's own scale and breaks
  // the line. `aria-pressed` carries the state for a screen reader, which is
  // what a checkbox would have given us and the only part worth keeping.
  interface Props {
    /** True = Claude rows are in the list. */
    on: boolean;
    onChange: (next: boolean) => void;
    /** The mark drawn on the rows this hides — passed in so the button and the
     *  rows cannot come to disagree about which symbol means Claude. */
    mark: string;
  }
  let { on, onChange, mark }: Props = $props();
</script>

<button
  class="kind-toggle"
  class:on
  aria-pressed={on}
  onclick={() => onChange(!on)}
  title={on ? 'Hide Claude Code chats from this list' : 'Show Claude Code chats in this list too'}
>
  <span class="kind-mark" aria-hidden="true">{mark}</span>
  <span class="kind-label">{on ? 'shown' : 'hidden'}</span>
</button>

<style>
  .kind-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 8px 6px;
    padding: 3px 7px;
    font-family: inherit;
    font-size: 10px;
    color: var(--og-text-muted);
    background: transparent;
    border: 1px dashed var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    align-self: flex-start;
  }
  .kind-toggle:hover { background: var(--og-btn-bg); }
  /* DOTTED and dim when off, solid accent when on — the same dashed-border
     language ControlStrip.svelte uses for the Claude Code square, which is a
     harness rather than a connection we configured. */
  .kind-toggle.on { color: var(--og-text); border-color: var(--og-accent); }
  .kind-mark { font-weight: 600; letter-spacing: 0.04em; }
  .kind-label { text-transform: lowercase; }
</style>
