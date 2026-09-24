<script lang="ts">
  // MCP pane — every MCP server the engine knows, config-declared AND
  // plugin-provided, with its live connection state and the actions that
  // change it. Mirrors the Plugins/Tools pane idiom (toolbar + search + card
  // grid + an add box). Data and every write come from the `mcp_*` ACP ext
  // methods via src/dashboard/mcpPane.ts.
  //
  // SOURCE and SHADOWED are the two columns this view exists for: the engine
  // merges `{ ...pluginServers, ...cfg.mcp }`, so a config entry silently
  // overrides a plugin's server of the same name. Without saying so, "I
  // disabled it and it is still running" has no explanation on screen.
  //
  // The "Add a server" box lives in MCPAddForm.svelte: it grew the fields a
  // real server needs (cwd, environment, headers) and took this file over its
  // cap. It posts its own `mcpAdd` — this pane only tells it which names are
  // taken, and hears about the result through the same `mcpData` re-read every
  // other write here goes through.
  // The "Web MCP" half is its own leaf (WebMCPSection.svelte): a browser-native
  // site has no command, no connection and nothing to enable, so it shares no
  // state or code path with the server cards — only the pane. Two selector
  // cards at the top pick which half renders; only the picked one is on screen
  // (UAT: the two stacked headings read as one long undivided pane).
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import MCPAddForm from '../components/MCPAddForm.svelte';
  import WebMCPSection from '../components/WebMCPSection.svelte';
  import { filterWebMcpSites } from '../components/webmcpFilter';
  const vscode = getVsCodeApi();

  // Mirrors McpServerEntry/AgentPluginMcpStatus in src/acpExtTypes.ts (not
  // imported: tsconfig.webview.json pins rootDir to `webview/`, so a
  // cross-tree import breaks the type gate — the same rule PluginsPane.svelte
  // follows). mcpWireShape.test.ts reads BOTH files and fails on drift.
  interface Status {
    status: string;
    era?: string;
    error?: string;
  }
  interface Server {
    name: string;
    source: 'config' | 'plugin';
    shadowed: boolean;
    type: 'local' | 'remote' | 'unknown';
    enabled: boolean;
    url?: string;
    command?: string[];
    status: Status;
    supportsOAuth: boolean;
    auth?: 'authenticated' | 'expired' | 'not_authenticated';
  }

  let servers: Server[] = $state([]);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let query = $state('');
  let confirming: string | null = $state(null);
  let authUrls: Record<string, string> = $state({});
  // Which half is on screen. View state only — nothing is posted, and the
  // choice lives exactly as long as the webview (the RepoCards/boardViews way).
  let section: 'servers' | 'webmcp' = $state('servers');
  // The Web MCP half's sites and ITS OWN filter box text (each view owns its
  // box — the servers search never filters sites). The section still owns the
  // list; the pane overhears the same `webmcpData` broadcast for the selector
  // card's count and the toolbar box's n/m, filtering with the SAME leaf the
  // section narrows with (webmcpFilter.ts) so the two cannot drift.
  let webSites: Array<{ url: string; name: string; purpose: string }> = $state([]);
  let webQuery = $state('');
  let webFiltered = $derived(filterWebMcpSites(webSites, webQuery));

  function load(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'mcpRequest' });
    // The Web MCP section below is refreshed by the SAME button: it names its
    // registry file on screen, which invites a hand-edit, and one pane with a
    // refresh that reloads half of it would be a trap. The section listens for
    // `webmcpData` on the window, so it does not need to be reached directly.
    vscode.postMessage({ type: 'webmcpRequest' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'mcpAuthUrl') {
      if (typeof msg.name === 'string' && typeof msg.url === 'string') {
        authUrls = { ...authUrls, [msg.name]: msg.url };
      }
      return;
    }
    if (msg.type === 'webmcpData') {
      webSites = Array.isArray(msg.sites) ? msg.sites : [];
      return;
    }
    if (msg.type !== 'mcpData') return;
    servers = Array.isArray(msg.servers) ? msg.servers : [];
    error = typeof msg.error === 'string' ? msg.error : null;
    loaded = true;
    confirming = null;
  });

  load();

  let filtered = $derived(
    query.trim()
      ? servers.filter((s) => {
          const q = query.toLowerCase();
          return s.name.toLowerCase().includes(q) || (s.url ?? '').toLowerCase().includes(q);
        })
      : servers,
  );

  let takenNames = $derived(servers.map((s) => s.name));

  const act = (type: string, name: string, extra: Record<string, unknown> = {}) =>
    vscode.postMessage({ type, name, ...extra });

  function statusLabel(s: Status): string {
    switch (s.status) {
      case 'connected':
        return 'connected';
      case 'failed':
        return 'failed';
      case 'needs_auth':
        return 'needs auth';
      case 'needs_client_registration':
        return 'needs registration';
      default:
        return 'not connected';
    }
  }
  function statusClass(s: Status): string {
    if (s.status === 'connected') return 'mcp-status-ok';
    if (s.status === 'failed') return 'mcp-status-error';
    if (s.status === 'needs_auth' || s.status === 'needs_client_registration') return 'mcp-status-warn';
    return 'mcp-status-off';
  }
