<script lang="ts">
  // The composer's ATTACHED-TEXT-FILE strip — ImageStrip.svelte's sibling for
  // a non-image drop. Purely presentational: which attachments exist, what
  // they hold and where they get folded into the outgoing prompt all stay in
  // the composer; this draws the row and reports a click on an ✕.

  interface Props {
    attachments: { id: number; name: string; content: string; truncated: boolean }[];
    onRemove: (id: number) => void;
  }
  let { attachments, onRemove }: Props = $props();

  function fmtSize(chars: number): string {
    if (chars < 1024) return `${chars} B`;
    if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
    return `${(chars / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="text-attachment-strip">
  {#each attachments as a (a.id)}
    <div class="text-attachment-chip" title={a.truncated ? `${a.name} — truncated to 256 KB` : a.name}>
      <span class="chip-name">{a.name}</span>
      <span class="chip-size">{fmtSize(a.content.length)}{a.truncated ? ' · truncated' : ''}</span>
      <button class="chip-remove" onclick={() => onRemove(a.id)} aria-label={`Remove ${a.name}`}>&times;</button>
    </div>
  {/each}
</div>

<style>
  .text-attachment-strip { display: flex; gap: 6px; padding: 6px 12px; overflow-x: auto; flex-wrap: wrap; }
  .text-attachment-chip {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 4px 3px 8px; max-width: 220px;
    border: 1px solid var(--og-border); border-radius: 4px;
    background: var(--og-btn-bg); font-size: 10px;
  }
  .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--og-text); }
  .chip-size { color: var(--og-text-muted); flex-shrink: 0; }
  .chip-remove {
    width: 16px; height: 16px; flex-shrink: 0;
    background: none; border: none; border-radius: 3px;
    color: var(--og-text-muted); cursor: pointer; font-size: 12px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  }
  .chip-remove:hover { background: var(--og-error); color: white; }
</style>
