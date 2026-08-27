<script lang="ts">
  // Pillar 3 dashboard upgrade (2026-05-22) — Cmd-K / Ctrl-K palette.
  // Today the only way to discover slash commands is to type `/` in
  // the input bar and watch the autocomplete dropdown. The palette
  // makes them globally discoverable: open from anywhere with one
  // shortcut, fuzzy search, Enter to dispatch.
  //
  // Shares the same command list shape + categorisation as the
  // InputBar dropdown via `lib/slashCommands.ts`. The wire format
  // (extension's `availableCommands` post + `slashCommand` request)
  // is unchanged.

  import { getVsCodeApi } from '../../shared/vscodeApi';
  import {
    type SlashCommand,
    filterCommands,
  } from '../lib/slashCommands';

  interface Props {
    open: boolean;
    commands: SlashCommand[];
    onClose: () => void;
  }

  let { open, commands, onClose }: Props = $props();

  const vscode = getVsCodeApi();

  let query = $state('');
  let selectedIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  let filtered = $derived(filterCommands(commands, query));

  // Reset query + focus the input every time the palette is shown.
  $effect(() => {
    if (open) {
      query = '';
      selectedIdx = 0;
      // Defer focus until the DOM has rendered the input.
      queueMicrotask(() => inputEl?.focus());
    }
  });

  function dispatch(cmd: SlashCommand) {
    const stripped = cmd.name.replace(/^\//, '');
    vscode.postMessage({ type: 'slashCommand', command: stripped, args: '' });
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIdx]) dispatch(filtered[selectedIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function handleBackdrop(e: MouseEvent) {
    // Only close when clicking the backdrop itself, not bubbling
    // from inside the palette card.
    if (e.target === e.currentTarget) onClose();
  }
</script>

{#if open}
  <div
    class="palette-backdrop"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="Slash command palette"
    tabindex="-1"
  >
    <div class="palette">
      <input
        bind:this={inputEl}
        type="text"
        class="palette-input"
        placeholder="Type a command name or description…"
        bind:value={query}
      />
      <ul class="palette-list">
        {#each filtered as cmd, i (cmd.name)}
          <li
            class="palette-item"
            class:selected={i === selectedIdx}
            onmouseenter={() => selectedIdx = i}
            onclick={() => dispatch(cmd)}
            role="option"
            aria-selected={i === selectedIdx}
          >
            <div class="palette-row-main">
              <span class="palette-name">{cmd.name}</span>
              <span class="palette-category">{cmd.category}</span>
            </div>
            <div class="palette-desc">{cmd.description}</div>
          </li>
        {/each}
        {#if filtered.length === 0}
          <li class="palette-empty">No commands match “{query}”.</li>
        {/if}
      </ul>
      <div class="palette-footer">
        <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close
      </div>
    </div>
  </div>
{/if}

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 80px;
  }

  .palette {
    width: 520px;
    max-width: calc(100vw - 32px);
    max-height: 60vh;
    background: var(--og-surface, #1e1e2e);
    border: 1px solid var(--og-border, #45475a);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .palette-input {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--og-border, #45475a);
    padding: 10px 12px;
    color: var(--og-text, #cdd6f4);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
    outline: none;
  }

  .palette-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .palette-item {
    padding: 6px 12px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .palette-item.selected {
    background: var(--og-btn-bg, rgba(255, 255, 255, 0.06));
    border-left-color: var(--og-accent, #89b4fa);
  }

  .palette-row-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .palette-name {
    color: var(--og-accent, #89b4fa);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    font-weight: 600;
  }

  .palette-category {
    color: var(--og-text-muted, #6c7086);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .palette-desc {
    color: var(--og-text-secondary, #a6adc8);
    font-size: 11px;
    margin-top: 2px;
  }

  .palette-empty {
    padding: 12px;
    color: var(--og-text-muted, #6c7086);
    font-style: italic;
    text-align: center;
  }

  .palette-footer {
    padding: 6px 12px;
    border-top: 1px solid var(--og-border, #45475a);
    color: var(--og-text-muted, #6c7086);
    font-size: 10px;
  }

  .palette-footer kbd {
    background: var(--og-btn-bg, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--og-border, #45475a);
    border-radius: 3px;
    padding: 1px 5px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
  }
</style>
