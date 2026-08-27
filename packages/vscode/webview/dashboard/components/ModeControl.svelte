<script lang="ts">
  // The composer's session-mode control: ONE trigger, ONE popover, three
  // choices (Build / Plan / Deep Plan). It replaces the two-state Plan toggle
  // that used to live inline in InputBar.svelte, and it was extracted rather
  // than widened in place because InputBar sat at 1183 of its 1200-line cap
  // with no room for a third state's markup, popover and styles.
  //
  // The idiom is the Effort button a few controls to the left: a small trigger
  // that opens a panel over the composer, and a full-screen transparent backdrop
  // so the next click anywhere closes it.
  //
  // WHAT THE PANEL DRAWS is the ACCESS popover's dot slider, not a list of
  // buttons (owner UAT): the composer had two ways of picking one-of-N sitting
  // a few pixels apart, and this was the odd one out. ApproveRail.svelte is
  // mounted here UNCHANGED, so the two controls cannot drift apart by being
  // restyled separately; only the popover shell is duplicated, for the reason
  // the `.mode-btn` note below gives.
  //
  // STATE LIVES IN THE CALLER. InputBar owns `permissionMode` (the engine is
  // the authority; the panel echoes `modeUpdate` / `modeOptions`) and does the
  // posting. This component reports a click and draws what it is told, so there
  // is never a second copy of "what mode is this chat in".
  //
  // COLOUR CARRIES MEANING HERE, so every value below is an `--og-*` token: the
  // three states are told apart by the trigger's fill as much as by its text,
  // and a literal would be an invisible or unreadable ON state in whichever of
  // the five themes it clashed with. The one exception is the panel's drop
  // shadow, kept verbatim from InputBar's `.effort-pop` and ApprovePopover's
  // `.approve-pop` — a shadow is opacity over whatever is behind it rather than
  // a themed surface, there is no `--og-*` shadow var in this codebase, and a
  // fifth composer popover that alone had no shadow would read as a bug. That
  // single literal is why this file is not in THEMED_FILES; ModeControl.test.ts
  // carries the regex proof for the values that ARE colours instead.
  import ApproveRail from './ApproveRail.svelte';
  import { MODE_RAIL_OPTIONS, modeButtonLabel, modeButtonTitle, modeState } from './modeControl';

  let { current, onSelect }: { current: string; onSelect: (modeId: string) => void } = $props();

  let open = $state(false);

  const state = $derived(modeState(current));
  const label = $derived(modeButtonLabel(current));
  const title = $derived(modeButtonTitle(current));

  function pick(modeId: string) {
    open = false;
    onSelect(modeId);
  }
</script>

<div class="mode-wrap">
  <button
    class="mode-btn"
    class:active={state !== 'build'}
    class:plan-mode={state === 'plan'}
    class:deep-plan-mode={state === 'deep-plan'}
    onclick={() => (open = !open)}
    {title}>{label}</button>
  {#if open}
    <button class="mode-backdrop" aria-label="Close mode selector" onclick={() => (open = false)}></button>
    <!-- No stopPropagation on the panel, unlike the Effort and Approve popovers
         it copies: the backdrop is a SIBLING behind it (z-index 19 vs 20), not
         an ancestor, so a click in here never reaches it, and picking a mode
         closes the panel itself. A handler that guards nothing is a handler
         that only costs an a11y suppression. -->
    <div class="mode-pop">
      <div class="mode-pop-row">
        <div class="mode-pop-title">Mode:</div>
        <ApproveRail mode={state} options={MODE_RAIL_OPTIONS} onSelect={pick} />
      </div>
    </div>
  {/if}
</div>

<style>
  .mode-wrap { position: relative; display: inline-flex; }

  /* Duplicated from InputBar's `.mode-btn`, not shared: Svelte scopes styles to
     the component that writes the markup, so the trigger has to carry its own
     copy to sit level with the buttons either side of it. */
  .mode-btn {
    padding: 2px 8px;
    font-size: 10px;
    background: var(--og-surface);
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .mode-btn:hover {
    color: var(--og-text-secondary);
    background: var(--og-btn-bg);
  }
  /* Plan keeps the colour it always had. Deep Plan takes the brand's SECOND
     accent, which is the only tone in the set that is neither plan's nor an
     alarm: the approve button already owns success-green and error-red, and a
     mode reading as an error state would be a lie about a safe mode. */
  .mode-btn.plan-mode.active {
    background: var(--og-chat);
    border-color: var(--og-chat);
    color: var(--og-bg);
  }
  .mode-btn.deep-plan-mode.active {
    background: var(--og-accent-2);
    border-color: var(--og-accent-2);
    color: var(--og-bg);
  }

  .mode-backdrop {
    position: fixed; inset: 0; z-index: 19;
    background: transparent; border: none; padding: 0; margin: 0; cursor: default;
  }
  /* Same geometry as ApprovePopover's `.approve-pop`, kept in step deliberately
     — two panels that open from the same button row and differ only in padding
     read as a mistake. */
  .mode-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 200px;
    padding: 10px 16px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  /* ...and the same row shell: a short title LEFT of its own rail. */
  .mode-pop-row { display: flex; align-items: center; gap: 10px; }
  .mode-pop-title {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    color: var(--og-text-muted);
    white-space: nowrap;
  }
</style>
