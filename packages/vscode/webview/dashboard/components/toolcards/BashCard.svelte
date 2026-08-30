<script lang="ts">
  // BashCard — rewritten 2026-08-06 against the TS engine's REAL bash contract
  // (the old card parsed Rust-runtime shapes — `[stderr]`, `[exit code N]` —
  // that this engine never emits, so it was never dispatched). The engine
  // sends: title = the command; output text that may open with the truncation
  // banner ("...output truncated...\n\nFull output saved to: <path>") and may
  // close with a <shell_metadata> note (timeout/abort advice); and, via the
  // `shell` prop (rawInput + rawOutput.metadata shaped by chatToolMsg.ts),
  // cwd/timeout in and exit/truncated/outputPath out.
  //
  // Layout: labelled IN / OUT rails, the same read at a glance as a terminal
  // transcript — IN is the command verbatim, OUT is what came back, with the
  // exit code chip carrying the honest verdict (0 green, non-zero red,
  // null = killed).
  import { getVsCodeApi } from '../../../shared/vscodeApi';
  import type { ToolShell } from '../../panes/chatToolMsg';

  // The age chip and the Kill button used to live here. They now live in
  // ToolCard's header strip, because this component is only mounted once the
  // card is EXPANDED — so on a collapsed card, which is how every card starts,
  // the Kill button the user needed did not exist at all. See toolcards/stuckCall.ts.
  interface Props {
    result: string;
    title?: string;
    status?: string;
    shell?: ToolShell;
  }

  let { result, title = '', status = '', shell }: Props = $props();

  const vscode = getVsCodeApi();
  function openFull(p: string) {
    if (p) vscode.postMessage({ type: 'openAbsoluteFile', path: p });
  }

  // The engine prepends this banner when it tail-truncated the output and
  // saved the full text to a temp file. Strip it from the body and surface the
  // path as a click-to-open action instead of two lines of prose.
  const TRUNC_RE = /^\.\.\.output truncated\.\.\.\n\nFull output saved to: (.+?)\n\n/;
  // Engine-appended advice (timeout ladder guidance, "User aborted") — real
  // information, but not command output: render it as a dim note, not OUT.
  const META_RE = /\n*<shell_metadata>\n([\s\S]*?)\n<\/shell_metadata>\s*$/;

  interface OutParts {
    body: string;
    truncPath?: string;
    note?: string;
  }

  function parseOut(text: string): OutParts {
    let body = text;
    let truncPath: string | undefined;
    let note: string | undefined;
    const t = TRUNC_RE.exec(body);
    if (t) {
      truncPath = t[1];
      body = body.slice(t[0].length);
    }
    const m = META_RE.exec(body);
    if (m) {
      note = m[1];
      body = body.slice(0, m.index);
    }
    body = body.replace(/\n+$/, '');
    if (body === '(no output)') body = '';
    return { body, truncPath, note };
  }

  let command = $derived(shell?.command || title);
  let out = $derived(parseOut(result));
  let running = $derived(status !== 'completed' && status !== 'failed');
  // Prefer the structured path off rawOutput.metadata; the banner path is the
  // fallback for replayed/older transcripts that only kept the text.
  let fullPath = $derived(shell?.outputPath ?? out.truncPath);
  let truncated = $derived(shell?.truncated === true || !!out.truncPath);
</script>

