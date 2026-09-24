<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // The composer's session-mode control: one trigger, one popover, three
  // choices (Build / Plan / Deep Plan). Same idiom as the Effort button: a
  // small trigger opens a panel over the composer, with a full-screen
  // transparent backdrop that closes it on the next click.
  //
  // ApproveRail.svelte is mounted here unchanged, so the two controls
  // cannot drift apart by being restyled separately.
  //
  // State lives in the caller: InputBar owns `permissionMode` and posts the
  // change; this component only reports a click and draws what it is told.
  //
  // Colour carries meaning here, so every value below is an `--og-*` token
  // — a literal would be unreadable in some theme. The one exception is the
  // panel's drop shadow, kept verbatim since no `--og-*` shadow var exists;
  // that literal is why this file is not in THEMED_FILES.
  import ApproveRail from './ApproveRail.svelte';
  import { MODE_RAIL_OPTIONS, modeButtonLabel, modeButtonTitle, modeState } from './modeControl';

  // `passthrough` = a Claude Code cell, where this drives CLAUDE's own plan
  // mode rather than an Origami mode agent; modeButtonLabel says so in the label.
  let { current, onSelect, passthrough = false }:
    { current: string; onSelect: (modeId: string) => void; passthrough?: boolean } = $props();

  let open = $state(false);

  const state = $derived(modeState(current));
  const label = $derived(modeButtonLabel(current, passthrough));
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
    use:tip={title}>{label}</button>
  {#if open}
    <button class="mode-backdrop" aria-label="Close mode selector" onclick={() => (open = false)}></button>
    <!-- No stopPropagation here, unlike the Effort and Approve popovers: the
         backdrop is a sibling behind this panel, not an ancestor, so a click
         inside never reaches it. -->
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
