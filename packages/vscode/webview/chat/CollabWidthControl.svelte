<script lang="ts">
  // The room's DISPATCH WIDTH — how many participant turns run AT ONCE.
  //
  // Its own component rather than more markup in CollabHopBar.svelte, which was
  // 121 lines against a 145 cap: the control plus its rules is 35, and the
  // ratchet's remedy for that is a module, not a raised cap.
  //
  // IT SITS ON THE HOP BAR because it answers the same question as the budget
  // from the other side: the cap is how MANY turns one message buys, this is
  // how many of them happen at the same time. Both are "how much may this room
  // do before it comes back to me".
  //
  // IT IS NOT THE CAP, and none of the cap's spellings carry over:
  //   - There is no blank-means-default. 1 IS the default and it is a number.
  //   - There is no 0-means-off. An "off" width would be a room with no ceiling
  //     on parallel turns, which is the one thing this must never be able to
  //     say. Anything below 1 is refused rather than clamped.
  //   - The ENGINE can refuse a raise: a room may only widen when every member
  //     is read-only for files (CollabParallel's gate). So this never asserts
  //     the new width locally — it sends, the mutation re-polls, and the line
  //     below redraws from whatever actually stuck.

  interface Props {
    /** What the engine reports. null/absent = never set, which is serial. */
    concurrency: number | null;
    onApply: (concurrency: number) => void;
  }
  let { concurrency, onApply }: Props = $props();

  let draft = $state<number | null>(null);

  /** null and 1 are the SAME room — one turn at a time — so both read "serial"
   *  rather than one of them reading as a blank where a fact belongs. */
  const line = $derived(!concurrency || concurrency <= 1 ? 'serial' : `${concurrency} at once`);

  function apply() {
    if (draft === null || !Number.isFinite(draft) || draft < 1) return;
    onApply(Math.trunc(draft));
  }
</script>

<span
  class="width-text"
  title="Parallel turns — how many agents may take a turn at once. Raising it needs every member to be file-read-only."
>turns: {line}</span>
<input
  class="width-input"
  type="number"
  min="1"
  placeholder="1"
  bind:value={draft}
  aria-label="How many agent turns run at once — 1 is one at a time"
  onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
/>
<button class="width-apply" onclick={apply}>Set width</button>

<style>
  /* Svelte scopes styles per component, so the bar's `.cap-input` / `.cap-apply`
     rules do not reach in here. Repeated rather than lifted to a shared sheet:
     three declarations is cheaper than a fourth file, and the bar's own rules
     stay readable as the bar's. */
  .width-text { font-size: 10px; color: var(--og-text-muted); flex: 0 0 auto; }
  .width-input {
    width: 56px;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 3px 6px;
    outline: none;
  }
  .width-input:focus { border-color: var(--og-accent); }
  .width-apply {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .width-apply:hover { border-color: var(--og-chat); color: var(--og-text); }
</style>
