<script lang="ts">
  // Shared context-length prompt markup, extracted from ModelPicker.svelte (t-lmqe0g)
  // so the SAME small input is not duplicated between the "this chat" LM Studio
  // load prompt and the new "sub-agents" context-override prompt — both ask for
  // one number and confirm/cancel the same way; only the label, hint and what the
  // number MEANS differ, which the caller supplies.
  interface Props {
    /** The model this prompt is for (label only). */
    modelName: string;
    /** Prefilled value ('' = blank). */
    initial: number | '';
    placeholder?: string;
    hint: string;
    confirmLabel?: string;
    onConfirm: (value: number | undefined) => void;
    onCancel: () => void;
  }
  let { modelName, initial, placeholder = 'default', hint, confirmLabel = 'Set', onConfirm, onCancel }: Props = $props();

  let draft = $state<number | ''>(initial);
  function confirm() {
    const n = typeof draft === 'number' ? draft : parseInt(String(draft), 10);
    onConfirm(Number.isFinite(n) && n > 0 ? n : undefined);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }
</script>

<div class="clp">
  <span class="clp-label">Context length for <b>{modelName}</b></span>
  <div class="clp-row">
    <input
      class="clp-input"
      type="number"
      min="1"
      step="1024"
      bind:value={draft}
      {placeholder}
      onkeydown={onKey}
      aria-label="Context length"
    />
    <button class="clp-go" onclick={confirm}>{confirmLabel}</button>
    <button class="clp-cancel" onclick={onCancel}>Cancel</button>
  </div>
  <span class="clp-hint">{hint}</span>
</div>

<style>
  .clp {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 7px;
    background: var(--og-input-bg);
    border: 1px solid var(--og-chat);
    border-radius: 6px;
  }
  .clp-label { font-size: 11px; color: var(--og-text-secondary); }
  .clp-label b { color: var(--og-text); font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
  .clp-row { display: flex; align-items: center; gap: 6px; }
  .clp-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 4px 7px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text);
    background: var(--og-surface);
    border: 1px solid var(--og-input-border);
    border-radius: 5px;
    outline: none;
  }
  .clp-input:focus { border-color: var(--og-chat); }
  .clp-go {
    padding: 4px 12px;
    font-size: 11px;
    background: var(--og-chat);
    color: var(--og-bg);
    border: 1px solid var(--og-chat);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .clp-cancel {
    padding: 4px 10px;
    font-size: 11px;
    background: transparent;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .clp-hint { font-size: 10px; color: var(--og-text-muted); }
</style>
