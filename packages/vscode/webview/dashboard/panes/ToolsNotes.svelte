<script lang="ts">
  // The Tools view's EXPLANATION of what loaded / deferred / off actually cost.
  // Extracted from ToolsPane.svelte, which was at its architecture cap when the
  // failed-tool cards moved into the grid — the same split ToolCard,
  // NewToolPanel and ToolProblemCards already took out of it.
  //
  // Prose and nothing else: no state, no messages, no props. The words are the
  // point — this is the only place the pane says that a RUNNING chat may have
  // more tools loaded than the list shows, and that both settings take effect
  // on the next engine start rather than now. Pinned above the scroller, so it
  // does not scroll away from the cards it explains.
  // Colours are theme vars ONLY.
</script>

<div class="tl-note">
  A <strong>loaded</strong> tool sends its whole JSON Schema with every request. A <strong>deferred</strong> tool
  costs one catalog line until the model calls <code>tool_search</code>, and stays loaded for the rest of that
  session afterwards — so a running chat may have more loaded than this list shows. An <strong>off</strong> tool is
  not offered at all: no schema, no catalog line, and the model cannot call it. Off is written as
  <code>tools</code> in origami.json, loaded/deferred as <code>experimental.tool_search</code>; both take effect on
  the next engine start. MCP server tools are deferred by default, but are not shown as cards below yet — only
  builtin, user-file and plugin tools are.
</div>

<style>
  .tl-note { margin: 10px 12px 0; padding: 8px 10px; font-size: 11px; line-height: 1.5; color: var(--og-text-secondary); background: var(--og-surface); border: 1px solid var(--og-border); border-left: 3px solid var(--og-warning); border-radius: 4px; flex-shrink: 0; }
  .tl-note code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--og-text); }
</style>
