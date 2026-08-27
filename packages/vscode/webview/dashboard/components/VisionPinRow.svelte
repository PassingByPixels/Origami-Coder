<script lang="ts">
  // The Vision tri-state row, inside the Vision popover.
  //
  // A LEAF, extracted at birth: VisionProfileMenu.svelte had 8 lines under its
  // own cap and this row is ~50. It also sits in EVERY branch of that popover —
  // native, empty and picker alike — because a pin is a fact about the model,
  // and the one state a user most needs to change is the one where the model
  // currently claims it can see and cannot.
  //
  // IT POSTS ITS OWN CLICK, which VisionProfileMenu deliberately does not do
  // (InputBar owns the profile write). The reason is arithmetic, not taste:
  // routing this through InputBar costs a handler, a prop and a callback in a
  // file with FOUR lines under its cap. The pin has no optimistic echo to keep
  // in step either — the host owns it in globalState and answers with a fresh
  // `modelStatus`, so there is no local copy here to disagree with.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { VISION_MODES, visionPinState, type VisionState } from './visionPinState';

  let { vision, sessionId }: { vision: VisionState; sessionId: string } = $props();

  const vscode = getVsCodeApi();
  const row = $derived(visionPinState(vision));
  // Shown ONLY after a click in this popover. The engine reads model
  // capabilities once, when it builds the provider — no TTL, no fs watch — so a
  // pin changes what the NEXT engine believes. Standing the note there
  // permanently would train the user to ignore it; showing it on the change is
  // the moment it is true.
  let justChanged = $state(false);

  function pick(wire: string) {
    if (row.mode === (wire || 'auto')) return; // already the answer — no write, no note
    justChanged = true;
    vscode.postMessage({ type: 'setVisionPin', mode: wire, sessionId });
  }
</script>

<div class="pin-line">{row.line}</div>
<div class="pin-row">
  {#each VISION_MODES as m (m.mode)}
    <button class="pin-btn" class:active={row.mode === m.mode} title={m.title}
      onclick={() => pick(m.wire)}>{m.name}</button>
  {/each}
</div>
{#if justChanged}
  <div class="pin-note">Applies after a window reload — the engine reads model capabilities once, when it starts.</div>
{/if}

<style>
  .pin-line { padding: 4px 8px 2px; font-size: 10px; color: var(--og-text-secondary); }
  .pin-row { display: flex; gap: 2px; padding: 0 4px 4px; }
  .pin-btn {
    flex: 1;
    font: inherit;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--og-border);
    border-radius: 4px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    cursor: pointer;
  }
  .pin-btn:hover { color: var(--og-text); border-color: var(--og-chat); }
  /* The picked mode takes the crane tone the armed profile takes one row down,
     so "this is the current answer" reads the same in both halves of the menu. */
  .pin-btn.active { color: var(--og-text); border-color: var(--og-crane); }
  .pin-note { padding: 2px 8px 6px; font-size: 10px; line-height: 1.45; color: var(--og-text-muted); }
</style>
