<script lang="ts">
  // t-kgsdsw — the compaction gauge's right-click (and keyboard) menu: pick a
  // custom auto-compaction threshold instead of the engine's cfg-derived
  // default. A pure picker — no vscode api import, no postMessage of its
  // own — the CALLER (InputBar) owns the wire, same split ModelPicker draws
  // between its menu markup and InputBar's setEffort/setApproveMode posts.
  //
  // The value this reports is the RAW string the engine's `compactionThreshold`
  // configId parses (see acp/service.ts): '' clears it, 'NN%' is a fraction of
  // the model's context window, a bare integer is an absolute token count.
  interface Props {
    open: boolean;
    /** The currently-applied raw value ('' = auto/default), so the active
     *  choice can be highlighted. This is an OPTIMISTIC client-side echo (see
     *  InputBar's comment) — it reflects the last selection made THIS
     *  session, not a read-back of the engine's persisted override. */
    current: string;
    onSelect: (value: string) => void;
    onClose: () => void;
  }
  let { open, current, onSelect, onClose }: Props = $props();

  const PERCENT_OPTIONS = [50, 60, 70, 80, 90];

  let customDraft = $state('');
  function pickPercent(pct: number) {
    onSelect(`${pct}%`);
  }
  function pickAuto() {
    onSelect('');
  }
  function submitCustom() {
    const trimmed = customDraft.trim();
    if (!trimmed) return;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return;
    onSelect(String(Math.floor(n)));
    customDraft = '';
  }
  function customKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submitCustom(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
  function focusOnMount(node: HTMLInputElement) { node.focus(); }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') onClose(); }} />

{#if open}
  <!-- Full-screen transparent catcher, same idiom ModelPicker's .mp-backdrop
       uses: any click outside the menu closes it. -->
  <button class="ctm-backdrop" aria-label="Close menu" onclick={onClose}></button>
  <div class="ctm-menu" role="menu" aria-label="Auto-compaction threshold">
    <div class="ctm-label">Auto-compact when context reaches:</div>
    <button
      class="ctm-option"
      class:active={current === ''}
      role="menuitemradio"
      aria-checked={current === ''}
      onclick={pickAuto}
    >Auto (default)</button>
    {#each PERCENT_OPTIONS as pct (pct)}
      <button
        class="ctm-option"
        class:active={current === `${pct}%`}
        role="menuitemradio"
        aria-checked={current === `${pct}%`}
        onclick={() => pickPercent(pct)}
      >{pct}% of context</button>
    {/each}
    <div class="ctm-custom">
      <!-- type="text" deliberately, not "number": Svelte's bind:value coerces a
           number-input's value to a NUMBER, but customDraft is a string here
           ('' means empty) — inputmode gives the same numeric keyboard on
           mobile without that coercion. -->
      <input
        class="ctm-custom-input"
        type="text"
        inputmode="numeric"
        placeholder="Custom token count"
        bind:value={customDraft}
        use:focusOnMount
        onkeydown={customKey}
        aria-label="Custom token count" />
      <button class="ctm-custom-set" onclick={submitCustom} disabled={!customDraft.trim()}>Set</button>
    </div>
  </div>
{/if}

<style>
  .ctm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
  }
  .ctm-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 41;
    width: 220px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
  }
  .ctm-label {
    font-size: 10px;
    color: var(--og-text-muted);
    padding: 0 4px 3px;
  }
  .ctm-option {
    text-align: left;
    font-size: 12px;
    padding: 5px 8px;
    background: transparent;
    color: var(--og-text);
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .ctm-option:hover { background: var(--og-btn-hover); }
  .ctm-option.active { background: color-mix(in srgb, var(--og-accent) 16%, transparent); color: var(--og-text); }
  .ctm-custom {
    display: flex;
    gap: 4px;
    margin-top: 3px;
    padding-top: 6px;
    border-top: 1px solid var(--og-border);
  }
  .ctm-custom-input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 11px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    padding: 4px 6px;
    outline: none;
  }
  .ctm-custom-input:focus { border-color: var(--og-accent); }
  .ctm-custom-set {
    flex: 0 0 auto;
    font-size: 11px;
    padding: 4px 9px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .ctm-custom-set:hover:not(:disabled) { border-color: var(--og-chat); color: var(--og-text); }
  .ctm-custom-set:disabled { opacity: 0.45; cursor: default; }
</style>
