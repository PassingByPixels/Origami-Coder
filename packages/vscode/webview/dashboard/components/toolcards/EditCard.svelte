<script lang="ts">
  // Edit-tool renderer. Preferred path: the structured ACP
  // `{type:'diff'}` block (the engine's `acp/tool.ts:diffContent`) carrying
  // the replaced region's `oldText` / `newText`, rendered SIDE-BY-SIDE —
  // before (red) on the left, after (green) on the right, aligned row by
  // row. Each side scrolls horizontally so long lines stay on one line in
  // the narrow chat pane; on a very narrow pane the two columns stack.
  //
  // Fallback: when no structured diff is present (a fresh write with no
  // `oldString`, or an older session), render the tool's text output as
  // plain lines.

  interface Props {
    result: string;
    diff?: { path: string; oldText: string; newText: string };
  }

  let { result, diff }: Props = $props();

  // t-yyz5yk (Round 8, "Inside each element"): the two sides are ALIGNED by
  // a line diff (lineDiff.ts), so an insertion no longer shows every later
  // line as changed. Split (before | after, line numbers per side, hatched
  // filler) is the default; the switch goes to Unified. Line numbers count
  // within the edited region: the diff block carries no offset into the file.
  import { lineDiff, splitRows } from './lineDiff';

  let hasDiff = $derived(!!diff && (diff.oldText.length > 0 || diff.newText.length > 0));
  let ops = $derived(diff ? lineDiff(diff.oldText, diff.newText) : []);
  let rows = $derived(splitRows(ops));
  let mode = $state<'split' | 'unified'>('split');
</script>

{#if hasDiff && diff}
  <div class="diff-split">
    <div class="dbar">
      {#if diff.path}<span class="diff-path">{diff.path}</span>{/if}
      <span class="sp"></span>
      <span class="seg" role="group" aria-label="Diff layout">
        <button type="button" aria-pressed={mode === 'split'} onclick={() => (mode = 'split')}>Split</button>
        <button type="button" aria-pressed={mode === 'unified'} onclick={() => (mode = 'unified')}>Unified</button>
      </span>
    </div>
    {#if mode === 'split'}
      <div class="split">
        <div class="side">Before</div>
        <div class="side">After</div>
        {#each rows as row, i (i)}
          <div class="sl-row" style="--i: {Math.min(i, 30)}">
            {#if row.left}<div class="sl" class:del={row.left.del}><b class="sl-n">{row.left.n}</b><span>{row.left.text}</span></div>
            {:else}<div class="sl empty"></div>{/if}
            {#if row.right}<div class="sl" class:add={row.right.add}><b class="sl-n">{row.right.n}</b><span>{row.right.text}</span></div>
            {:else}<div class="sl empty"></div>{/if}
          </div>
        {/each}
      </div>
    {:else}
      <div class="unified">
        {#each ops as o, i (i)}
          <div class="ul" class:del={o.t === 'del'} class:add={o.t === 'add'} style="--i: {Math.min(i, 30)}">
            <b>{o.t === 'add' ? '' : o.ai + 1}</b><b>{o.t === 'del' ? '' : o.bi + 1}</b><span>{o.t === 'add' ? o.b : o.a}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <pre class="edit-fallback">{result}</pre>
{/if}

<style>
  .diff-split {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 18px;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    background: var(--og-bg);
    overflow: hidden;
  }
  .dbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    border-bottom: 1px solid var(--og-border);
    background: color-mix(in srgb, var(--og-surface) 60%, transparent);
    font-family: inherit;
  }
  .diff-path { color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--og-border); border-radius: 6px; overflow: hidden; flex: none; }
  .seg button { font: inherit; font-size: 10.5px; padding: 0 8px; border: 0; background: transparent; color: var(--og-text-muted); cursor: pointer; }
  .seg button[aria-pressed='true'] { background: var(--og-surface); color: var(--og-text); }
  .split { display: grid; grid-template-columns: 1fr 1fr; }
  .side { padding: 0 8px; font-size: 10.5px; color: var(--og-text-muted); border-bottom: 1px solid var(--og-border); font-family: var(--vscode-font-family, sans-serif); }
  .side + .side, .sl + .sl { border-left: 1px solid var(--og-border); }
  .sl-row { display: contents; }
  .sl, .ul { display: grid; white-space: pre; min-height: 18px; overflow: hidden; }
  .sl { grid-template-columns: 34px 1fr; }
  .ul { grid-template-columns: 34px 34px 1fr; }
  .sl b, .ul b { font-weight: 400; text-align: right; padding-right: 8px; color: var(--og-text-muted); opacity: 0.7; user-select: none; }
  .sl span, .ul span { overflow: hidden; text-overflow: ellipsis; color: var(--og-text-secondary); }
  .sl.del, .ul.del { background: color-mix(in srgb, var(--og-error) 11%, transparent); }
  .sl.add, .ul.add { background: color-mix(in srgb, var(--og-success) 11%, transparent); }
  .sl.del span, .sl.add span, .ul.del span, .ul.add span { color: var(--og-text); }
  .sl.del b, .ul.del b { color: var(--og-error); }
  .sl.add b, .ul.add b { color: var(--og-success); }
  .sl.empty { background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--og-border) 35%, transparent) 5px 6px); }
  /* Lines arrive once, 16 ms apart, when the view opens. */
  .sl, .ul { animation: lnin 240ms cubic-bezier(0.23, 1, 0.32, 1) backwards; animation-delay: calc(var(--i, 0) * 16ms); }
  @keyframes lnin { from { opacity: 0; transform: translateY(3px); } }
  @media (prefers-reduced-motion: reduce) { .sl, .ul { animation: none; } }
  /* On a very narrow pane, split cannot fit two readable columns. */
  @media (max-width: 360px) { .split { grid-template-columns: 1fr; } .side + .side, .sl + .sl { border-left: 0; } }

  .edit-fallback {
    margin: 0;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.4;
  }
</style>
