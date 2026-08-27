<script lang="ts">
  // The toolbar for the SELECTED repo (contract §6). Everything that used to sit
  // at the top of a repo column moves here, because there is now exactly one repo
  // on screen: its default model, the cartographer map controls + status, the
  // card filter, the background-agent auto-approve toggle, and — for a repo that
  // is not this window's workspace — unregister.
  import AgentModelSelect from './AgentModelSelect.svelte';
  import type { RepoBoard } from './boardBuckets';

  interface ModelOpt { value: string; name: string; configured?: boolean; }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other'; }

  interface Props {
    repo: RepoBoard;
    displayNames: Record<string, string>;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    filter: string;
    onfilter: (v: string) => void;
    autoApprove: boolean;
    /** PANE-owned (single open editor): a repo switch closes this field. */
    renaming: boolean;
    onrenaming: (open: boolean) => void;
    post: (msg: Record<string, unknown>) => void;
  }
  let { repo, displayNames, modelOptions, providerStatus, filter, onfilter, autoApprove, renaming, onrenaming, post }: Props = $props();

  let mapState = $derived(repo.map ?? { status: 'none' as const });
  // Board-only label over the real name (repoOps.ts owns clear-on-equal + persistence).
  let shown = $derived(displayNames[repo.root] ?? repo.name);
  let draft = $state('');
  // One commit per open: Enter/Escape unmount a FOCUSED input; its blur must not commit twice or reopen via the toggle.
  let closing = false;
  $effect(() => { if (renaming) { draft = shown; closing = false; } }); // opened from either pencil: seed the field
  const autofocus = (el: HTMLInputElement) => { el.focus(); el.select(); };
  const cancel = () => { closing = true; onrenaming(false); };
  function commit(): void { if (closing) return; closing = true; onrenaming(false); post({ type: 'amRenameRepo', root: repo.root, displayName: draft.trim() }); }
  function rename(): void { if (!renaming) onrenaming(true); else commit(); }
</script>

<div class="am-repohead">
  {#if renaming}
    <input class="am-repo-rename" use:autofocus value={draft} oninput={(e) => (draft = e.currentTarget.value)}
      onkeydown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
      onblur={() => commit()} aria-label="Board display name for {repo.name}" />
  {:else}
    <span class="am-repo-name" title={shown === repo.name ? repo.root : `${repo.name} — ${repo.root}`}>{shown}</span>
    <button class="am-repo-rename-btn" title="Rename how this repo is shown on the board" aria-label="Rename {shown}" onclick={rename}>✎</button>
  {/if}

  <AgentModelSelect options={modelOptions} providerStatus={providerStatus}
    value={repo.defaultModel} onchange={(v) => post({ type: 'amSetRepoDefault', root: repo.root, model: v })}
    leading={[{ value: '', label: 'Engine default' }]} placeholder="Default model" compact />

  <div class="am-map">
    {#if mapState.status === 'building'}
      <span class="am-map-building">Mapping repository…</span>
      <button class="am-map-cancel" onclick={() => post({ type: 'amCancelMap', root: repo.root })}>Cancel</button>
    {:else}
      <button class="am-map-btn" title="Run the cartographer to map this repo's architecture for agents"
        onclick={() => post({ type: 'amMapRepo', root: repo.root })}>
        {mapState.status === 'ready' ? 'Remap' : 'Map repo'}
      </button>
      {#if mapState.status === 'ready'}
        <button class="am-map-view" onclick={() => post({ type: 'amOpenMap', root: repo.root })}>View map</button>
        <span class="am-map-status" class:stale={mapState.behind === undefined || mapState.behind > 0}
          title={mapState.builtAt ? `built ${new Date(mapState.builtAt).toLocaleString()}` : undefined}>
          {mapState.behind === undefined ? 'map · unknown' : mapState.behind === 0 ? 'map · fresh' : `map · ${mapState.behind} behind`}
        </span>
      {:else if mapState.status === 'failed'}
        <span class="am-map-status failed" title={(mapState.errors ?? []).join('\n') || 'map build failed'}>map · failed</span>
      {/if}
    {/if}
  </div>

  <input class="am-cardfilter" type="text" value={filter}
    oninput={(e) => onfilter(e.currentTarget.value)}
    placeholder="Filter cards…  ( / )" spellcheck="false" aria-label="Filter cards" />

  <label class="am-autoapprove" title="Background agents have no window to answer a permission prompt — with this off, a permission ask hangs the run.">
    <input type="checkbox" checked={autoApprove}
      onchange={(e) => post({ type: 'amSetAutoApprove', on: (e.currentTarget as HTMLInputElement).checked })} />
    Auto-approve agent permissions
  </label>

  {#if !repo.workspace}
    <button class="am-repo-x" title="Unregister from the board — worktrees on disk are untouched"
      aria-label="Unregister this repository" onclick={() => post({ type: 'amRemoveRepo', root: repo.root })}>✕</button>
  {/if}
</div>

<style>
  .am-repohead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 6px 2px;
  }
  .am-repo-name { font-size: 13px; font-weight: 600; }
  .am-repo-rename { background: var(--og-bg); color: var(--og-text); border: 1px solid var(--og-accent); border-radius: 4px; padding: 1px 6px; font: inherit; font-size: 13px; width: 170px; }
  .am-repo-rename-btn { background: transparent; color: var(--og-text-secondary); border: 1px solid transparent; border-radius: 4px; padding: 0 4px; font-size: 11px; cursor: pointer; opacity: 0.65; }
  .am-repo-rename-btn:hover { opacity: 1; border-color: var(--og-border); }
  .am-map { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .am-map-btn, .am-map-view, .am-map-cancel {
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; white-space: nowrap;
  }
  .am-map-btn:hover, .am-map-view:hover, .am-map-cancel:hover { filter: brightness(1.2); }
  .am-map-building { font-size: 11px; opacity: 0.7; }
  .am-map-status { font-size: 10px; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .am-map-status.stale { color: #e0a860; opacity: 0.9; }
  .am-map-status.failed { color: #ff9d9d; opacity: 0.9; cursor: help; }
  .am-cardfilter {
    width: 190px;
    background: var(--og-bg);
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    padding: 3px 8px;
    font: inherit;
    font-size: 11px;
  }
  .am-autoapprove { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; }
  .am-repo-x {
    margin-left: auto;
    background: transparent;
    color: var(--og-text);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.6;
  }
  .am-repo-x:hover { opacity: 1; border-color: #c05050; color: #ff9d9d; }
</style>
