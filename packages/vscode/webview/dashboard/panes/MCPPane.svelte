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
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import MCPAddForm from '../components/MCPAddForm.svelte';
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

  function load(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'mcpRequest' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type === 'mcpAuthUrl') {
      if (typeof msg.name === 'string' && typeof msg.url === 'string') {
        authUrls = { ...authUrls, [msg.name]: msg.url };
      }
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
  <div class="mcp-toolbar">
    <input class="mcp-search" type="text" placeholder="Search servers…" bind:value={query} />
    <span class="mcp-count">{filtered.length}/{servers.length}</span>
    <button class="mcp-refresh" onclick={load} title="Re-read the MCP server list from the engine">↻</button>
  </div>

  <div class="mcp-scroll">
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
  </div>
</div>

<style>
  .mcp-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .mcp-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .mcp-search { flex: 1; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .mcp-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .mcp-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .mcp-refresh:hover { background: var(--og-btn-hover); }
  .mcp-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

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
