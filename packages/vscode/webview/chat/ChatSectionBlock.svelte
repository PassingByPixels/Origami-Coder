<script lang="ts">
  // ChatSectionBlock.svelte — ONE collapsible chat-list section: the header
  // (chevron, name, count, optional extra control, optional delete), and the
  // row list below it (or an empty-state line while it holds nothing).
  //
  // EXTRACTED from ChatsList.svelte (t-kgserq v2) when Main/Loops/N-custom-
  // sections would otherwise have tripled the same header markup three ways.
  // t-r43glr (2026-08-14) retired the built-in Loops row (Main plus any
  // number of user sections remain) — this component stayed generic over
  // WHAT the header shows and WHETHER it can be renamed/deleted, so no
  // change was needed here beyond the doc comments below.
  // ChatsList.svelte still owns every row's own markup (drag handlers, open/
  // rename/close) and the section NAME's markup (plain text for Main,
  // name+pencil+dblclick-to-rename for a custom one) — both passed in as
  // snippets, since Svelte scopes a snippet's CSS to the file that WRITES
  // its markup, not the one that renders it. That is also why
  // `.session-name`/`.chat-section-name`/the rename inputs stay in
  // ChatsList.svelte's own <style>: this file never writes that markup.
  import type { Snippet } from 'svelte';

  interface Props {
    /** "Main section" / "{name} section" — the drop target's own
     *  aria-label, and (with Expand/Collapse prefixed) the chevron
     *  button's. */
    ariaLabel: string;
    count: number;
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** false for Main — the one fixed section, it cannot be removed. */
    deletable: boolean;
    onDelete?: () => void;
    emptyText: string;
    ondragover: (e: DragEvent) => void;
    ondrop: (e: DragEvent) => void;
    /** The name area: plain text for Main, name+pencil+rename-input for a
     *  custom one — authored by the caller (see file header). */
    nameSlot: Snippet;
    /** Main's "+ New section" control. Absent for every custom section —
     *  there is nowhere else on the header for it to make sense. */
    extra?: Snippet;
    /** The row list, or nothing at all when `count` is 0 (the empty-state
     *  line renders instead — see below). */
    children: Snippet;
  }
  let { ariaLabel, count, collapsed, onToggleCollapse, deletable, onDelete, emptyText, ondragover, ondrop, nameSlot, extra, children }: Props = $props();
</script>

<!-- The WHOLE header is a drop target, not just the chevron — a chat dragged
     anywhere onto this row should file into the section it names. -->
<div class="chat-section-header" role="group" aria-label={ariaLabel} {ondragover} {ondrop}>
  <button
    class="chat-section-chevron-btn"
    onclick={onToggleCollapse}
    aria-expanded={!collapsed}
    aria-label="{collapsed ? 'Expand' : 'Collapse'} {ariaLabel}"
  >
    <span class="chat-section-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
  </button>
  {@render nameSlot()}
  <span class="chat-section-count">{count}</span>
  {#if extra}{@render extra()}{/if}
  {#if deletable}
    <button class="chat-section-delete-btn" onclick={onDelete} title="Delete section" aria-label="Delete section">🗑</button>
  {/if}
</div>
{#if !collapsed}
  <div class="session-list chat-section-list" role="list">
    {#if count === 0}
      <div class="session-empty chat-section-empty">{emptyText}</div>
    {:else}
      {@render children()}
    {/if}
  </div>
{/if}

<style>
  .session-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px 6px;
  }
  .session-empty {
    padding: 8px 10px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
  }
  .chat-section-list { padding-top: 0; }
  .chat-section-empty { padding: 4px 10px 8px; }

  .chat-section-header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 8px;
    border-radius: 5px;
  }
  .chat-section-chevron-btn {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    padding: 4px 4px 4px 2px;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
  }
  .chat-section-chevron {
    font-size: 9px;
    color: var(--og-text-muted);
    flex: 0 0 auto;
  }
  .chat-section-count {
    font-size: 10px;
    color: var(--og-text-muted);
    flex: 0 0 auto;
  }
  .chat-section-delete-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 11px;
    padding: 0 5px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    opacity: 0;
    font-family: inherit;
  }
  .chat-section-header:hover .chat-section-delete-btn { opacity: 0.7; }
  .chat-section-delete-btn:hover { opacity: 1; color: var(--og-error); }
</style>
