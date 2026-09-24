<script lang="ts">
  // The versions list for ONE artifact: v1..vN with its time and the device
  // that published it, and the three actions from design section 6 — Open
  // (integrated browser), Restore as new version, Compare (the files that
  // changed between that version and the latest).
  //
  // Compare shows a FILE LIST, not a text diff: the manifest is what this lane
  // can render honestly, and a prose diff without the bodies pulled would be a
  // panel that is empty for every artifact still on the other machine.
  import { deviceLabel, lastChange, type MotherBase, type VersionRow } from '../panes/artifactRows';

  let { artifactId, versions = [], latest, homeDevice = '', motherBase, error = '', diff, onOpen, onRestore, onCompare, onReveal }: {
    artifactId: string;
    versions?: VersionRow[];
    latest: number;
    homeDevice?: string;
    motherBase?: MotherBase;
    error?: string;
    diff?: { from: number; to: number; added: string[]; removed: string[]; changed: string[]; error?: string };
    onOpen: (version: number) => void;
    onRestore: (version: number) => void;
    onCompare: (version: number) => void;
    onReveal: (version: number) => void;
  } = $props();

  // Collapsed once a version has been picked to Open — the versions list is a
  // history you consult, not a permanent fixture once you have made a choice
  // from it. The chevron re-expands it. Reset whenever the SELECTED artifact
  // changes, so switching rows never inherits the last row's collapse.
  let collapsed = $state(false);
  $effect(() => { artifactId; collapsed = false; });

  function pick(version: number): void {
    collapsed = true;
    onOpen(version);
  }
</script>

<div class="af-versions">
  <button class="af-vh af-vtoggle" type="button" onclick={() => (collapsed = !collapsed)}
    aria-expanded={!collapsed} aria-label={collapsed ? 'Show versions' : 'Hide versions'}>
    <span class="af-vchevron" class:af-vchevron-collapsed={collapsed}>▾</span>
    Versions
  </button>
  {#if error}
    <p class="af-note" role="alert">{error}</p>
  {/if}
  {#if versions.length === 0}
    <p class="af-note">No versions to show yet.</p>
  {:else if !collapsed}
    <ul class="af-vlist">
      {#each versions as v (v.number)}
        <li class="af-vrow" data-version={v.number}>
          <span class="af-vnum">v{v.number}</span>
          <span class="af-vmeta">{lastChange(v.created)}</span>
          <span class="af-vmeta">{deviceLabel(v.device, homeDevice, motherBase)}</span>
          <span class="af-vactions">
            <button class="af-btn" type="button" onclick={() => pick(v.number)}>Open</button>
            <button class="af-btn" type="button" onclick={() => onRestore(v.number)}>Restore as new version</button>
            <button class="af-btn" type="button" disabled={v.number === latest} onclick={() => onCompare(v.number)}>Compare</button>
            <button class="af-btn" type="button" onclick={() => onReveal(v.number)}>Show in Explorer</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if diff}
    <div class="af-diff" data-artifact-diff={`${diff.from}-${diff.to}`}>
      <p class="af-note">Files changed between v{diff.from} and v{diff.to}</p>
      {#if diff.error}
        <p class="af-note" role="alert">{diff.error}</p>
      {/if}
      <ul class="af-dlist">
        {#each diff.added as file}<li class="af-dfile">added · {file}</li>{/each}
        {#each diff.changed as file}<li class="af-dfile">changed · {file}</li>{/each}
        {#each diff.removed as file}<li class="af-dfile">removed · {file}</li>{/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .af-versions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .af-vh {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--og-text-secondary);
  }
  .af-vtoggle {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .af-vchevron {
    display: inline-block;
    font-size: 10px;
    transition: transform 120ms ease;
  }
  .af-vchevron-collapsed {
    transform: rotate(-90deg);
  }
  .af-note {
    margin: 0;
    font-size: 12px;
    color: var(--og-text-muted);
  }
  .af-vlist,
  .af-dlist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .af-vrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-surface);
    font-size: 12px;
    color: var(--og-text);
  }
  .af-vnum {
    font-weight: 600;
  }
  .af-vmeta {
    color: var(--og-text-muted);
  }
  .af-vactions {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .af-dfile {
    font-size: 12px;
    color: var(--og-text-secondary);
  }
  .af-btn {
    padding: 3px 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    font-size: 11px;
    cursor: pointer;
  }
  .af-btn:hover:not(:disabled) {
    background: var(--og-btn-hover);
  }
  .af-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
