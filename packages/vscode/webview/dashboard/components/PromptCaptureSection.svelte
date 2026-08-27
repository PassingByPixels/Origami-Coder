<script lang="ts">
  // What the model ACTUALLY received on the last turn, under the instruction
  // inventory. The inventory answers "which files feed the prompt"; this
  // answers the question that follows — "so what did you actually send?".
  //
  // It is a CAPTURE, not a re-derivation: the engine records it at send time,
  // after the plugin hook that can reshape the prompt. So the final-assembled
  // block below can legitimately differ from the labelled parts above it, and
  // both are shown rather than one being presented as the other.
  //
  // Same honesty rules as the pane above: every token figure is prefixed with
  // ~ and the engine's own estimator name is rendered, never a hardcoded one.
  //
  // The REQUEST is posted by InstructionsPane (on mount and on its refresh
  // button) so the inventory above and the capture here always describe the
  // same moment; this component owns only the REPLY. It deliberately does not
  // blank itself while a refresh is in flight — the previous turn is still
  // true until a newer one arrives.
  //
  // TWO MODES, one renderer. Left alone it owns the global `promptCaptureData`
  // broadcast, which is what InstructionsPane needs (one board, one active
  // chat). Given a `source` prop it renders THAT capture and ignores the wire
  // entirely — the collab pane holds several agents' captures at once and must
  // filter on collabId before any of them reaches a view, so it cannot let a
  // broadcast paint one agent's prompt under another agent's name.
  import type { PromptCapture, PromptCapturePart, PromptCaptureTool } from '../../../src/acpExtTypes';

  interface CaptureSource { capture: PromptCapture | null; error: string | null; loaded: boolean }
  let { source = null }: { source?: CaptureSource | null } = $props();

  let ownCapture: PromptCapture | null = $state(null);
  let ownError: string | null = $state(null);
  let ownLoaded = $state(false);

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    // Prop-driven: the owner decides what this shows, so the global broadcast
    // is not merely unused here — it must not be able to overwrite it.
    if (source || msg.type !== 'promptCaptureData') return;
    ownCapture = msg.capture ?? null;
    ownError = typeof msg.error === 'string' ? msg.error : null;
    ownLoaded = true;
  });

  let capture = $derived(source ? source.capture : ownCapture);
  let error = $derived(source ? source.error : ownError);
  let loaded = $derived(source ? source.loaded : ownLoaded);

  let open = $state(true);
  let openParts: Record<number, boolean> = $state({});
  let openBlocks: Record<number, boolean> = $state({});
  let openTools: Record<string, boolean> = $state({});

  let parts = $derived(capture?.labeledParts ?? []);
  let partsChars = $derived(parts.reduce((n, p) => n + p.chars, 0));
  let partsTokens = $derived(parts.reduce((n, p) => n + p.tokensApprox, 0));
  let finalChars = $derived((capture?.finalSystem ?? []).reduce((n, b) => n + b.chars, 0));
  let tools = $derived(capture?.tools ?? []);
  let toolChars = $derived(tools.reduce((n, t) => n + t.descriptionChars, 0));
  let method = $derived(capture?.tokensApproxMethod ?? 'chars/4');

  const share = (p: PromptCapturePart): number => (partsChars > 0 ? (p.chars / partsChars) * 100 : 0);
  const toolTitle = (t: PromptCaptureTool): string =>
    `${t.name} — ${t.descriptionChars.toLocaleString()} chars of description`;
</script>

