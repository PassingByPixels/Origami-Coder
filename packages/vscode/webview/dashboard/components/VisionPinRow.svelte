<script lang="ts">
  // The Vision control's body: Auto / On / Profile, and the profile list one
  // of them opens. The rules live in visionTriad.ts; this file renders that
  // table.
  //
  // This component posts its own pin click. The profile half does not:
  // InputBar owns the profile write and its optimistic echo, since the pin
  // has no optimistic state to keep in step — the host owns it and answers
  // with a fresh `modelStatus`.
  //
  // Auto clears both the pin and the profile: they are different scopes (a
  // model, a chat), and clearing only one would leave an armed describer
  // running while the control still said Auto.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { type VisionState } from './visionPinState';
  import { TRIAD_CHOICES, visionTriad, type TriadChoice } from './visionTriad';

  let { vision, sessionId, profile = '', agents = [], native = false, onSelect }: {
    vision: VisionState;
    sessionId: string;
    /** The vision profile armed on THIS CHAT's session row ('' = none). */
    profile?: string;
    agents?: string[];
    /** This chat's model reads images itself — the engine then drops the profile. */
    native?: boolean;
    /** Arm a profile ('' = none). InputBar owns this write. */
    onSelect?: (slug: string) => void;
  } = $props();

  const vscode = getVsCodeApi();
  const t = $derived(visionTriad({ vision, profile, agents, native }));
  /** The pin's own value, distinct from which choice is active: a model on
   *  Auto with a describer armed still shows Profile. */
  const pinMode = $derived(vision === 'on' ? 'on' : vision === 'off' ? 'off' : 'auto');
  // Opens on the Profile choice, or starts open when a profile is already
  // the answer, so reopening shows which one instead of a blank list.
  let subsOpen = $state<boolean | null>(null);
  const subs = $derived(subsOpen ?? t.active === 'profile');
  // Shown only after a pin click here, not standing, so the note stays
  // meaningful. A profile change never raises it (it takes effect instantly).
  let justChanged = $state(false);

  function pick(c: TriadChoice) {
    if (c.mode === 'profile') { subsOpen = !subs; return; }
    if (c.mode !== pinMode) {
      justChanged = true;
      vscode.postMessage({ type: 'setVisionPin', mode: c.wire, sessionId });
    }
    if (c.mode === 'auto' && profile) onSelect?.('');
  }
</script>

<div class="pin-line">{t.line}</div>
<div class="pin-row">
  {#each TRIAD_CHOICES as c (c.mode)}
    {#if c.mode !== 'profile' || t.showProfile}
      <button class="pin-btn" class:active={t.active === c.mode} title={c.title} onclick={() => pick(c)}>
        <span class="pin-name">{c.name}</span>
        <span class="pin-scope">{c.mode === 'auto' ? t.autoNote : c.scope}</span>
      </button>
    {/if}
  {/each}
  {#if t.showLegacyOff}
    <!-- Retired, not forgotten: a stored 'off' pin is still obeyed, so it is
         still shown. Not a button — there is nothing to set it TO. -->
    <span class="pin-btn pin-legacy" class:active={t.active === 'off'}
      title="You pinned this model as unable to read images. That choice is still in force. Auto clears it.">
      <span class="pin-name">Off</span>
      <span class="pin-scope">pinned</span>
    </span>
  {/if}
</div>
{#if subs && t.showProfile}
  <div class="pin-subs">
    <button class="vision-item" class:active={!profile} onclick={() => onSelect?.('')}>None</button>
    {#each agents as slug (slug)}
      <button class="vision-item" class:active={profile === slug} onclick={() => onSelect?.(slug)}>@{slug}</button>
    {/each}
  </div>
{/if}
{#if justChanged}
  <div class="pin-note">Applies from your next message — the engine re-reads this model's capabilities as the change lands.</div>
{/if}

<style>
  .pin-line { padding: 4px 8px 2px; font-size: 10px; color: var(--og-text-secondary); }
  .pin-row { display: flex; gap: 2px; padding: 0 4px 4px; }
  .pin-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font: inherit;
    font-size: 11px;
    padding: 3px 6px;
    border: 1px solid var(--og-border);
    border-radius: 4px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    cursor: pointer;
    text-align: left;
  }
  .pin-btn:hover { color: var(--og-text); border-color: var(--og-chat); }
  /* The picked choice takes the crane tone the armed profile takes one row down,
     so "this is the current answer" reads the same in both halves of the menu. */
  .pin-btn.active { color: var(--og-text); border-color: var(--og-crane); }
  /* WHICH SCOPE a choice acts on, under its name. The pin is a fact about the
     model and the profile a fact about the chat; without this the two read as
     one setting with three values, which is how the old stack got misread. */
  .pin-scope { font-size: 9px; color: var(--og-text-muted); }
  /* The legacy chip is not interactive and must not pretend to be. */
  .pin-legacy { cursor: default; }
  .pin-legacy:hover { color: var(--og-text-secondary); border-color: var(--og-border); }
  .pin-subs { display: flex; flex-direction: column; gap: 2px; padding: 0 4px 4px; }
  /* Moved verbatim from VisionProfileMenu.svelte with the list itself. */
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
  .pin-note { padding: 2px 8px 6px; font-size: 10px; line-height: 1.45; color: var(--og-text-muted); }
</style>
