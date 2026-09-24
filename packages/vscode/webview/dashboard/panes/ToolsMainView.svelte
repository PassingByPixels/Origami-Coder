<script lang="ts">
  // THE MAIN-AGENT VIEW (t-f1j2y3): today's Tools pane, unchanged in content —
  // code mode, the New tool box, the failed-file cards and the tool grid, plus
  // the note that says the deferred catalog is switched off entirely.
  //
  // Extracted when the pane gained its Main agent | Sub-agents switch, on the
  // rule in docs Part 4: the pane was at 205/220 and the switch plus the second
  // view is more than 15 lines, so a module came out rather than the cap going
  // up. The split is the one the feature itself drew — the pane is now the
  // toolbar, the catalog state and which view is showing; each view is its own
  // file.
  //
  // Presentation plus one piece of local state (the new tool's name, which
  // nothing outside this box ever reads). Every write goes to the parent.
  import ToolCard, { type ToolCardEntry } from './ToolCard.svelte';
  import type { ToolState } from './ToolStateSwitch.svelte';
  import NewToolPanel from './NewToolPanel.svelte';
  import ToolProblemCards from './ToolProblemCards.svelte';
  import CodeModeCard from './CodeModeCard.svelte';

  let { cards, problems, codeMode, deferredCatalogOff, onToggleCodeMode, onScaffold, onPick, onCopy, onOpenProblem, onDeleteProblem }: {
    cards: ToolCardEntry[];
    problems: Array<{ file: string; message: string }>;
    codeMode: boolean;
    /** `experimental.tool_search.enabled: false` — every tool is sent in full. */
    deferredCatalogOff: boolean;
    onToggleCodeMode: () => void;
    onScaffold: (name: string) => void;
    onPick: (e: ToolCardEntry, next: ToolState) => void;
    onCopy: (e: ToolCardEntry) => void;
    onOpenProblem: (file: string) => void;
    onDeleteProblem: (file: string) => void;
  } = $props();

  let newName = $state('');

  /** The name crosses; the PATH never does. The host resolves the workspace's
   *  own .origami/tool/ and re-checks the name before it becomes a filename. */
  function scaffold(): void {
    const name = newName.trim();
    if (!name) return;
    onScaffold(name);
    newName = '';
  }
</script>

<CodeModeCard on={codeMode} onToggle={onToggleCodeMode} />

<NewToolPanel bind:name={newName} onScaffold={scaffold} />

<!-- A failed tool file is a CARD AMONG THE CARDS, at the top of the grid — it
     belongs beside the tools it failed to join, not as a page-wide banner above
     the pane's own boxes. It stays OUTSIDE the parent's loaded/error/empty
     chain, so a broken file still shows when the catalog is empty or
     unreadable, which is exactly when it matters most. -->
{#if problems.length > 0 || cards.length > 0}
  <div class="tools-grid">
    <ToolProblemCards {problems} onOpen={onOpenProblem} onDelete={onDeleteProblem} />
    {#each cards as e (e.id)}
      <ToolCard entry={e} {onPick} {onCopy} />
    {/each}
  </div>
{/if}

{#if deferredCatalogOff}
  <div class="tl-off">
    The deferred catalog is switched off (<code>experimental.tool_search.enabled: false</code>), so every tool
    above is sent in full on every request.
  </div>
{/if}

<style>
  .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; align-content: start; }
  .tl-off { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); border: 1px solid var(--og-border); border-left: 3px solid var(--og-accent-2); border-radius: 4px; }
  .tl-off code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
</style>
