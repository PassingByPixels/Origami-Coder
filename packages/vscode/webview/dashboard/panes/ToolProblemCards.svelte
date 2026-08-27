<script lang="ts">
  // The user tool files the engine found but could NOT load, one error-toned
  // card each. Extracted from ToolsPane.svelte (which sits ON its 220-line
  // cap) the same way ToolCard and NewToolPanel were.
  //
  // IT TAKES THE WHOLE LIST, not one problem, unlike ToolCard beside it. The
  // delete needs a confirm step, and holding "which card is confirming" here —
  // as one name, exactly MCPPane.svelte's `confirming` — keeps both the loop
  // and that state out of a parent with no lines left to give.
  //
  // WHY A CARD AT ALL. This was one small line of muted text below the New
  // tool box, which is precisely where a user who has just scaffolded a file
  // does not look: the tool was simply absent and nothing said why. The pane
  // now draws these FIRST, above everything, and the error tone means they
  // cannot be misread as one more entry in the list of tools that worked.
  // The tone is never the only signal — the tag says it in words too, so the
  // card reads correctly in all five themes.
  interface Problem {
    file: string;
    message: string;
  }
  let {
    problems,
    onOpen,
    onDelete,
  }: { problems: Problem[]; onOpen: (file: string) => void; onDelete: (file: string) => void } = $props();

  /** Both separators: the engine sends whatever its glob found — an absolute
   *  path from `Glob.scanSync(..., { absolute: true })` — so a Windows
   *  workspace gives backslashes and a POSIX one forward slashes. */
  const basename = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file;

  // MCPPane.svelte's idiom exactly: a destructive action costs a second click
  // rather than a modal, only one row can be mid-confirm, and the confirming
  // button is labelled with what it does instead of "OK".
  let confirming: string | null = $state(null);
</script>

<!-- Keyed on `file`: a file that produced no tool has no id to key on. A REPEAT
     here is a Svelte runtime error, and `config.directories()` really can name
     the same folder twice — the engine dedupes before it sends, guarded by
     acp/tools.test.ts's "reports one repeated bad file once". -->
{#each problems as p (p.file)}
  <div class="tp-card">
    <div class="tp-head">
      <span class="tp-name">{basename(p.file)}</span>
      <span class="tp-tag">tool file not loaded</span>
    </div>
    <div class="tp-path">{p.file}</div>
    <div class="tp-reason">{p.message}</div>
    <div class="tp-actions">
      <button class="tp-btn tp-open" onclick={() => onOpen(p.file)}>Open</button>
      {#if confirming === p.file}
        <button class="tp-btn tp-danger tp-confirm" onclick={() => { onDelete(p.file); confirming = null; }}>
          Confirm delete
        </button>
        <button class="tp-btn tp-cancel" onclick={() => (confirming = null)}>Cancel</button>
      {:else}
        <button class="tp-btn tp-delete" onclick={() => (confirming = p.file)}>Delete</button>
      {/if}
    </div>
  </div>
{/each}

<style>
  .tp-card { border: 1px solid var(--og-error); border-left-width: 3px; border-radius: 5px; background: var(--og-error-soft); padding: 9px 10px; display: flex; flex-direction: column; gap: 5px; }
  .tp-head { display: flex; align-items: baseline; gap: 8px; }
  .tp-name { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; font-weight: 600; color: var(--og-error-text); }
  .tp-tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--og-error-text); }
  .tp-path { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-secondary); word-break: break-all; }
  .tp-reason { font-size: 11px; line-height: 1.5; color: var(--og-text); }
  .tp-actions { display: flex; align-items: center; gap: 6px; }
  .tp-btn { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 11px; }
  .tp-btn:hover { background: var(--og-btn-hover); }
  .tp-danger { border-color: var(--og-error); color: var(--og-error-text); }
</style>
