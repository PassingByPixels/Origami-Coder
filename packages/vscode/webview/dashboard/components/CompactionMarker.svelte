<script lang="ts">
  // CompactionMarker — the /compact row, t-yyz5yk (Round 8 A). Moved out of
  // ChatTranscript.svelte with its styles (Svelte scopes <style> per
  // component). It is a DIVIDER across the transcript, not a card: two rules
  // that draw out from the middle and the words between them. A collapsed
  // native <details> keeps the carried-forward summary available on demand,
  // as before. The token count before and after ("142k → 38k") is not on the
  // row's data today, so the marker does not show it (see the lane report).
  interface Props {
    text: string;
    /** true while the compaction streams, false once it completes. */
    compacting?: boolean;
  }
  let { text, compacting = false }: Props = $props();
</script>

<details class="compaction-block" class:live={compacting}>
  <summary class="compaction-summary">
    <span class="compaction-rule l"></span>
    <span class="compaction-title">{compacting ? 'Compacting context…' : 'Context compacted'}</span>
    <span class="compaction-rule r"></span>
    {#if compacting}<span class="compaction-travel" aria-hidden="true"></span>{/if}
  </summary>
  <pre class="compaction-text">{text || (compacting ? '' : '(nothing beyond the recent turns needed carrying forward)')}</pre>
</details>

<style>
  .compaction-block { margin: 6px 0 14px; font-size: 11px; }
  .compaction-summary {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    list-style: none;
    user-select: none;
    color: var(--og-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .compaction-summary::-webkit-details-marker { display: none; }
  .compaction-rule {
    flex: 1;
    height: 1px;
    background: var(--og-border);
    animation: compaction-draw 350ms cubic-bezier(0.23, 1, 0.32, 1) both;
  }
  .compaction-rule.l { transform-origin: right; }
  .compaction-rule.r { transform-origin: left; }
  @keyframes compaction-draw { from { transform: scaleX(0); } }
  .compaction-title {
    white-space: nowrap;
    color: var(--og-text-secondary);
    animation: compaction-fade 240ms ease 120ms both;
  }
  @keyframes compaction-fade { from { opacity: 0; } }
  .compaction-block[open] .compaction-title { color: var(--og-text); }
  /* While it runs: the travelling line on the bottom edge (rule 2). */
  .compaction-travel {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -3px;
    height: 1px;
    overflow: hidden;
  }
  .compaction-travel::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 34%;
    background: var(--og-chat);
    animation: compaction-travel 1.8s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  @keyframes compaction-travel { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  .compaction-text {
    margin: 6px 0 0;
    padding: 2px 12px 8px 20px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
    line-height: 1.5;
  }
  @media (prefers-reduced-motion: reduce) {
    .compaction-rule, .compaction-title, .compaction-travel::after { animation: none; }
  }
</style>
