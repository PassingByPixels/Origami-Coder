<script lang="ts">
  // The MCP pane's "Add a server" box — extracted out of MCPPane.svelte when
  // the form grew the fields a real server actually needs (cwd, environment,
  // headers) and the pane went over its 330-line cap. The pane keeps the list;
  // this owns one add, start to finish.
  //
  // WHY THE EXTRA FIELDS: the engine has validated the whole
  // ConfigMCPV1.Info schema since it shipped, so `cwd`, `environment` and
  // `headers` were always writable — the form was the part that could only
  // offer a command or a URL. A hosted server added here therefore had no way
  // to be given its API key, and the miss showed up as an auth failure from
  // the server minutes later, not as a form that refused.
  //
  // EVERYTHING IS REFUSED HERE FIRST where it can be. The engine refuses a
  // duplicate name too, and would take a malformed pairs block as an empty
  // record — a server written without the key it needs is worse than one that
  // was never written, because it looks configured.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { parsePairs, pairsError } from './mcpAddForm';
  const vscode = getVsCodeApi();

  /** Names already in the list. The engine refuses a duplicate too; this is
   *  the fast answer, not the authoritative one. */
  let { taken = [] }: { taken?: string[] } = $props();

  let newName = $state('');
  let newType: 'local' | 'remote' = $state('local');
  let newScope: 'project' | 'global' = $state('project');
  let newCommand = $state('');
  let newUrl = $state('');
  let newCwd = $state('');
  let newEnv = $state('');
  let newHeaders = $state('');

  let nameTaken = $derived(taken.includes(newName.trim()));

  // Only the block the CURRENT type will actually send is parsed: a stale
  // headers block left behind by a switch to `local` must not be able to
  // block an add whose message will not carry it.
  let env = $derived(newType === 'local' ? parsePairs(newEnv, '=') : ({ ok: true, pairs: {} } as const));
  let headers = $derived(newType === 'remote' ? parsePairs(newHeaders, ':') : ({ ok: true, pairs: {} } as const));
  let badPairs = $derived(
    !env.ok ? pairsError(env.line, '=', 'Environment') :
    !headers.ok ? pairsError(headers.line, ':', 'Headers') :
    null,
  );

  let addReady = $derived(
    newName.trim().length > 0 && !nameTaken && !badPairs &&
    (newType === 'remote' ? newUrl.trim().length > 0 : newCommand.trim().length > 0),
  );

  function addServer(): void {
    if (!addReady) return;
    // The command stays a raw STRING: splitting it is the host's job
    // (commandFrom in src/dashboard/mcpAddServer.ts), so there is one answer to
    // what a quoted path means. The pairs blocks go the
    // other way — already parsed — because the pane had to read them to refuse
    // a bad line, and parsing them twice is how the two copies drift.
    vscode.postMessage({
      type: 'mcpAdd',
      name: newName.trim(),
      serverType: newType,
      command: newCommand,
      url: newUrl,
      scope: newScope,
      cwd: newType === 'local' ? newCwd.trim() : '',
      environment: env.ok ? env.pairs : {},
      headers: headers.ok ? headers.pairs : {},
    });
    newName = '';
    newCommand = '';
    newUrl = '';
    newCwd = '';
    newEnv = '';
    newHeaders = '';
  }
</script>

<div class="mcp-new">
  <div class="mcp-new-head"><span class="mcp-new-label">Add a server</span></div>
  <p class="mcp-new-copy">
    Writes the server to <code>mcp</code> in the chosen config file and connects it straight away — no session
    restart.
  </p>
  <div class="mcp-new-row">
    <input class="mcp-new-input" bind:value={newName} placeholder="name" aria-label="MCP server name" />
    <select class="mcp-new-select" bind:value={newType} aria-label="Server type">
      <option value="local">local</option>
      <option value="remote">remote</option>
    </select>
    <select class="mcp-new-select" bind:value={newScope} aria-label="Config file to write to">
      <option value="project">project</option>
      <option value="global">global</option>
    </select>
  </div>
  {#if newType === 'remote'}
    <div class="mcp-new-row">
      <input class="mcp-new-input" bind:value={newUrl} placeholder="https://example.com/mcp" aria-label="Remote server URL" />
      <button class="mcp-new-go" onclick={addServer} disabled={!addReady}>Add</button>
    </div>
    <textarea class="mcp-new-area" bind:value={newHeaders} rows="2"
      placeholder={'Authorization: Bearer sk-…\nX-Api-Key: …'} aria-label="Request headers, one per line"></textarea>
    <div class="mcp-new-hint">Headers, optional — one <code>Name: value</code> per line.</div>
  {:else}
    <div class="mcp-new-row">
      <input class="mcp-new-input" bind:value={newCommand} placeholder="node C:/path/server.js" aria-label="Local server command" />
      <button class="mcp-new-go" onclick={addServer} disabled={!addReady}>Add</button>
    </div>
    <!-- The old placeholder was `npx -y @scope/server`, which the owner read as
         "npm packages only" — the field takes any executable and always has. -->
    <div class="mcp-new-hint">
      Any executable and its arguments — node, python, npx, a <code>.exe</code>. Double quotes group an argument
      that contains spaces: <code>"C:/Program Files/node/node.exe" server.js</code>.
    </div>
    <input class="mcp-new-input" bind:value={newCwd} placeholder="working directory (optional)" aria-label="Working directory" />
    <textarea class="mcp-new-area" bind:value={newEnv} rows="2"
      placeholder={'API_KEY=sk-…\nDEBUG=1'} aria-label="Environment variables, one per line"></textarea>
    <div class="mcp-new-hint">Environment, optional — one <code>KEY=VALUE</code> per line.</div>
  {/if}
  {#if nameTaken && newName.trim()}
    <div class="mcp-new-warn">"{newName.trim()}" is already listed — pick another name.</div>
  {/if}
  {#if badPairs}
    <div class="mcp-new-warn">{badPairs}</div>
  {/if}
</div>

<style>
  /* Moved with the markup from MCPPane.svelte — Svelte scopes styles to the
     component that writes the elements, so these could not stay behind. */
  .mcp-new { display: flex; flex-direction: column; gap: 6px; border: 1px dashed var(--og-border); border-radius: 5px; padding: 9px 10px; }
  .mcp-new:hover { border-color: var(--og-chat); }
  .mcp-new-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .mcp-new-label { font-size: 12px; font-weight: 600; color: var(--og-text-muted); }
  .mcp-new-copy { margin: 0; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .mcp-new-copy code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .mcp-new-row { display: flex; align-items: center; gap: 8px; }
  .mcp-new-input { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .mcp-new-select { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-size: 11px; font-family: inherit; }
  .mcp-new-go { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
  .mcp-new-go:hover:not(:disabled) { background: var(--og-btn-hover); }
  .mcp-new-go:disabled { opacity: 0.5; cursor: default; }
  .mcp-new-warn { font-size: 10px; color: var(--og-warning-text); }

  /* The optional fields read as secondary to the command/url row above them:
     same input skin, but a multi-line box and a muted caption, so the box does
     not look like four things you must fill in. */
  .mcp-new-area { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; resize: vertical; }
  .mcp-new-hint { font-size: 10px; line-height: 1.5; color: var(--og-text-muted); }
  .mcp-new-hint code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text-secondary); }
</style>
