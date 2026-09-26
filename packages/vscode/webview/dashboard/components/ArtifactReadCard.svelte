<script lang="ts">
  // ArtifactReadCard — t-yyz5yk (Round 8 L): ArtifactCard's shape for a
  // finished `artifact_get`, with what the read found: latest or a newer
  // version, entry · files · size · short id, and Copy link on hover. Its own
  // file because ArtifactCard.svelte is at its line cap; the classes match
  // ArtifactCard's so both read the same. The rest of the note is ArtifactCard's:
  // one `origami://artifact/<id>?v=<n>` link: title, version, Open (t-s49986). A leaf beside the tool card's path
  // link: that one answers "where is this file?", this one "show me the page".
  //
  // Open posts the SAME message the Artifacts pane's Open posts, so the host
  // opens it through one path: `artifact_open` for the live url, then the
  // integrated browser, reusing the tab if it is already open (artifactsOpen.ts).
  // The message is built from primitive props, so there is no $state proxy to
  // snapshot before postMessage.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { artifactOpenMessage } from './artifactLink';
  import { formatBytes, type ArtifactFacts } from './toolRowMeta';
  import { copy } from '../panes/flockCopy';
  import { tip } from '../../shared/warmTip';

  let { artifactId, version, title = '', facts }: { artifactId: string; version: number; title?: string; facts: ArtifactFacts } = $props();
  let copied = $state(false);
  function copyLink(e: MouseEvent) {
    e.stopPropagation();
    copy(`origami://artifact/${artifactId}?v=${version}`);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
  let factsLine = $derived([facts.entry, `${facts.files} files`, formatBytes(facts.bytes), `${artifactId.slice(0, 11)}…`].filter(Boolean).join(' · '));

  const vscode = getVsCodeApi();
  let label = $derived(title || 'Artifact');

  function open(e: MouseEvent) {
    // A card inside a tool card's header area must not also fold the card.
    e.stopPropagation();
    vscode.postMessage(artifactOpenMessage({ artifactId, version }));
  }
</script>

<div class="ac-card facts" data-artifact-id={artifactId} data-artifact-version={version}>
  <span class="ac-icon" aria-hidden="true">▣</span>
  <span class="ac-main">
    <span class="ac-line">
      <span class="ac-title" use:tip={title ? `${title} (${artifactId})` : artifactId}>{label}</span>
      <span class="ac-ver">v{version}</span>
      {#if facts.version >= facts.latest}<span class="ac-latest">latest</span>
      {:else}<span class="ac-newer">v{facts.latest} is newer</span>{/if}
    </span>
    {#if factsLine}<span class="ac-meta">{factsLine}</span>{/if}
  </span>
  <button class="ac-copy" type="button" onclick={copyLink} use:tip={'Copy the origami:// link'}>{copied ? '✓' : 'Copy link'}</button>
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
  .ac-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .ac-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ac-card.facts { animation: ac-in 240ms cubic-bezier(0.23, 1, 0.32, 1); }
  @keyframes ac-in { from { opacity: 0; filter: blur(3px); transform: translateY(3px); } }
  .ac-latest, .ac-newer { font-size: 10px; flex: none; }
  .ac-latest { color: var(--og-success); }
  .ac-newer { color: var(--og-warning); }
  .ac-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--og-text-muted);
  }
  .ac-copy {
    padding: 2px 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: none;
    color: var(--og-text-muted);
    font-size: 10.5px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .ac-card:hover .ac-copy, .ac-copy:focus-visible { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .ac-card.facts { animation: none; }
    .ac-copy { transition: none; }
  }
  .ac-title {
    flex: 0 1 auto;
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
