<script lang="ts">
  // The room's FLAVOR — a chain, or a council.
  //
  // IT SITS ON THE HOP BAR, beside the width, because the bar is already where
  // "how much may this room do before it comes back to me" is answered, and
  // this is the third face of that question: the cap is how many turns one
  // message buys, the width is how many happen at once, and this is what a turn
  // IS. Following CollabWidthControl.svelte's home rather than inventing a
  // second place for room settings is the point.
  //
  // ITS OWN COMPONENT for the same reason the width is: the hop bar sits near
  // its cap, and the ratchet's remedy for that is a module.
  //
  // A TOGGLE, NOT A PICKER. There are two flavors, and a picker for two values
  // is a dropdown a user has to open to learn what is in it. The button says
  // what pressing it DOES, which is the one thing a two-state control can say
  // that a label cannot.
  //
  // IT NEVER ASSERTS THE NEW FLAVOR LOCALLY. The flip is never refused on
  // permissions — council round turns are sealed read-only engine-side
  // (COUNCIL_SEAL) instead — but an unknown flavor or an archived room still
  // refuses, so this sends, the mutation re-polls, and the line redraws from
  // whatever actually stuck. A control that flipped itself would show a
  // council the engine refused to make.

  interface Props {
    /** What the engine reports, RESOLVED. Absent = an engine without the mode. */
    flavor?: 'discuss' | 'council';
    archived: boolean;
    onApply: (flavor: 'discuss' | 'council') => void;
  }
  let { flavor, archived, onApply }: Props = $props();

  const council = $derived(flavor === 'council');
  /** What the room IS, not what the button does — those are opposite words and
   *  putting them in one control is how a toggle becomes ambiguous. */
  const line = $derived(council ? 'council' : 'discuss');
  const action = $derived(council ? 'Make it a discussion' : 'Make it a council');
</script>

<span class="fl-text">room: {line}</span>
<button
  class="fl-apply"
  class:on={council}
  disabled={archived}
  title={council
    ? 'One question at a time, each speaker reading the last. Back to the ordinary room.'
    : 'One question to EVERY member at once, none of them reading another, then one of them reconciles the round.'}
  onclick={() => onApply(council ? 'discuss' : 'council')}
>{action}</button>

<style>
  /* Repeated rather than lifted to a shared sheet, exactly as
     CollabWidthControl.svelte's are: Svelte scopes styles per component, so the
     bar's own `.cap-*` rules do not reach in here, and three declarations is
     cheaper than a fourth file. */
  .fl-text { font-size: 10px; color: var(--og-text-muted); flex: 0 0 auto; }
  .fl-apply {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
  }
  .fl-apply:hover:not(:disabled) { border-color: var(--og-chat); color: var(--og-text); }
  .fl-apply.on { border-color: color-mix(in srgb, var(--og-accent-2) 55%, var(--og-border)); color: var(--og-text); }
  .fl-apply:disabled { opacity: 0.5; cursor: default; }
</style>
