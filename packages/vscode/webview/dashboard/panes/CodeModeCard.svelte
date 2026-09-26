<script lang="ts">
  // The code-mode card, extracted out of ToolsPane.svelte when the sub-agent
  // matrix landed and the pane had one line of slack left. Self-contained in
  // the same way NewToolPanel and ToolsNotes are: one setting, its switch and
  // the paragraph that explains it, with no knowledge of the tool list.
  let { on, onToggle }: { on: boolean; onToggle: () => void } = $props();
</script>

<div class="tl-card">
  <div class="tl-card-head">
    <span class="tl-card-title">Code mode</span>
    <button
      class="tl-switch"
      class:on
      role="switch"
      aria-checked={on}
      onclick={onToggle}
      title="Toggle origami.experimentalCodeMode"
    >
      <span class="tl-switch-knob"></span>
    </button>
  </div>
  <div class="tl-card-body">
    Experimental. Replaces the individual MCP tools with one <code>execute</code> tool running a confined
    JavaScript program, so the model can call several MCP tools — including in parallel — from one script.
    It changes how the model reaches MCP tools, so try it before leaving it on.
    <strong>New chats use the change at once.</strong> Open chats keep the value they started with until you close
    and reopen them: a chat's engine reads the setting when it starts.
  </div>
</div>

<style>
  .tl-card { border: 1px solid var(--og-border); border-radius: 5px; background: var(--og-surface); color: var(--og-text); }
  .tl-card-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--og-border); }
  .tl-card-title { flex: 1; font-size: 12px; font-weight: 600; }
  .tl-card-body { padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); }
  .tl-card-body code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
  /* The ON state is carried by the track colour AND the knob's position, so it
     never depends on colour alone in any of the five themes. */
  .tl-switch { width: 34px; height: 18px; border-radius: 9px; border: 1px solid var(--og-border); background: var(--og-btn-bg); cursor: pointer; padding: 0 2px; display: flex; align-items: center; justify-content: flex-start; flex-shrink: 0; }
  .tl-switch.on { background: var(--og-accent); justify-content: flex-end; }
  .tl-switch-knob { width: 12px; height: 12px; border-radius: 50%; background: var(--og-text); display: block; }
</style>
