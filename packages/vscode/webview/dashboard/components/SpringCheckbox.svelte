<script lang="ts">
  // SpringCheckbox.svelte — t-qn0wj5, proposal 25 (port of Mock-Redesign
  // CHANGES.md #40's SpringCheck, react-bits Micro/SpringCheck). A real native
  // checkbox with a spring-eased custom box; the input keeps ordinary checkbox
  // semantics (keyboard, screen reader, :checked) and `onchange` fires exactly
  // as a bare `<input type="checkbox">` would — only the paint differs.
  //
  // Extracted out of RepoHeader.svelte (its first use, the real "Auto-approve
  // agent permissions" checkbox), which sat under its 140-line cap until this
  // styling pushed it to 178 — extraction first, per WORKING_ON_ORIGAMI_CODER.md
  // Part 4, rather than raising the cap. A named leaf also means the next
  // checkbox that wants this treatment reuses it instead of a third copy of
  // the CSS.
  interface Props {
    checked: boolean;
    onchange: (checked: boolean) => void;
    label?: string;
  }
  let { checked, onchange, label }: Props = $props();
</script>

<input
  class="og-spring-check"
  type="checkbox"
  {checked}
  aria-label={label}
  onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
/>

<style>
  /* The overshoot curve is a standard CSS "back" ease — the closest a plain
     transition gets to the reference's damped rAF spring. */
  .og-spring-check {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin: 0;
    flex-shrink: 0;
    position: relative;
    border: 1.5px solid var(--og-border);
    border-radius: 4px;
    background: var(--og-surface);
    cursor: pointer;
    transition: background 140ms ease, border-color 140ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }
  .og-spring-check:checked {
    background: var(--og-chat);
    border-color: var(--og-chat);
    transform: scale(1.08);
  }
  .og-spring-check::after {
    content: '';
    position: absolute;
    left: 4px;
    top: 1px;
    width: 4px;
    height: 8px;
    border: solid var(--og-bg);
    border-width: 0 2px 2px 0;
    opacity: 0;
    transform: scale(0.4) rotate(45deg);
    transition: opacity 120ms ease 30ms, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1) 30ms;
  }
  .og-spring-check:checked::after {
    opacity: 1;
    transform: scale(1) rotate(45deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .og-spring-check,
    .og-spring-check::after {
      transition-duration: 80ms;
      transition-timing-function: linear;
    }
    .og-spring-check:checked { transform: none; }
  }
</style>
