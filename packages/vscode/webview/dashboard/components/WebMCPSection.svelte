<script lang="ts">
  // The MCP pane's "Web MCP" section — the curated address book of WebMCP
  // sites, extracted as its own leaf because it is a coherent whole (list +
  // add form + its own message set) that shares nothing with the server cards
  // above it but the pane it sits in.
  //
  // WHAT MAKES THIS DIFFERENT FROM AN MCP SERVER, and why the copy says so: a
  // WebMCP site has no command, no connection state and nothing to enable. The
  // page IS the server, so the only actions are OPEN it, EDIT what the agent
  // reads about it, and FORGET it. There is deliberately no status pill — there
  // is no connection to report, and one would invite the reading that a site is
  // "running".
  //
  // THE ADD FORM IS PINNED, not merely first: it is `position: sticky` inside
  // the pane's scroll box (.mcp-scroll, MCPPane.svelte), so it is still on
  // screen at the bottom of a fifty-site list. Before, it sat UNDER the grid
  // and was simply unreachable once the list grew (owner report).
  //
  // One card is WebMCPCard.svelte; it took the row's own markup, its inline
  // editor and its draft text when this file reached its architecture cap.
  // What stays here is the list: the data, the filter, and the two one-per-list
  // flags (which row is armed for remove, which row's editor is open).
  import { onDestroy } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import WebMCPCard from './WebMCPCard.svelte';
  import { filterWebMcpSites } from './webmcpFilter';
  const vscode = getVsCodeApi();

  // The site filter box lives in the pane's toolbar (each view owns its box);
  // this section only receives the text and narrows with the same predicate
  // the pane counts with (webmcpFilter.ts), so count and cards cannot drift.
  let { query = '' }: { query?: string } = $props();

  // Mirrors WebMcpSite in src/dashboard/webmcpFile.ts (not imported:
  // tsconfig.webview.json pins rootDir to `webview/`, so a cross-tree import
  // breaks the type gate — the same rule MCPPane.svelte follows).
  interface Site {
    url: string;
    name: string;
    purpose: string;
    addedAt: number;
    notes?: string;
    lastLaunched?: number;
  }

  let sites: Site[] = $state([]);
  let filtered = $derived(filterWebMcpSites(sites, query));
  let file = $state('');
  let loaded = $state(false);
  // Both keyed by the address — the entry's identity — so a re-render cannot
  // move an armed remove or an open editor onto a different row.
  let confirming: string | null = $state(null);
  let editing: string | null = $state(null);

  let newUrl = $state('');
  let newName = $state('');
  let newPurpose = $state('');

  // The SAME validation the host applies (webmcpFile.normalizeSiteUrl): refuse
  // it here so the button is honestly disabled, and again there because a
  // webview message is not a trusted input.
  function validUrl(raw: string): boolean {
    const text = raw.trim();
    if (!text) return false;
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  let urlOk = $derived(validUrl(newUrl));
  let urlBad = $derived(newUrl.trim().length > 0 && !urlOk);
  let addReady = $derived(urlOk);

  function load(): void {
    vscode.postMessage({ type: 'webmcpRequest' });
  }

  const onMessage = (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'webmcpData') return;
    sites = Array.isArray(msg.sites) ? msg.sites : [];
    file = typeof msg.file === 'string' ? msg.file : '';
    loaded = true;
    confirming = null;
    // A Save is answered by this same re-read, so the editor closes on the data
    // it produced rather than on an optimistic guess — the rule the whole pane
    // follows. A refresh mid-edit closes it too: the file has moved under it.
    editing = null;
  };
  window.addEventListener('message', onMessage);
  // The pane mounts and unmounts this section on every selector-card switch
  // now, so the listener must leave with the component — without this, each
  // switch stacks one more listener writing to a destroyed component's state.
  onDestroy(() => window.removeEventListener('message', onMessage));

  load();

  function addSite(): void {
    if (!addReady) return;
    vscode.postMessage({
      type: 'webmcpAdd',
      url: newUrl.trim(),
      name: newName.trim(),
      purpose: newPurpose.trim(),
    });
    newUrl = '';
    newName = '';
    newPurpose = '';
  }
</script>

