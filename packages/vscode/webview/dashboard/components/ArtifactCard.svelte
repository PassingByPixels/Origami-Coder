<script lang="ts">
  // ArtifactCard — one `origami://artifact/<id>?v=<n>` link as the chat shows
  // it: title, version, Open (t-s49986). A leaf beside the tool card's path
  // link: that one answers "where is this file?", this one "show me the page".
  //
  // Open posts the SAME message the Artifacts pane's Open posts, so the host
  // opens it through one path: `artifact_open` for the live url, then the
  // integrated browser, reusing the tab if it is already open (artifactsOpen.ts).
  // The message is built from primitive props, so there is no $state proxy to
  // snapshot before postMessage.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { artifactOpenMessage } from './artifactLink';

  let { artifactId, version, title = '' }: { artifactId: string; version: number; title?: string } = $props();

  const vscode = getVsCodeApi();
  let label = $derived(title || 'Artifact');

  function open(e: MouseEvent) {
    // A card inside a tool card's header area must not also fold the card.
    e.stopPropagation();
    vscode.postMessage(artifactOpenMessage({ artifactId, version }));
  }
</script>

<div class="ac-card" data-artifact-id={artifactId} data-artifact-version={version}>
  <span class="ac-icon" aria-hidden="true">▣</span>
  <span class="ac-title" title={title ? `${title} (${artifactId})` : artifactId}>{label}</span>
  <span class="ac-ver">v{version}</span>
  <button class="ac-open" type="button" onclick={open} aria-label={`Open ${label} version ${version}`}>Open</button>
</div>

<style>
  .ac-card {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 420px;
    margin: 4px 0;
    padding: 6px 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-surface);
    color: var(--og-text);
    font-size: 12px;
  }
  .ac-icon {
    color: var(--og-accent);
  }
  .ac-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .ac-ver {
    color: var(--og-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .ac-open {
    padding: 3px 10px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    font-size: 11px;
    cursor: pointer;
  }
  .ac-open:hover {
    background: var(--og-btn-hover);
  }
</style>
