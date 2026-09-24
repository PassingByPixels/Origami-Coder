<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // Tweak 2 — sticky mirror of the most recent user message pinned above the
  // transcript. Display-only: the real row stays in the log. Renders nothing
  // with no text. t-l1soc4: click toggles it open to the full untruncated
  // message; resets to collapsed whenever `text` changes (a new turn).
  interface Props {
    /** The last user message's text. Empty string renders nothing. */
    text: string;
  }
  let { text }: Props = $props();

  let expanded = $state(false);
  $effect(() => { text; expanded = false; });
  const toggle = () => (expanded = !expanded);
</script>

{#if text}
  <div
    class="pinned-user"
    class:expanded
    role="button"
    tabindex="0"
    aria-expanded={expanded}
    use:tip={expanded ? '' : text}
    onclick={toggle}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
  >
    <span class="pinned-label">You:</span>
    <span class="pinned-text">{text}</span>
  </div>
{/if}

<style>
  /* CHANGES.md change 23 — a SOFT FADE, not a box. A border, a radius and a
     drop shadow made this a third card competing with the turns under it; the
     gradient says where the pinned line ends instead. */
  .pinned-user {
    position: sticky;
    top: 0;
    z-index: 6;
    display: flex;
    align-items: baseline;
    gap: 6px;
    /* 10 + 3 is the 5 + 8 this band always occupied: the gradient gets room to
       fade in, paid for out of the margin, so the band's HEIGHT does not move
       and SideQuestsDrawer's 72px top — built from it — stays right. */
    margin: 0 0 3px 0;
    padding: 5px 10px 10px;
    font-size: 11.5px;
    background: linear-gradient(to bottom,
      color-mix(in srgb, var(--og-surface, #1e1e2e) 85%, transparent) 0%, transparent 100%);
    cursor: pointer;
  }
  /* Expanded: full text, un-stickied so it doesn't hog the top while open. */
  .pinned-user.expanded { position: static; align-items: flex-start; }
  .pinned-label { flex: 0 0 auto; font-weight: 600; color: var(--og-chat); }
  /* CLAMPED, not ellipsised: expanding is then one value, 1 line to 8. */
  .pinned-text {
    flex: 1 1 auto;
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--og-text-secondary);
  }
  .pinned-user.expanded .pinned-text { -webkit-line-clamp: 8; }
</style>
