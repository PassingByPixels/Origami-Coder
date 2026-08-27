<script lang="ts">
  // Branded in-webview confirm dialog — replaces jarring native OS modals for
  // in-panel irreversible actions so the confirm matches the Origami look
  // (og-* tokens + fold accent). Keyboard: Esc cancels, Enter confirms; the
  // confirm button autofocuses; clicking the backdrop cancels. Reusable —
  // driven entirely by props, no action-specific logic here.
  interface Props {
    open: boolean;
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Optional leading glyph/emoji shown next to the title. */
    icon?: string;
    /** Accent colour of the top border. */
    tone?: 'default' | 'warning' | 'danger';
    onConfirm: () => void;
    onCancel: () => void;
  }
  let {
    open,
    title,
    body = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    icon = '',
    tone = 'default',
    onConfirm,
    onCancel,
  }: Props = $props();

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
  }
  // Focus the confirm button the moment the dialog opens.
  function autofocus(node: HTMLButtonElement) { node.focus(); }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="cm-backdrop" role="presentation" onclick={onCancel}>
    <div
      class="cm-card"
      class:warning={tone === 'warning'}
      class:danger={tone === 'danger'}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onclick={(e) => e.stopPropagation()}
    >
      <div class="cm-head">
        {#if icon}<span class="cm-icon" aria-hidden="true">{icon}</span>{/if}
        <span class="cm-title">{title}</span>
      </div>
      {#if body}<p class="cm-body">{body}</p>{/if}
      <div class="cm-actions">
        <button class="cm-btn" onclick={onCancel}>{cancelLabel}</button>
        <button class="cm-btn primary" onclick={onConfirm} use:autofocus>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    animation: cm-fade 120ms ease-out;
  }
  .cm-card {
    width: min(380px, calc(100vw - 48px));
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-top: 3px solid var(--og-chat);
    border-radius: 10px;
    padding: 16px 18px 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
    animation: cm-rise 140ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .cm-card.warning { border-top-color: var(--og-warning); }
  .cm-card.danger { border-top-color: var(--og-error); }
  .cm-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .cm-icon { font-size: 16px; line-height: 1; }
  .cm-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--og-text);
  }
  .cm-body {
    margin: 0 0 14px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--og-text-muted);
  }
  .cm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .cm-btn {
    padding: 5px 14px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    border: 1px solid var(--og-border);
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    border-radius: 5px;
  }
  .cm-btn:hover { background: var(--og-btn-hover); }
  .cm-btn.primary {
    background: var(--og-chat);
    color: var(--og-bg);
    border-color: var(--og-chat);
    font-weight: 600;
  }
  .cm-btn.primary:hover { filter: brightness(1.08); }
  @keyframes cm-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes cm-rise {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
