<script lang="ts">
  // One bot's own memory, READ ONLY — extracted from CollabAgentsPane.svelte,
  // which the panel pushed to 389 of its 380-line cap.
  //
  // WHY READ ONLY. A bot's store is written by the bot, through its `remember`
  // tool, into a directory keyed to its definition file. The board's job is to
  // let a human SEE what a character has been carrying between sessions, and to
  // wipe it wholesale when that history has gone stale. A per-line editor here
  // would be a second writer of a file the engine owns the format of.
  //
  // The DIRECTORY is named on purpose, the same way the injected block names it
  // to the bot: this panel is a bounded summary of a real folder, and the next
  // question after reading it is always "where is that".
  interface Props {
    slug: string;
    facts: number;
    text: string;
    dir: string;
    onClose: () => void;
  }
  let { slug, facts, text, dir, onClose }: Props = $props();
</script>

<div class="bm-panel">
  <div class="bm-head">
    <span class="bm-title">{slug} — {facts} fact{facts === 1 ? '' : 's'} kept</span>
    <button class="bm-btn" onclick={onClose}>Close</button>
  </div>
  <div class="bm-dir">{dir}</div>
  {#if text}
    <pre class="bm-text">{text}</pre>
  {:else}
    <div class="bm-empty">Nothing kept yet. This bot's own `remember` tool writes here, and what it keeps is injected at the top of its next turn.</div>
  {/if}
</div>

<style>
  .bm-panel { margin: 0 12px 8px; padding: 8px 10px; border: 1px solid var(--og-border); border-radius: 6px; background: var(--og-surface); }
  .bm-head { display: flex; align-items: center; gap: 8px; }
  .bm-title { flex: 1 1 auto; font-size: 12px; font-weight: 600; color: var(--og-text); }
  .bm-btn {
    font-size: 11px;
    padding: 4px 9px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .bm-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .bm-dir { margin-top: 3px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--og-text-muted); overflow-wrap: anywhere; }
  /* Bounded height: a long-lived bot's store is prose and this panel sits above
     the list it belongs to, so it must not push every card off the screen. */
  .bm-text { margin: 6px 0 0; max-height: 220px; overflow: auto; font-size: 11px; line-height: 1.5; white-space: pre-wrap; color: var(--og-text-secondary); }
  .bm-empty { margin-top: 6px; font-size: 11px; font-style: italic; line-height: 1.5; color: var(--og-text-muted); }
</style>
