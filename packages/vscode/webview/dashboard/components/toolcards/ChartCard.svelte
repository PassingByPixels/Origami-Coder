<script lang="ts">
  // ChartCard — the `chart` tool's card. The tool's OUTPUT is the spec, and
  // this draws it through the SAME renderer a ```chart fence uses
  // (shared/chartBlock.ts), so a tool-drawn chart and a fenced one are one
  // picture with one palette, never two implementations that drift.
  //
  // The verdict is the RENDERER's, not the title's and not the ACP status.
  // The engine COMPLETES a chart call it refused — the correction has to reach
  // the model — so status alone would paint a refusal green, the same sin
  // BashCard's exit code and BrowserCard's `ok` flag exist to stop. Asking the
  // renderer is stricter than either: a call the engine answered ok whose spec
  // still does not draw is exactly the silent failure this tool was built to
  // end, and here it reads red instead of showing an empty card.
  //
  // Output rides {@html} exactly as the two markdown seams do: chartBlock.ts
  // entity-escapes every model-controlled label itself (see its security note),
  // so a second escaping layer here would print SVG source at the user.

  import { renderChartBlock } from '../../../shared/chartBlock';

  interface Props {
    /** The tool output: the chart spec as JSON, or the engine's refusal text. */
    result: string;
    status?: string;
  }

  let { result, status = '' }: Props = $props();

  let running = $derived(status !== 'completed' && status !== 'failed');
  let svg = $derived(result ? renderChartBlock(result) : null);
</script>

<div class="ch-card">
  {#if svg}
    <div class="ch-plot">{@html svg}</div>
  {:else if running}
    <div class="ch-empty">drawing…</div>
  {:else}
    <!-- No picture: show WHY, in the engine's own words. Its refusal names the
         missing field and one valid call, so the text is the fix, not an
         apology — blanking it would leave the user with an empty card. -->
    <div class="ch-chips"><span class="ch-chip ch-fail">no chart</span></div>
    <pre class="ch-block ch-error">{result || '(no output)'}</pre>
  {/if}
</div>

<style>
  .ch-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  /* The chart at its own scale, never wider than the card — the renderer's
     svg carries width="100%" and its own viewBox. */
  .ch-plot :global(svg) {
    display: block;
    max-width: 100%;
  }

  .ch-block {
    margin: 0;
    padding: 5px 7px;
    background: var(--og-bg);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }
  .ch-error {
    color: var(--og-error);
    border-color: var(--og-error);
  }

  .ch-chips {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .ch-chip {
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 600;
    background: var(--og-btn-bg);
    color: var(--og-text-muted);
  }
  .ch-fail {
    color: var(--og-error);
    background: color-mix(in srgb, var(--og-error) 12%, transparent);
  }

  .ch-empty {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px 0;
  }
</style>
