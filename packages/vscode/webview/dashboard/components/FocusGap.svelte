<script lang="ts">
  // The mark focus view leaves where it hid a run of rows — a hairline with a
  // count on it: "38 tools · 16 file reads · 2 thoughts".
  //
  // IT MUST NOT READ AS A MESSAGE. The whole value of focus view is that the
  // transcript becomes only what was said, so anything drawn between two
  // answers has to be furniture: no bubble, no surface, no avatar, no card
  // border. A hairline with muted 10px text on it is deliberately the quietest
  // thing this codebase draws.
  //
  // AND IT MUST NOT LOOK CLICKABLE. There is no expand: the control that brings
  // the rows back is the composer's eye (FocusEye.svelte), one place, always in
  // the same spot. A divider that looked interactive would promise a disclosure
  // it does not have — so no button, no role, no hover state, and the title
  // says where the real control is.
  //
  // It owns NO state and does NO counting: focusGaps.ts wrote the wording, and
  // the whole of what can be wrong is asserted there with no DOM in the way.
  interface Props {
    /** The finished wording from focusGaps.ts. Rendered verbatim. */
    label: string;
  }
  let { label }: Props = $props();
</script>

<div class="focus-gap" title="Hidden by focus — click the eye to show everything">
  <span class="focus-gap-rule" aria-hidden="true"></span>
  <span class="focus-gap-count">{label}</span>
  <span class="focus-gap-rule" aria-hidden="true"></span>
</div>

<style>
  /* Centred: the rules take the slack on both sides so the count sits mid-line
     whatever it says, and a long one (every family at once) shortens the rules
     instead of pushing the row wider than the transcript. */
  .focus-gap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 7px 2px 9px 2px;
    cursor: default;
    user-select: none;
  }
  .focus-gap-rule {
    flex: 1 1 auto;
    height: 1px;
    background: var(--og-border);
    opacity: 0.7;
  }
  /* 10px and muted — one step quieter than the verdict row above it, which is
     11px on a bordered surface. This is a count of what is NOT here; it must
     lose every contest with the prose it sits between. */
  .focus-gap-count {
    flex: 0 1 auto;
    font-size: 10px;
    line-height: 1.2;
    letter-spacing: 0.02em;
    color: var(--og-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