</script>

<div class="mcp-pane">
  <!-- TWO KINDS OF SERVER, AS SELECTOR CARDS. Behind the first card is every
       process or endpoint the engine connects to; behind the second, web pages
       that ARE servers. Two stacked headings drew both at once and read as one
       long undivided list (UAT), so each card now names its half and counts
       it, and only the picked half renders below. Button-card idiom borrowed
       from RepoCards.svelte. -->
  <div class="mcp-pick">
    <button class="mcp-pick-card" class:on={section === 'servers'} aria-pressed={section === 'servers'}
      onclick={() => (section = 'servers')}>
      <span class="mcp-pick-name">MCP Servers</span>
      <span class="mcp-pick-count">{servers.length} {servers.length === 1 ? 'server' : 'servers'}</span>
    </button>
    <button class="mcp-pick-card" class:on={section === 'webmcp'} aria-pressed={section === 'webmcp'}
      onclick={() => (section = 'webmcp')}>
      <span class="mcp-pick-name">Web MCP</span>
      <span class="mcp-pick-count">{webSites.length} {webSites.length === 1 ? 'site' : 'sites'}</span>
    </button>
  </div>

  <div class="mcp-toolbar">
    {#if section === 'servers'}
      <!-- EACH VIEW OWNS ITS BOX: the servers search filters servers only, the
           sites box below filters sites only — one shared box filtering
           "whichever half is up" would make either view's no-match state a
           mystery typed on the other. The refresh is the one shared control:
           it re-reads BOTH lists, so it stays reachable from either half. -->
      <input class="mcp-search" type="text" placeholder="Search servers…" bind:value={query} />
      <span class="mcp-count">{filtered.length}/{servers.length}</span>
    {:else}
      <input class="wmcp-search" type="text" placeholder="Search sites…" bind:value={webQuery} />
      <span class="mcp-count">{webFiltered.length}/{webSites.length}</span>
    {/if}
    <button class="mcp-refresh" onclick={load} title="Re-read both lists — MCP servers from the engine, Web MCP sites from the registry file">↻</button>
  </div>

  <div class="mcp-scroll">
    {#if section === 'servers'}
      <MCPAddForm taken={takenNames} />

      {#if !loaded}
        <div class="mcp-empty">Reading the MCP server list…</div>
      {:else if error}
        <div class="mcp-error">{error}</div>
      {:else if servers.length === 0}
        <div class="mcp-empty">No MCP servers configured. Add one above.</div>
      {:else if filtered.length === 0}
        <div class="mcp-empty">No servers match "{query}".</div>
      {:else}
        <div class="mcp-grid">
          {#each filtered as s (s.name)}
            <div class="mcp-card" class:disabled={!s.enabled}>
              <div class="mcp-head">
                <span class="mcp-name">{s.name}</span>
                <span class="mcp-type">{s.type}</span>
                <span class="mcp-source">{s.source}</span>
                <span class="mcp-status {statusClass(s.status)}">{statusLabel(s.status)}</span>
              </div>

              {#if s.shadowed}
                <div class="mcp-shadow">
                  Overrides a plugin server of the same name — the plugin's own definition is not used.
                </div>
              {/if}
              {#if s.type === 'unknown'}
                <div class="mcp-shadow mcp-bare">
                  A bare <code>enabled</code> entry with no <code>type</code> — it only turns a plugin's server off.
                </div>
              {/if}

              {#if s.url}<div class="mcp-detail"><code>{s.url}</code></div>{/if}
              {#if s.command}<div class="mcp-detail"><code>{s.command.join(' ')}</code></div>{/if}

              {#if s.status.status === 'failed' && s.status.error}
                <div class="mcp-fail">{s.status.error}</div>
              {/if}
              {#if s.auth && s.auth !== 'not_authenticated'}
                <div class="mcp-auth">credential: {s.auth}</div>
              {/if}
              {#if authUrls[s.name]}
                <button class="mcp-link" onclick={() => act('mcpOpenAuthUrl', s.name, { url: authUrls[s.name] })}>
                  Browser did not open? Open the sign-in page
                </button>
              {/if}

              <div class="mcp-actions">
                <button class="mcp-btn" onclick={() => act('mcpSetEnabled', s.name, { enabled: !s.enabled })}>
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
                {#if s.status.status === 'connected'}
                  <button class="mcp-btn" onclick={() => act('mcpDisconnect', s.name)}>Disconnect</button>
                {:else}
                  <button class="mcp-btn" onclick={() => act('mcpConnect', s.name)}>Connect</button>
                {/if}
                {#if s.supportsOAuth}
                  <button class="mcp-btn" onclick={() => act('mcpAuthenticate', s.name)}>Authenticate</button>
                {/if}
                {#if s.auth && s.auth !== 'not_authenticated'}
                  <button class="mcp-btn" onclick={() => act('mcpAuthRemove', s.name)}>Forget login</button>
                {/if}
                {#if s.source === 'config'}
                  {#if confirming === s.name}
                    <button class="mcp-btn mcp-danger" onclick={() => { act('mcpRemove', s.name); confirming = null; }}>
                      Confirm remove
                    </button>
                    <button class="mcp-btn" onclick={() => (confirming = null)}>Cancel</button>
                  {:else}
                    <button class="mcp-btn" onclick={() => (confirming = s.name)}>Remove</button>
                  {/if}
                {:else}
                  <span class="mcp-note">Plugin-provided — disable it rather than removing it.</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <WebMCPSection query={webQuery} />
    {/if}
  </div>
</div>

<style>
  .mcp-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .mcp-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  /* .wmcp-search is the SAME skin on its own name: mcpPane.test.ts pins
     ".mcp-search" as the servers-only box, so the sites box cannot wear it. */
  .mcp-search, .wmcp-search { flex: 1; min-width: 120px; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .mcp-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  /* margin-left keeps it on the right edge when the search is not rendered
     (the Web MCP half); with the search present the flex already does it. */
  .mcp-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; margin-left: auto; }
  .mcp-refresh:hover { background: var(--og-btn-hover); }
  .mcp-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

  /* The selector cards — RepoCards' button-card shape on this pane's tokens.
     `.on` reads selected the same way .am-repocard.on does: accent border +
     accent fill. No invented tokens; every var here is in shared/theme.css. */
  .mcp-pick { display: flex; gap: 8px; padding: 10px 12px 0; flex-shrink: 0; }
  .mcp-pick-card { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 10px; background: var(--og-surface); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 6px; cursor: pointer; font: inherit; text-align: left; }
  .mcp-pick-card:hover { filter: brightness(1.15); }
  .mcp-pick-card.on { border-color: var(--og-accent); background: var(--og-accent); }
  .mcp-pick-name { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .mcp-pick-count { font-size: 10px; opacity: 0.75; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; align-content: start; }
  .mcp-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; }
  .mcp-card.disabled { opacity: 0.7; }
  .mcp-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .mcp-name { font-weight: 600; font-size: 12px; color: var(--og-text); }
  .mcp-type, .mcp-source { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 8px; font-weight: 600; background: var(--og-btn-bg); color: var(--og-text-muted); }
  .mcp-status { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; padding: 1px 6px; border-radius: 8px; }
  .mcp-status-ok { background: var(--og-success-soft); color: var(--og-success-text); }
  .mcp-status-error { background: var(--og-error-soft); color: var(--og-error-text); }
  .mcp-status-warn { background: var(--og-warning-soft); color: var(--og-warning-text); }
  .mcp-status-off { background: var(--og-btn-bg); color: var(--og-text-muted); }

  .mcp-shadow { font-size: 10px; color: var(--og-warning-text); line-height: 1.4; }
  .mcp-detail code { font-size: 10px; color: var(--og-text-muted); word-break: break-all; }
  .mcp-fail { font-size: 10px; color: var(--og-error-text); line-height: 1.4; word-break: break-word; }
  .mcp-auth { font-size: 10px; color: var(--og-text-secondary); }
  .mcp-link { background: none; border: none; padding: 0; text-align: left; font-size: 10px; color: var(--og-chat); cursor: pointer; text-decoration: underline; font-family: inherit; }

  .mcp-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
  .mcp-btn { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 7px; font-size: 10px; white-space: nowrap; font-family: inherit; }
  .mcp-btn:hover { background: var(--og-btn-hover); }
  .mcp-danger { border-color: var(--og-error); color: var(--og-error-text); background: var(--og-error-soft); }
  .mcp-note { font-size: 10px; color: var(--og-text-muted); font-style: italic; }

  .mcp-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .mcp-error { color: var(--og-error); font-size: 12px; padding: 16px; line-height: 1.5; }

  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
</style>
