<script lang="ts">
  // t-kgtr6c — the composer's ONE Vision control.
  //
  // Round 2 shipped TWO for one subject: this button ("Eye") and a separate
  // read-out chip ("👁 Vision") that lit whenever the chat's model declared
  // image input. They never agreed — the chip could be lit (this model sees)
  // beside a button offering to route around a model that cannot. Round 3 folds
  // them, and `native` is the fold.
  //
  // What each state must do is a TABLE, and it lives in visionButtonState.ts
  // (extracted when the fold took this file 12 lines past its cap). This file
  // draws the answer and reports the clicks; it decides nothing.
  //
  // A LEAF, extracted at birth: InputBar.svelte had ONE line of slack under its
  // own cap. It owns no state and posts nothing — InputBar holds `visionProfile`
  // and does the posting.
  //
  // A LIST, not a notch rail. The approve control's three notches are a scale
  // from ask to yolo; profiles are unordered names, and a rail would imply a
  // severity they do not have.
  import { visionButtonState } from './visionButtonState';
  import VisionPinRow from './VisionPinRow.svelte';
  import { visionPinLine, type VisionState } from './visionPinState';

  let { profile, agents, open, native = false, visionState = 'auto-off', sessionId = '', onToggle, onSelect, onClose }: {
    profile: string;
    agents: string[];
    open: boolean;
    /** This chat's model declares image input of its own (`isVlm`). */
    native?: boolean;
    /** Auto-vs-pinned vision + the session the pin row posts against (grid-safe). */
    visionState?: VisionState;
    sessionId?: string;
    onToggle: () => void;
    onSelect: (slug: string) => void;
    onClose: () => void;
  } = $props();

  const state = $derived(visionButtonState({ native, profile, agents }));
</script>

<div class="vision-wrap">
  <button class="mode-btn vision-btn" class:active={state.lit} class:native onclick={onToggle}
    title={`${state.title}\n${visionPinLine(visionState)}`}>{state.label}</button>
  {#if open}
    <button class="vision-backdrop" aria-label="Close vision selector" onclick={onClose}></button>
    <div class="vision-pop">
      <!-- In EVERY branch, native included: the state most worth correcting is a model that claims it sees and cannot. -->
      <VisionPinRow vision={visionState} {sessionId} />
      {#if state.pop === 'picker'}
        <button class="vision-item" class:active={!profile} onclick={() => onSelect('')}>Off</button>
        {#each agents as slug (slug)}
          <button class="vision-item" class:active={profile === slug} onclick={() => onSelect(slug)}>@{slug}</button>
        {/each}
      {:else}
        <!-- A note, not a menu: there is nothing here a click could change. -->
        <div class="vision-empty">{state.note}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vision-wrap { position: relative; display: inline-flex; }
  /* Byte-identical to InputBar's own `.mode-btn`: this button sits in that row
     and a second size would read as a different KIND of control. */
  .mode-btn {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .mode-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  /* The armed state takes the crane tone the vision chip already uses on the
     agent card, so one capability reads the same in both places. */
  .mode-btn.vision-btn.active { color: var(--og-crane); border-color: var(--og-crane); }
  /* NATIVE is a different fact from ARMED, so it takes a different tone and is
     declared last — a model can be both (armed, then switched), and the tone
     the user must read is the one saying the route is not running. */
  .mode-btn.vision-btn.native { color: var(--og-accent); border-color: var(--og-accent); }
  .vision-backdrop {
    position: fixed; inset: 0; z-index: 19;
    background: transparent; border: none; padding: 0; margin: 0; cursor: default;
  }
  .vision-pop {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 150px;
    max-width: 260px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  }
  .vision-item {
    text-align: left;
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--og-text-secondary);
    cursor: pointer;
  }
  .vision-item:hover { color: var(--og-text); border-color: var(--og-border); }
  .vision-item.active { color: var(--og-text); border-color: var(--og-crane); }
  .vision-empty { padding: 6px 8px; font-size: 10px; line-height: 1.45; color: var(--og-text-muted); }
</style>
