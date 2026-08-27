<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — fallback renderer.
  // ToolCard dispatches here when the tool name is unknown to the
  // specialised renderers (or when the runtime doesn't supply a
  // tool name at all, e.g. plain ACP servers). Wholesale `<pre>`
  // render of the result text; same behaviour as the pre-Pillar-2
  // generic case in ToolCard.svelte.

  interface Props {
    result: string;
  }

  let { result }: Props = $props();
</script>

<pre class="generic-result">{result}</pre>

<style>
  .generic-result {
    margin: 0;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
