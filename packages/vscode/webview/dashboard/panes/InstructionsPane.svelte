<script lang="ts">
  // Instructions — every file and URL that feeds the system prompt, with its
  // size. The public critique this answers is "there are ~10k tokens of
  // instructions I never see": so the list is sorted BIGGEST FIRST, each row
  // carries its share of the total, and clicking a row opens the actual file.
  //
  // The honesty rule this file still owns: the token numbers are `chars/4`,
  // not a tokenisation. The engine names its own estimator in
  // `tokensApproxMethod`; that name is rendered, and every token figure is
  // prefixed with ~ so it never reads as a measurement. The per-row rules (an
  // unmeasured URL, a built-in that is not yet a file) went to InstructionRow.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import PromptCaptureSection from '../components/PromptCaptureSection.svelte';
  import CacheStatsCard from '../components/CacheStatsCard.svelte';
  import InstructionRow from '../components/InstructionRow.svelte';
  import { openMessage, sections, type OverrideSource } from '../components/instructionRows';
  const vscode = getVsCodeApi();

  // Mirrors InstructionEntry / InstructionSet in src/acpExtTypes.ts.
  interface Entry {
    path: string;
    source: 'global' | 'project' | 'config' | 'memory' | 'url' | OverrideSource;
    chars: number;
    bytes: number;
    tokensApprox: number;
    overridden?: boolean; // pinned rows only: is the user's own file supplying the text?
  }

  let entries: Entry[] = $state([]);
  let totalChars = $state(0);
  let totalTokensApprox = $state(0);
  let method = $state('chars/4');
  let error: string | null = $state(null);
  let loaded = $state(false);

  function refresh(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'listInstructions' });
    // The capture is a SECOND wire — the inventory is read off disk, this can
    // only be captured at send time. PromptCaptureSection receives the reply.
    vscode.postMessage({ type: 'promptCapture' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'instructionsData') return;
    entries = Array.isArray(msg.entries) ? msg.entries : [];
    totalChars = typeof msg.totalChars === 'number' ? msg.totalChars : 0;
    totalTokensApprox = typeof msg.totalTokensApprox === 'number' ? msg.totalTokensApprox : 0;
    method = typeof msg.tokensApproxMethod === 'string' ? msg.tokensApproxMethod : 'chars/4';
    error = typeof msg.error === 'string' ? msg.error : null;
    loaded = true;
  });

  refresh();

  // Biggest first — the point of the pane — EXCEPT the three shipped prompts:
  // the base prompt pinned at top, then files biggest-first, then the two
  // collab layers last under their own subheading. None of the three are
  // FILES, so they are not counted as such; their chars still count, being
  // genuinely sent. Tiers live in components/instructionRows.ts.
  let grouped = $derived(sections(entries));
  let files = $derived(grouped.files.length);
  let share = (e: Entry): number => (totalChars > 0 ? (e.chars / totalChars) * 100 : 0);

  function open(e: Entry): void {
    const message = openMessage(e);
    if (message) vscode.postMessage(message);
  }

  /** The "+ New file" row. No path crosses, for the reason every pinned row
   *  already refuses to name one: the HOST resolves the target (the workspace's
   *  own AGENTS.md), seeds it from the /firstfold template when it is absent,
   *  and opens it. A webview naming the file would be a webview choosing where
   *  the extension writes. */
  function newInstructionFile(): void {
    vscode.postMessage({ type: 'createInstructionFile' });
  }
</script>

<div class="ins-pane">
  <div class="ins-toolbar">
    <span class="ins-head-title">Instructions</span>
    <span class="ins-totals">
      {files} file{files === 1 ? '' : 's'} ·
      {totalChars.toLocaleString()} chars ·
      ~{totalTokensApprox.toLocaleString()} tokens
    </span>
    <button class="ins-refresh" onclick={refresh} title="Reload the instruction inventory">↻</button>
  </div>

  <div class="ins-note">
    Everything here is prepended to a prompt whether or not you ever look at it — the two collab rows on
    collab turns, the rest on every prompt. Token figures are an <strong>estimate</strong> only: the engine
    reports its method as <code>{method}</code>, a character count divided by four, not a tokenisation.
  </div>

  <div class="ins-scroll">
  {#if !loaded}
    <div class="ins-empty">Reading the instruction inventory…</div>
  {:else if error}
    <div class="ins-error">{error}</div>
  {:else if entries.length === 0}
    <div class="ins-empty">
      Nothing feeds the system prompt in this workspace — no AGENTS.md, CLAUDE.md, memory file or configured
      instruction path was found.
    </div>
  {:else}
    <!-- A STACK of full-width rows. This list is a ranking, and each row's
         share BAR is the ranking made visible — a bar is only comparable to the
         one above it when both are drawn to the same width, which a grid of
         columns cannot promise. Tier order: main, then files biggest-first,
         then the collab layer under its own subheading. -->
    <div class="ins-list">
      {#each grouped.main as e (e.path)}<InstructionRow entry={e} share={share(e)} onOpen={open} />{/each}
      {#each grouped.files as e (e.path)}<InstructionRow entry={e} share={share(e)} onOpen={open} />{/each}
      <!-- Last in the FILES tier: the one thing this inventory could never do
           was add to itself. It seeds AGENTS.md — the workspace prompt
           /firstfold already owns a template for. -->
      <button class="ins-new" onclick={newInstructionFile} title="Create (or open) this workspace's AGENTS.md">
        <span class="ins-new-mark" aria-hidden="true">＋</span>
        <span class="ins-new-label">New file</span>
        <span class="ins-new-sub">AGENTS.md for this workspace</span>
      </button>
      {#if grouped.collab.length}<div class="ins-subhead">Collab</div>{/if}
      {#each grouped.collab as e (e.path)}<InstructionRow entry={e} share={share(e)} onOpen={open} />{/each}
    </div>
  {/if}
  <CacheStatsCard />
  <PromptCaptureSection />
  </div>
</div>

<style>
  .ins-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .ins-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .ins-head-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-secondary); }
  .ins-totals { flex: 1; font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .ins-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .ins-refresh:hover { background: var(--og-btn-hover); }
  .ins-note { margin: 10px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); background: var(--og-surface); border: 1px solid var(--og-border); border-left: 3px solid var(--og-warning); border-radius: 4px; flex-shrink: 0; }
  .ins-note code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .ins-scroll { flex: 1; overflow-y: auto; min-height: 0; }
  /* The row itself is InstructionRow.svelte — its styles went with its
     markup, since Svelte scopes them per component. */
  .ins-list { padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
  .ins-subhead { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); margin: 2px 2px 0; }
  /* A row like the ones above it — same width, padding and radius — but
     deliberately DASHED and quiet, and carrying no share bar: it is an empty
     slot, and a solid row would read as a file already feeding the prompt. */
  .ins-new { display: flex; align-items: center; gap: 8px; text-align: left; background: transparent; border: 1px dashed var(--og-border); border-radius: 5px; padding: 7px 9px; cursor: pointer; color: var(--og-text-muted); font-family: inherit; }
  .ins-new:hover { border-color: var(--og-chat); color: var(--og-text); }
  .ins-new-mark { font-size: 13px; line-height: 1; }
  .ins-new-label { font-size: 12px; font-weight: 600; }
  .ins-new-sub { margin-left: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 9px; }
  .ins-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .ins-error { color: var(--og-error); font-size: 12px; padding: 16px; line-height: 1.5; }
</style>
