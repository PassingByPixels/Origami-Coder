<script lang="ts">
  // Plugins pane (t-kgtolm round 3) — installed agent-plugins.org plugins:
  // name/version/mode, source path, discovered skills, MCP servers + their
  // connection state, load errors, and an enable/disable toggle. Mirrors the
  // Skills/Tools pane idiom (toolbar + search + card grid); the "add from
  // folder" box mirrors NewToolPanel.svelte's honest-create shape. Data comes
  // from the `list_agent_plugins` ACP ext method via src/dashboard/pluginsPane.ts.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  const vscode = getVsCodeApi();

  // Mirrors AgentPluginEntry/AgentPluginMcpServer/AgentPluginProblem in
  // src/acpExtTypes.ts (not imported: tsconfig.webview.json pins rootDir to
  // `webview/`, so a cross-tree import breaks the type gate — same rule
  // SkillsPane.svelte/ToolsPane.svelte follow for their own mirrors).
  interface McpServer {
    name: string;
    type: 'local' | 'remote';
    status: { status: string; era?: string; error?: string };
  }
  interface Plugin {
    name: string;
    version?: string;
    mode: 'strict' | 'lenient';
    root: string;
    spec: string;
    enabled: boolean;
    skillFiles: string[];
    mcp: McpServer[];
    warnings: string[];
  }
  interface Problem {
    spec: string;
    message: string;
  }

  let plugins: Plugin[] = $state([]);
  let problems: Problem[] = $state([]);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let query = $state('');
  let newDir = $state('');

  function load(): void {
    loaded = false;
    error = null;
    vscode.postMessage({ type: 'pluginsRequest' });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data || {};
    if (msg.type !== 'pluginsData') return;
    plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
    problems = Array.isArray(msg.problems) ? msg.problems : [];
    error = typeof msg.error === 'string' ? msg.error : null;
    loaded = true;
  });

  load();

  let filtered = $derived(
    query.trim()
      ? plugins.filter((p) => {
          const q = query.toLowerCase();
          return p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q);
        })
      : plugins,
  );

  function toggleEnabled(p: Plugin): void {
    vscode.postMessage({ type: 'pluginsSetEnabled', spec: p.spec, enabled: !p.enabled });
  }

  function addFolder(): void {
    const dir = newDir.trim();
    if (!dir) return;
    vscode.postMessage({ type: 'pluginsAddFolder', dir });
    newDir = '';
  }

  function statusLabel(s: McpServer['status']): string {
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
  function statusClass(s: McpServer['status']): string {
    if (s.status === 'connected') return 'pg-status-ok';
    if (s.status === 'failed') return 'pg-status-error';
    if (s.status === 'needs_auth' || s.status === 'needs_client_registration') return 'pg-status-warn';
    return 'pg-status-off';
  }
</script>

<div class="pg-pane">
  <div class="pg-toolbar">
    <input class="pg-search" type="text" placeholder="Search plugins…" bind:value={query} />
    <span class="pg-count">{filtered.length}/{plugins.length}</span>
    <button class="pg-refresh" onclick={load} title="Re-read the plugin list from the engine">↻</button>
  </div>

  <div class="pg-scroll">
    <div class="pg-new">
      <div class="pg-new-head">
        <span class="pg-new-label">Add from folder</span>
      </div>
      <p class="pg-new-copy">
        Appends a validated plugin directory to <code>agentPlugins</code> in the project config. A folder with no
        manifest, or a manifest that fails the agent-plugins.org parser, is refused with the parser's own message.
        A new plugin loads on the next session restart.
      </p>
      <div class="pg-new-row">
        <input
          class="pg-new-input"
          bind:value={newDir}
          placeholder="path/to/plugin"
          aria-label="Plugin folder path to add"
          onkeydown={(ev) => { if (ev.key === 'Enter') addFolder(); }}
        />
        <button class="pg-new-go" onclick={addFolder} disabled={newDir.trim().length === 0}>Add</button>
      </div>
    </div>

    {#if problems.length > 0}
      <div class="pg-problems">
        {#each problems as p (p.spec)}
          <div class="pg-problem"><code>{p.spec}</code> — {p.message}</div>
        {/each}
      </div>
    {/if}

    {#if !loaded}
      <div class="pg-empty">Reading the plugin list…</div>
    {:else if error}
      <div class="pg-error">{error}</div>
    {:else if plugins.length === 0}
      <div class="pg-empty">No agent-plugins.org plugins configured. Add one below.</div>
    {:else if filtered.length === 0}
      <div class="pg-empty">No plugins match "{query}".</div>
    {:else}
      <div class="pg-grid">
        {#each filtered as p (p.spec)}
          <div class="pg-card" class:disabled={!p.enabled}>
            <div class="pg-head">
              <span class="pg-name">{p.name}</span>
              {#if p.version}<span class="pg-version">{p.version}</span>{/if}
              <span class="pg-mode">{p.mode}</span>
              <button
                class="pg-switch"
                class:on={p.enabled}
                role="switch"
                aria-checked={p.enabled}
                onclick={() => toggleEnabled(p)}
                title={p.enabled ? 'Disable this plugin' : 'Enable this plugin'}
              >
                <span class="pg-switch-knob"></span>
              </button>
            </div>
            <div class="pg-root"><code>{p.root}</code></div>
            {#if !p.enabled}
              <div class="pg-disabled-note">Disabled — restart the session to apply this.</div>
            {/if}

            <div class="pg-section">
              <span class="pg-section-label">Skills</span>
              {#if p.skillFiles.length === 0}
                <span class="pg-section-empty">none</span>
              {:else}
                <ul class="pg-skill-list">
                  {#each p.skillFiles as f (f)}
                    <li><code>{f}</code></li>
                  {/each}
                </ul>
              {/if}
            </div>

            <div class="pg-section">
              <span class="pg-section-label">MCP servers</span>
              {#if p.mcp.length === 0}
                <span class="pg-section-empty">none</span>
              {:else}
                <div class="pg-mcp-list">
                  {#each p.mcp as server (server.name)}
                    <div class="pg-mcp-row">
                      <span class="pg-mcp-name">{server.name}</span>
                      <span class="pg-mcp-type">{server.type}</span>
                      <span class="pg-mcp-status {statusClass(server.status)}">{statusLabel(server.status)}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            {#if p.warnings.length > 0}
              <div class="pg-warnings">
                {#each p.warnings as w}<div class="pg-warning">{w}</div>{/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .pg-pane { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--og-text); }
  .pg-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--og-border); flex-shrink: 0; }
  .pg-search { flex: 1; padding: 4px 8px; font-size: 12px; background: var(--og-input-bg, var(--og-btn-bg)); color: var(--og-text); border: 1px solid var(--og-border); border-radius: 4px; font-family: inherit; }
  .pg-count { font-size: 11px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; }
  .pg-refresh { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 13px; }
  .pg-refresh:hover { background: var(--og-btn-hover); }
  .pg-scroll { flex: 1; overflow-y: auto; min-height: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

  .pg-problems { display: flex; flex-direction: column; gap: 4px; }
  .pg-problem { font-size: 11px; color: var(--og-warning-text); line-height: 1.4; }

  .pg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; align-content: start; }
  .pg-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; }
  .pg-card.disabled { opacity: 0.7; }
  .pg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pg-name { font-weight: 600; font-size: 12px; color: var(--og-text); }
  .pg-version { font-size: 10px; color: var(--og-text-muted); }
  .pg-mode { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 8px; font-weight: 600; background: var(--og-btn-bg); color: var(--og-text-muted); }
  .pg-switch { margin-left: auto; width: 34px; height: 18px; border-radius: 9px; border: 1px solid var(--og-border); background: var(--og-btn-bg); cursor: pointer; padding: 0 2px; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0; }
  .pg-switch.on { background: var(--og-accent); justify-content: flex-end; }
  .pg-switch-knob { width: 12px; height: 12px; border-radius: 50%; background: var(--og-text); display: block; }
  .pg-root code { font-size: 10px; color: var(--og-text-muted); word-break: break-all; }
  .pg-disabled-note { font-size: 10px; color: var(--og-warning-text); }

  .pg-section { display: flex; flex-direction: column; gap: 3px; }
  .pg-section-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--og-text-secondary); }
  .pg-section-empty { font-size: 11px; color: var(--og-text-muted); font-style: italic; }
  .pg-skill-list { margin: 0; padding-left: 14px; }
  .pg-skill-list li { font-size: 10px; }
  .pg-skill-list code { color: var(--og-text-muted); word-break: break-all; }

  .pg-mcp-list { display: flex; flex-direction: column; gap: 3px; }
  .pg-mcp-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .pg-mcp-name { font-weight: 600; }
  .pg-mcp-type { font-size: 9px; color: var(--og-text-muted); }
  .pg-mcp-status { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; padding: 1px 6px; border-radius: 8px; }
  .pg-status-ok { background: var(--og-success-soft); color: var(--og-success-text); }
  .pg-status-error { background: var(--og-error-soft); color: var(--og-error-text); }
  .pg-status-warn { background: var(--og-warning-soft); color: var(--og-warning-text); }
  .pg-status-off { background: var(--og-btn-bg); color: var(--og-text-muted); }

  .pg-warnings { display: flex; flex-direction: column; gap: 2px; }
  .pg-warning { font-size: 10px; color: var(--og-warning-text); line-height: 1.4; }

  .pg-empty { color: var(--og-text-muted); font-style: italic; font-size: 12px; padding: 24px 16px; text-align: center; line-height: 1.6; }
  .pg-error { color: var(--og-error); font-size: 12px; padding: 16px; line-height: 1.5; }

  .pg-new { display: flex; flex-direction: column; gap: 6px; border: 1px dashed var(--og-border); border-radius: 5px; padding: 9px 10px; }
  .pg-new:hover { border-color: var(--og-chat); }
  .pg-new-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .pg-new-label { font-size: 12px; font-weight: 600; color: var(--og-text-muted); }
  .pg-new-copy { margin: 0; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .pg-new-copy code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .pg-new-row { display: flex; align-items: center; gap: 8px; }
  .pg-new-input { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .pg-new-go { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
  .pg-new-go:hover:not(:disabled) { background: var(--og-btn-hover); }
  .pg-new-go:disabled { opacity: 0.5; cursor: default; }

  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
</style>
