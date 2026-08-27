<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — specialised renderer for
  // `task` (single sub-agent spawn).
  //
  // The tool's own output text IS what this card renders, and that text is
  // written FOR THE MODEL: a background launch returns the BACKGROUND_STARTED
  // briefing ("DO NOT sleep, poll for progress…"), everything else returns a
  // `<task id=… state=…><task_result>…</task_result></task>` envelope. Correct,
  // load-bearing guidance for the model — pure noise for a human, who was left
  // reading the agent's own instructions and nothing about the actual work.
  // So: PRESENTATION-ONLY translation here (the engine's text is untouched) into
  // a plain "<description> — running / completed" line, plus the sub-agent's live
  // stream and, when it lands, its real answer.

  import MessageRow from '../MessageRow.svelte';

  interface Props {
    result: string;
    /** Live output forwarded from the sub-agent's own session while it works —
     *  its prose plus one line per tool it starts. */
    stream?: string;
    /** The task's description, from the tool call title. */
    title?: string;
    /** ACP tool status — the card's own lifecycle, distinct from the engine
     *  `state=` inside the envelope (a BACKGROUND launch COMPLETES the tool call
     *  immediately while the sub-agent is still working). */
    status?: string;
  }

  let { result, stream = '', title = '', status = '' }: Props = $props();

  // Model-facing envelope → { state, body }. Anything that isn't one of the
  // engine's two shapes is passed straight through as the body (plain ACP
  // servers, older sessions).
  function parse(text: string): { state: string; body: string } {
    const envelope = /^<task id="[^"]*" state="([^"]*)">\n([\s\S]*)\n<\/task>$/.exec(text.trim());
    if (!envelope) return { state: '', body: text };
    const state = envelope[1] ?? '';
    let inner = envelope[2] ?? '';
    // Drop the <summary> line — it restates the description we already show.
    inner = inner.replace(/^<summary>[\s\S]*?<\/summary>\n?/, '');
    const tagged = /^<(task_result|task_error)>\n([\s\S]*)\n<\/\1>$/.exec(inner.trim());
    return { state, body: (tagged ? (tagged[2] ?? '') : inner).trim() };
  }

  // The runtime sometimes prefixes the result with a header like
  // "[task: zyn — research detour] <body>". Split if present.
  function splitHeader(text: string): { header: string | null; body: string } {
    const lines = text.split('\n');
    const first = lines[0] ?? '';
    if (/^\[task:/.test(first)) {
      return { header: first.replace(/^\[|\]$/g, ''), body: lines.slice(1).join('\n').trimStart() };
    }
    return { header: null, body: text };
  }

  let parsed = $derived(parse(result ?? ''));
  // `state="running"` is the engine saying the sub-agent is still going — that is
  // exactly the BACKGROUND_STARTED / BACKGROUND_UPDATED case, whose body is the
  // model's briefing. Never render it; the human summary replaces it wholesale.
  let running = $derived(parsed.state === 'running' || status === 'in_progress' || status === 'pending');
  let errored = $derived(parsed.state === 'error' || status === 'failed');
  let s = $derived(running ? { header: null, body: '' } : splitHeader(parsed.body));
  let label = $derived(title || 'sub-agent');
  let stateWord = $derived(running ? 'running' : errored ? 'failed' : 'completed');
</script>

<div class="task-card">
  <div class="task-summary" class:running class:errored>
    <span class="task-name">{label}</span>
    <span class="task-state">— {stateWord}</span>
  </div>

  {#if stream}
    <!-- The sub-agent's live work. COLLAPSED by default (no `open` binding — the
         thought-block / compaction-block precedent): a fan-out of ten agents each
         auto-expanding a live stream blows the transcript apart. `live` just tints
         it while the work is in flight. -->
    <details class="task-stream" class:live={running}>
      <summary class="task-stream-summary">Live output</summary>
      <pre class="task-stream-text">{stream}</pre>
    </details>
  {:else if running}
    <div class="task-waiting">waiting for the sub-agent's first output…</div>
  {/if}

  {#if s.header}
    <div class="task-header">{s.header}</div>
  {/if}
  {#if s.body}
    <div class="task-body">
      <MessageRow kind="agent" label="" text={s.body} />
    </div>
  {:else if !running}
    <!-- Honest: finished, returned nothing. Must not read as a silent success. -->
    <div class="task-waiting">the sub-agent returned no text</div>
  {/if}
</div>

<style>
  .task-card {
    font-family: inherit;
    font-size: 11px;
  }

  /* Replaces the model-facing instruction block a human used to be shown. */
  .task-summary {
    display: flex;
    align-items: baseline;
    gap: 5px;
    margin-bottom: 4px;
  }
  .task-name {
    color: var(--og-text);
    font-weight: 600;
  }
  .task-state {
    color: var(--og-text-muted);
  }
  .task-summary.running .task-state {
    color: var(--og-warning);
  }
  .task-summary.errored .task-state {
    color: var(--og-error);
  }

  .task-stream {
    margin-bottom: 4px;
    border: 1px solid var(--og-border);
    border-radius: 3px;
    background: var(--og-bg);
  }
  .task-stream.live {
    border-color: color-mix(in srgb, var(--og-chat) 45%, var(--og-border));
  }
  .task-stream-summary {
    padding: 3px 6px;
    color: var(--og-text-muted);
    font-size: 10px;
    cursor: pointer;
    user-select: none;
  }
  .task-stream-summary:hover {
    color: var(--og-text);
  }
  .task-stream-text {
    margin: 0;
    padding: 4px 6px;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--og-text-secondary);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
  }

  .task-waiting {
    color: var(--og-text-muted);
    font-style: italic;
  }

  .task-header {
    color: var(--og-accent, #89b4fa);
    font-weight: 600;
    margin-bottom: 4px;
    font-style: italic;
  }

  .task-body {
    padding-left: 8px;
    border-left: 2px solid var(--og-accent-soft, rgba(137, 180, 250, 0.3));
  }
</style>
