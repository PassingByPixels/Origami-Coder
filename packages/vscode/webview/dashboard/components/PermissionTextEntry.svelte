<script lang="ts">
  // The permission bar's free-text sub-panel: a focused textarea, a submit and
  // a way back.
  //
  // EXTRACTED from PermissionBar.svelte, which stood at 243 of its 245-line cap
  // when the "Other" answer landed — the ratchet's remedy is extraction, so the
  // Revise block came out here before a line went in. It now serves BOTH the
  // plan-mode "Revise" path and M4.4's free-text answer to a question, which is
  // the reason it is one component and not two: the two are the same object
  // (type something, send it with the chosen option) and a second copy of this
  // markup would be a second place for them to drift apart.
  interface Props {
    placeholder: string;
    /** The line under the box explaining what pressing submit will DO. */
    hint: string;
    submitLabel: string;
    /** Called with the trimmed text. Never fires empty — the button is disabled
     *  and the keyboard shortcut is a no-op until there is something to send. */
    onSubmit: (text: string) => void;
    onCancel: () => void;
  }
  let { placeholder, hint, submitLabel, onSubmit, onCancel }: Props = $props();

  let text = $state('');

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
  }

  // Focus the box the moment it appears — it replaced the buttons the user was
  // just looking at, so the caret belongs in it without a second click.
  function autofocus(node: HTMLTextAreaElement) {
    node.focus();
  }
</script>

<textarea
  class="pte-input"
  bind:value={text}
  {placeholder}
  rows="3"
  onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
  use:autofocus
></textarea>
<div class="pte-buttons">
  <button class="pte-btn primary" disabled={!text.trim()} onclick={submit}>{submitLabel}</button>
  <button class="pte-btn" onclick={onCancel}>Back</button>
</div>
<div class="pte-hint">{hint} — ⌘/Ctrl+Enter to send.</div>

<style>
  /* Carried across verbatim from PermissionBar's .revise-input / .revise-hint /
     .perm-btn rules — Svelte scopes styles per component, so they live here with
     the markup they dress. */
  .pte-input {
    width: 100%;
    margin-bottom: 8px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
    color: var(--og-text);
    background: var(--og-input-bg);
    border: 1px solid var(--og-input-border);
    border-radius: 4px;
    resize: vertical;
  }

  .pte-input:focus {
    outline: none;
    border-color: var(--og-chat);
  }

  .pte-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .pte-btn {
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--og-border);
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    border-radius: 3px;
    font-family: inherit;
  }

  .pte-btn:hover {
    background: var(--og-btn-hover);
  }

  .pte-btn.primary {
    background: var(--og-chat);
    color: var(--og-bg);
    border-color: var(--og-chat);
  }

  .pte-btn.primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .pte-hint {
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--og-text-muted);
  }
</style>
