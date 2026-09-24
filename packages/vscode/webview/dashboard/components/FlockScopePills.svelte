<script lang="ts">
  // THE TICK GROUPS — Repos, Wiki, Folders, as pills one contact can be
  // granted or cut off from. contactScope.ts already overlaid the known
  // options, the desk's defaults and this contact's own list into one flat
  // array; this leaf only groups it under three small-caps heads and draws
  // the tick, the `default` tag and the dashed "differs" edge — split out of
  // FlockContactScope.svelte because that popover had no room left for three
  // headed sections after the rename, budget and Reset it already draws.
  //
  // SAME LOOK AS THE BOTS PAGE'S TOOL GRID (BotContractFields.svelte's
  // `.bc-tool`): a checkbox inside a rounded pill, picked = an accent border
  // and a tinted fill. Copied rather than imported, so this leaf owns no
  // dependency on a pane it has nothing else to do with.
  import type { FlockScopeKind } from '../panes/flockTypes';
  import type { ScopePill } from '../panes/contactScope';

  const GROUPS: ReadonlyArray<{ kind: FlockScopeKind; label: string; empty: string }> = [
    { kind: 'repos', label: 'Repos', empty: 'No repos registered on the Folds board yet.' },
    { kind: 'wiki', label: 'Wiki', empty: 'No wiki/ folder in this workspace.' },
    { kind: 'folders', label: 'Folders', empty: 'Browse… to share a folder with them.' },
  ];

  interface Props {
    pills: ScopePill[];
    onbrowse: () => void;
    ontoggle: (kind: FlockScopeKind, value: string) => void;
  }
  let { pills, onbrowse, ontoggle }: Props = $props();

  const rows = (kind: FlockScopeKind) => pills.filter((p) => p.kind === kind);
</script>

<div class="sk">
  {#each GROUPS as group (group.kind)}
    <div class="sk-group">
      <div class="sk-head">
        <span class="fk-caps">{group.label}</span>
        {#if group.kind === 'folders'}
          <button class="fk-btn sm" onclick={onbrowse}>Browse…</button>
        {/if}
      </div>
      {#if rows(group.kind).length === 0}
        <p class="fk-muted">{group.empty}</p>
      {:else}
        <div class="sk-pills">
          {#each rows(group.kind) as pill (pill.value)}
            <label class="fk-tick" class:picked={pill.on} class:differs={pill.differs} title={pill.value}>
              <input type="checkbox" checked={pill.on} onchange={() => ontoggle(pill.kind, pill.value)} />
              <span>{pill.label}</span>
              {#if pill.isDefault}<span class="fk-tag">default</span>{/if}
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .sk-group { min-width: 0; }
  .sk-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .sk-head :global(.fk-caps) { flex: 1; }
  .sk-pills { display: flex; flex-wrap: wrap; gap: 3px 4px; }
  /* The bots page's `.bc-tool` pill, copied rather than shared: transparent,
     picked = an accent border and a tinted fill. `differs` outranks `picked`
     for the border because a decision made FOR this person is the fact the
     owner is looking for, even on a pill that also happens to be on. */
  .fk-tick {
    display: flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 7px 2px 5px;
    background: transparent; color: var(--og-text-secondary); border: 1px solid var(--og-border);
    border-radius: 8px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace);
  }
  .fk-tick.picked { color: var(--og-text); border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
  .fk-tick.differs { border-color: var(--og-accent-2); border-style: dashed; }
  .fk-tick input { margin: 0; }
  .fk-tag { margin-left: 2px; opacity: 0.6; font-style: italic; }
</style>