<div class="wmcp">
  <p class="wmcp-copy">
    Browser-native MCP servers: the page itself is the server, so joining one means opening it. Agents read this
    list with <code>webmcp_list</code> and open a site with <code>webmcp_launch</code>; a site's tools are
    discovered fresh on every join.
  </p>

  <div class="wmcp-new">
    <div class="wmcp-new-head"><span class="wmcp-new-label">Add a Web MCP site</span></div>
    <div class="wmcp-new-row">
      <input
        class="wmcp-new-input"
        bind:value={newUrl}
        placeholder="https://origami.gratis/mcp"
        aria-label="Web MCP site address"
      />
      <button class="wmcp-new-go" onclick={addSite} disabled={!addReady}>Add</button>
    </div>
    <div class="wmcp-new-row">
      <input class="wmcp-new-input" bind:value={newName} placeholder="short name (optional)" aria-label="Site name" />
    </div>
    <input
      class="wmcp-new-input"
      bind:value={newPurpose}
      placeholder="what it is for — the reason an agent would open it"
      aria-label="Site purpose"
    />
    <div class="wmcp-new-hint">
      The name is how an agent addresses the site; left blank it takes the host. The purpose is what tells an
      agent WHEN to open it, so it is worth a line.{#if file}<br />Stored in <code>{file}</code>.{/if}
    </div>
    {#if urlBad}
      <div class="wmcp-new-warn">
        "{newUrl.trim()}" is not a web address — a WebMCP site is a page, so it needs an http:// or https:// URL.
      </div>
    {/if}
  </div>

  {#if !loaded}
    <div class="wmcp-empty">Reading the Web MCP list…</div>
  {:else if sites.length === 0}
    <div class="wmcp-empty">No Web MCP sites yet. Add one above.</div>
  {:else if filtered.length === 0}
    <div class="wmcp-empty">No sites match "{query.trim()}".</div>
  {:else}
    <div class="wmcp-grid">
      {#each filtered as s (s.url)}
        <WebMCPCard
          site={s}
          confirming={confirming === s.url}
          editing={editing === s.url}
          onArm={(url) => (confirming = url)}
          onEdit={(url) => (editing = url)}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .wmcp { display: flex; flex-direction: column; gap: 10px; }
  .wmcp-copy { margin: 0; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .wmcp-copy code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }

  /* align-items: start, or grid's default stretch makes every card in a row
     match the tallest one — a single long AGENT NOTES box would still drag
     its row-mates down to its height even after the notes block itself caps
     and scrolls. start lets each card size to its own content.
     Columns are a FIXED 280px, not minmax(280px, 1fr): 1fr let the last,
     partial row stretch its cards wider than the rows above it, so two cards
     of identical content read as two different sizes depending on how many
     neighbours they had. A fixed track keeps every card the same width in
     every row, at the cost of a ragged right edge on partial rows. */
  .wmcp-grid { display: grid; grid-template-columns: repeat(auto-fill, 280px); gap: 8px; align-content: start; align-items: start; }

  /* Same padding as .mcp-empty next door and ToolsPane's .tl-empty — an empty
     state reads at one weight across the whole extension, not lighter here. */
  .wmcp-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }

  /* Same skin as the MCP add box next door — the two forms sit in one pane and
     must not read as two different products.
     PINNED, not just first: this sticks to the top edge of the pane's scroll box
     (.mcp-scroll) so the form is still reachable at the bottom of a fifty-site
     list. That box carries 10px of top padding, and a sticky element's own
     background stops at its own edge, so cards would scroll visibly through that
     band — the zero-blur shadow paints it without taking any layout space. Same
     idiom as CronTable's sticky header. */
  .wmcp-new { position: sticky; top: 0; z-index: 2; background: var(--og-bg); box-shadow: 0 -10px 0 var(--og-bg); display: flex; flex-direction: column; gap: 6px; border: 1px dashed var(--og-border); border-radius: 5px; padding: 9px 10px; }
  .wmcp-new:hover { border-color: var(--og-chat); }
  .wmcp-new-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .wmcp-new-label { font-size: 12px; font-weight: 600; color: var(--og-text-muted); }
  .wmcp-new-row { display: flex; align-items: center; gap: 8px; }
  .wmcp-new-input { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .wmcp-new-go { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
  .wmcp-new-go:hover:not(:disabled) { background: var(--og-btn-hover); }
  .wmcp-new-go:disabled { opacity: 0.5; cursor: default; }
  .wmcp-new-hint { font-size: 10px; line-height: 1.5; color: var(--og-text-muted); }
  .wmcp-new-hint code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-secondary); word-break: break-all; }
  .wmcp-new-warn { font-size: 10px; color: var(--og-warning-text); }

  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
</style>