<div class="pc-block">
  <button class="pc-head" onclick={() => (open = !open)} title="What the engine sent the model on the last turn">
    <span class="pc-caret" class:is-open={open}>▸</span>
    <span class="pc-head-title">What the model actually received (last turn)</span>
    {#if capture}
      <span class="pc-head-sum">
        {parts.length} part{parts.length === 1 ? '' : 's'} ·
        {partsChars.toLocaleString()} chars ·
        ~{partsTokens.toLocaleString()} tokens ·
        {tools.length} tool{tools.length === 1 ? '' : 's'}
      </span>
    {/if}
  </button>

  {#if open}
    {#if error}
      <div class="pc-error">{error}</div>
    {:else if !loaded}
      <div class="pc-empty">Reading the last prepared request…</div>
    {:else if !capture}
      <div class="pc-empty">
        Send a message in this session first — nothing has been sent to the model yet, so there is no prompt to show.
      </div>
    {:else}
      <div class="pc-meta">
        Captured {capture.capturedAt} · sent to <code>{capture.model}</code>. Recorded as the request left the engine,
        so a plugin that rewrites the prompt is included. Token figures are an <strong>estimate</strong> — the engine
        reports its method as <code>{method}</code>.
      </div>

      <!-- A `tail` part is NOT in the block list below it, by design: the memory
           blocks ride the end of the message list so a `remember` write cannot
           invalidate the cached prefix. Saying so here is what stops that
           reading as a block the engine dropped. -->
      <div class="pc-sub">Assembled parts — <code>tail</code> rides after the messages, not the system prompt</div>
      <div class="pc-list">
        {#each parts as p, i (i)}
          <div class="pc-row">
            <button class="pc-row-head" onclick={() => (openParts = { ...openParts, [i]: !openParts[i] })}
              title="Show the full text of this block">
              <span class="pc-bar" style="width: {share(p).toFixed(1)}%"></span>
              <span class="pc-badge badge-{p.label}">{p.label}</span>
              <span class="pc-size">
                {p.chars.toLocaleString()} chars · ~{p.tokensApprox.toLocaleString()} tok · {share(p).toFixed(1)}%{p.delivery
                  === 'tail'
                  ? ' · tail'
                  : ''}
              </span>
            </button>
            {#if openParts[i]}<pre class="pc-text">{p.text}</pre>{/if}
          </div>
        {/each}
      </div>

      <div class="pc-sub">
        Final assembled system — {capture.finalSystem.length} block{capture.finalSystem.length === 1 ? '' : 's'},
        {finalChars.toLocaleString()} chars
      </div>
      <div class="pc-list">
        {#each capture.finalSystem as b, i (i)}
          <div class="pc-row">
            <button class="pc-row-head" onclick={() => (openBlocks = { ...openBlocks, [i]: !openBlocks[i] })}
              title="Show the full text of this block">
              <span class="pc-badge badge-final">block {i + 1}</span>
              <span class="pc-size">{b.chars.toLocaleString()} chars · ~{b.tokensApprox.toLocaleString()} tok</span>
            </button>
            {#if openBlocks[i]}<pre class="pc-text">{b.text}</pre>{/if}
          </div>
        {/each}
      </div>

      <div class="pc-sub">
        Tools offered — {tools.length}, {toolChars.toLocaleString()} chars of description
      </div>
      {#if tools.length === 0}
        <div class="pc-empty">No tools were offered on this turn.</div>
      {:else}
        <div class="pc-list">
          {#each tools as t (t.name)}
            <div class="pc-row">
              <button class="pc-row-head" onclick={() => (openTools = { ...openTools, [t.name]: !openTools[t.name] })}
                title={toolTitle(t)}>
                <span class="pc-name">{t.name}</span>
                <span class="pc-size">
                  {t.descriptionChars.toLocaleString()} chars ·
                  {#if t.schemaBytes === 0}schema not measured{:else}{t.schemaBytes.toLocaleString()} B schema{/if}
                </span>
              </button>
              {#if openTools[t.name]}<pre class="pc-text">{t.description}</pre>{/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .pc-block { margin: 10px 12px 12px; border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-surface); }
  .pc-head { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none; color: var(--og-text); font-family: inherit; cursor: pointer; padding: 8px 10px; }
  .pc-caret { font-size: 10px; color: var(--og-text-muted); transition: transform 0.12s; }
  .pc-caret.is-open { transform: rotate(90deg); }
  .pc-head-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-secondary); }
  .pc-head-sum { margin-left: auto; font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .pc-meta { margin: 0 10px 8px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .pc-meta code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .pc-sub { padding: 6px 10px 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--og-text-muted); border-top: 1px solid var(--og-border); }
  .pc-list { display: flex; flex-direction: column; gap: 4px; padding: 0 10px 8px; }
  .pc-row { border: 1px solid var(--og-border); border-radius: 4px; overflow: hidden; }
  .pc-row-head { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: var(--og-btn-bg); border: none; color: var(--og-text); font-family: inherit; cursor: pointer; padding: 5px 8px; }
  .pc-row-head:hover { background: var(--og-btn-hover); }
  .pc-bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--og-accent); opacity: 0.16; pointer-events: none; }
  .pc-badge { position: relative; font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 8px; background: var(--og-surface); color: var(--og-text-muted); }
  .badge-base-or-agent-prompt { color: var(--og-warning); }
  .badge-instructions { color: var(--og-success); }
  .badge-user-system { color: var(--og-chat); }
  .badge-final { color: var(--og-crane); }
  .pc-name { position: relative; font-size: 11px; font-weight: 600; }
  .pc-size { position: relative; margin-left: auto; font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pc-text { max-height: 260px; overflow: auto; margin: 0; padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; line-height: 1.5; color: var(--og-text); white-space: pre-wrap; word-break: break-word; border-top: 1px solid var(--og-border); }
  .pc-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 14px 12px; line-height: 1.6; }
  .pc-error { color: var(--og-error); font-size: 12px; padding: 12px; line-height: 1.5; }
</style>
