<script lang="ts">
  // BrowserCard — the `browser` tool's card, built on BashCard's IN/OUT rails
  // so a driven page reads like a driven shell: IN is what was asked of the
  // browser (action + target), OUT is what came back.
  //
  // The honest states matter more here than anywhere else on the board,
  // because the extension half can only reach the integrated browser on a
  // build that publishes it (src/browserBridge.ts):
  //   - a screenshot renders INLINE. A card that only said "Screenshot of X"
  //     would be a claim with nothing behind it.
  //   - a failure is RED and shows the engine's reason verbatim, the same
  //     precedent as BashCard's non-zero exit — a refusal must never be
  //     mistaken for a page that loaded.
  //   - a refusal the engine composed itself ("Refused: ... needs a url")
  //     is a failure too, even though the tool call completed.
  //
  // The verdict comes from the engine's `metadata.ok` (chatToolMeta.ts), NEVER
  // from the result prose. Matching prose only ever recognises the failure
  // strings someone remembered to list: "…returned no image data, only text: …"
  // and "Unknown browser action: …" both start with neither of the old two
  // patterns, so both painted a green "ok" on a call that failed.

  import type { ToolBrowser } from '../../panes/chatToolMsg';

  interface Props {
    result: string;
    title?: string;
    status?: string;
    /** Data URIs off the tool result's ACP image blocks (acpToolContent.ts). */
    images?: string[];
    /** The engine's own verdict + target. Absent until the result lands. */
    browser?: ToolBrowser;
  }

  let { result, title = '', status = '', images, browser }: Props = $props();

  // The action is metadata when there is metadata; before the result lands the
  // engine's `browser <action>[: <where>]` title is all there is.
  let action = $derived(browser?.action ?? /^browser\s+(\w+)/.exec(title)?.[1] ?? 'browser');
  // The TARGET chip is metadata-only once a verdict exists. Splitting the title
  // at its colon renders a failure title's tail — a chip reading "failed" or
  // "refused", as if the browser had visited a page by that name. With no
  // verdict yet the title still holds the real target and nothing else can.
  let where = $derived(browser ? (browser.url ?? '') : titleTarget(title));
  let running = $derived(status !== 'completed' && status !== 'failed');
  // `failed` is the ACP status; the engine ALSO returns a COMPLETED call whose
  // metadata says it did not work, and that must read red as well.
  let failed = $derived(status === 'failed' || browser?.ok === false);
  let shots = $derived(images ?? []);

  function titleTarget(raw: string): string {
    return raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : '';
  }
</script>

<div class="br-card">
  <div class="br-row">
    <span class="br-rail br-rail-in">IN</span>
    <div class="br-cell">
      <div class="br-chips">
        <span class="br-chip br-action">{action}</span>
        {#if where}<span class="br-chip" title={where}>{where}</span>{/if}
      </div>
    </div>
  </div>

  <div class="br-row">
    <span class="br-rail br-rail-out">OUT</span>
    <div class="br-cell">
      <div class="br-chips">
        {#if running}
          <span class="br-chip br-run">running…</span>
        {:else if failed}
          <span class="br-chip br-fail">failed</span>
        {:else}
          <span class="br-chip br-ok">ok</span>
        {/if}
        {#if shots.length}<span class="br-chip br-shots">{shots.length === 1 ? 'screenshot' : `${shots.length} screenshots`}</span>{/if}
      </div>
      {#if result}
        <pre class="br-block" class:br-error={failed}>{result}</pre>
      {:else}
        <div class="br-empty">{running ? 'no result yet' : '(no output)'}</div>
      {/if}
      {#each shots as src, i (src)}
        <!-- CSP allows `img-src data:` (DashboardPanel's webview header), so the
             base64 bytes render without a temp file or a host round-trip. -->
        <img class="br-shot" {src} alt={`Browser screenshot ${i + 1}${where ? ` of ${where}` : ''}`} />
      {/each}
    </div>
  </div>
</div>

<style>
  .br-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }

  .br-row {
    display: flex;
    align-items: flex-start;
    gap: 7px;
  }
  .br-rail {
    flex: 0 0 26px;
    text-align: center;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 0;
    border-radius: 5px;
    margin-top: 1px;
  }
  .br-rail-in {
    color: var(--og-chat, #89b4fa);
    background: color-mix(in srgb, var(--og-chat, #89b4fa) 14%, transparent);
  }
  .br-rail-out {
    color: var(--og-text-muted);
    background: var(--og-btn-bg);
  }
  .br-cell {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .br-block {
    margin: 0;
    padding: 5px 7px;
    background: var(--og-bg, #181825);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;
  }
  .br-error {
    color: var(--og-error, #f38ba8);
    border-color: var(--og-error, #f38ba8);
  }

  .br-chips {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .br-chip {
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 600;
    background: var(--og-btn-bg);
    color: var(--og-text-muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .br-action {
    color: var(--og-text);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .br-ok {
    color: var(--og-success, #a6e3a1);
    background: rgba(166, 227, 161, 0.12);
  }
  .br-fail {
    color: var(--og-error, #f38ba8);
    background: rgba(243, 139, 168, 0.12);
  }
  .br-run {
    color: var(--og-warning, #f9e2af);
    background: rgba(249, 226, 175, 0.12);
  }
  .br-shots {
    color: var(--og-text-secondary);
  }

  .br-empty {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px 0;
  }

  /* The capture at its own scale, never wider than the card. */
  .br-shot {
    display: block;
    max-width: 100%;
    height: auto;
    margin-top: 3px;
    border: 1px solid var(--og-border);
    border-radius: 5px;
  }
</style>