<div class="bash-card">
  <!-- IN and OUT stack on a narrow card and sit side by side on a wide one.
       The decision is a CONTAINER query on .bash-card, so the same card is
       right in the 380px sidebar and in a full-width editor tab. -->
  <div class="bash-cols">
    <div class="bash-row">
      <span class="bash-rail bash-rail-in">IN</span>
      <div class="bash-cell">
        {#if shell?.cwd || shell?.timeout}
          <div class="bash-chips">
            {#if shell?.cwd}<span class="bash-chip" title={shell.cwd}>{shell.cwd}</span>{/if}
            {#if shell?.timeout}<span class="bash-chip">timeout {Math.round(shell.timeout / 1000)}s</span>{/if}
          </div>
        {/if}
        <pre class="bash-block bash-in">{command}</pre>
      </div>
    </div>

    <div class="bash-row">
      <span class="bash-rail bash-rail-out">OUT</span>
      <div class="bash-cell">
        <div class="bash-chips">
          {#if running}
            <span class="bash-chip bash-run">running…</span>
          {:else if typeof shell?.exit === 'number'}
            <span class="bash-chip" class:bash-ok={shell.exit === 0} class:bash-fail={shell.exit !== 0}>exit {shell.exit}</span>
          {:else if shell?.exit === null}
            <span class="bash-chip bash-fail">killed</span>
          {/if}
          {#if truncated}
            {#if fullPath}
              <button class="bash-chip bash-trunc" title={`Open the full output: ${fullPath}`} onclick={() => openFull(fullPath!)}>truncated — open full output</button>
            {:else}
              <span class="bash-chip bash-trunc">truncated</span>
            {/if}
          {/if}
        </div>
        {#if out.body}
          <pre class="bash-block bash-out">{out.body}</pre>
        {:else}
          <div class="bash-empty">{running ? 'no output yet' : '(no output)'}</div>
        {/if}
        {#if out.note}
          <div class="bash-note">{out.note}</div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .bash-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    /* The card is its own query container. The layout question is how wide THIS
       CARD is, which a viewport @media query cannot answer: the same card
       renders in the 380px sidebar and in a full-width editor tab. */
    container: bash-card / inline-size;
  }

  /* Stacked on a narrow card, exactly as before. */
  .bash-cols {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }
  /* Wide enough for two readable columns: the command on the left, what came
     back on the right, with OUT taking the larger share because it is the half
     that runs long. Both tracks are min-width:0 (below) so a long path or an
     unbroken line of output still wraps instead of stretching the track. */
  @container bash-card (min-width: 480px) {
    .bash-cols {
      grid-template-columns: 2fr 3fr;
      align-items: start;
    }
  }

  /* Rail + cell: the IN/OUT label sits in a fixed gutter so the two blocks
     align into one visual transcript, whatever their heights. */
  .bash-row {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    min-width: 0;
  }
  .bash-rail {
    flex: 0 0 26px;
    text-align: center;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 0;
    border-radius: 5px;
    margin-top: 1px;
  }
  .bash-rail-in {
    color: var(--og-chat, #89b4fa);
    background: color-mix(in srgb, var(--og-chat, #89b4fa) 14%, transparent);
  }
  .bash-rail-out {
    color: var(--og-text-muted);
    background: var(--og-btn-bg);
  }
  .bash-cell {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .bash-block {
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
  .bash-in {
    color: var(--og-text);
  }

  .bash-chips {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .bash-chip {
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 600;
    font-family: inherit;
    border: 1px solid transparent;
    background: var(--og-btn-bg);
    color: var(--og-text-muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bash-ok {
    color: var(--og-success, #a6e3a1);
    background: rgba(166, 227, 161, 0.12);
  }
  .bash-fail {
    color: var(--og-error, #f38ba8);
    background: rgba(243, 139, 168, 0.12);
  }
  .bash-run {
    color: var(--og-warning, #f9e2af);
    background: rgba(249, 226, 175, 0.12);
  }
  .bash-trunc {
    color: var(--og-warning-text, var(--og-warning, #f9e2af));
    border-color: var(--og-warning, #f9e2af);
    cursor: pointer;
  }
  button.bash-trunc:hover {
    color: var(--og-text);
  }

  .bash-empty {
    color: var(--og-text-muted);
    font-style: italic;
    padding: 2px 0;
  }

  /* The engine's <shell_metadata> advice — kept, but visually a footnote. */
  .bash-note {
    color: var(--og-text-muted);
    font-style: italic;
    font-size: 10px;
    line-height: 1.4;
    padding: 2px 0 0 0;
    white-space: pre-wrap;
  }
</style>
