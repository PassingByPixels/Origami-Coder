<script lang="ts">
  // The "honest create" box (t-kgtaac round 3) — extracted out of
  // ToolsPane.svelte to keep that file under its architecture cap. Says
  // outright that this is a scaffold, not a builder: the file it writes IS
  // the tool, and the point of the button is to hand its path to an agent.
  let { name = $bindable(''), onScaffold }: { name: string; onScaffold: () => void } = $props();
</script>

<div class="tl-new">
  <div class="tl-new-head">
    <span class="tl-new-label">New tool</span>
    <span class="tl-new-sub">.origami/tool/&lt;name&gt;.ts</span>
  </div>
  <p class="tl-new-copy">
    This is not a tool builder. It scaffolds a starter file from the plugin <code>tool()</code> template, opens
    it, and copies its path — hand that path to an agent (or edit it yourself) to give the tool its behavior.
  </p>
  <div class="tl-new-row">
    <input
      class="tl-new-input"
      bind:value={name}
      placeholder="name_of_tool"
      aria-label="Name for a new workspace tool"
      onkeydown={(ev) => { if (ev.key === 'Enter') onScaffold(); }}
    />
    <button class="tl-new-go" onclick={onScaffold} disabled={name.trim().length === 0}>Scaffold, open &amp; copy path</button>
  </div>
</div>

<style>
  .tl-new { display: flex; flex-direction: column; gap: 6px; border: 1px dashed var(--og-border); border-radius: 5px; padding: 9px 10px; }
  .tl-new:hover { border-color: var(--og-chat); }
  .tl-new-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .tl-new-label { font-size: 12px; font-weight: 600; color: var(--og-text-muted); }
  .tl-new-sub { font-family: var(--vscode-editor-font-family, monospace); font-size: 9px; color: var(--og-text-muted); }
  .tl-new-copy { margin: 0; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .tl-new-copy code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  .tl-new-row { display: flex; align-items: center; gap: 8px; }
  .tl-new-input { flex: 1; min-width: 0; background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
  .tl-new-go { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
  .tl-new-go:hover:not(:disabled) { background: var(--og-btn-hover); }
  .tl-new-go:disabled { opacity: 0.5; cursor: default; }
</style>
