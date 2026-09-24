<script lang="ts">
  // WHAT THE FRONT DESK MAY READ, IN THREE COLUMNS.
  //
  // Repos and Wiki are CHECKLISTS. They were text inputs taking comma-separated
  // globs, which is not a permission control: a typo shares nothing, says
  // nothing, and is discovered when a friend's question comes back empty. Every
  // option in those two comes from a list the workspace already keeps
  // (flockScope.ts names both sources), so a tick is a path that exists.
  //
  // FOLDERS is the third column: FlockFolderList.svelte says why it is a list.
  // SKILLS used to be that column. It is gone — a skill is instructions, not a
  // secret, so "may they see it" was a switch with no meaningful off, and the
  // desk reads them unconditionally now.
  //
  // WHAT IS ALREADY IN THE SCOPE BUT NOT ON A LIST still renders, ticked, at the
  // bottom of its group — a glob typed by hand before this pane existed, or a
  // folder browsed to on another machine. Dropping it from the view would let
  // the next click write it out of the config without anyone deciding to.
  //
  // Posts ARRAYS. The whole point: `{ repos: ['a', 'b'] }`, never `'a, b'`.

  import FlockFolderList from './FlockFolderList.svelte';
  import { scopeCount } from '../panes/flockChips';
  import type { FlockScope, FlockScopeKind, FlockScopeOptions } from '../panes/flockTypes';

  type Kind = FlockScopeKind;

  interface Props {
    scope: FlockScope;
    options: FlockScopeOptions;
    /** Called with the WHOLE scope, all three arrays, every time anything moves. */
    onchange: (scope: { repos: string[]; wiki: string[]; folders: string[] }) => void;
    /** Open the host's folder picker for this list. */
    onbrowse: (kind: Kind) => void;
    /** Distinguishes the rows in the DOM when two pickers are on screen. */
    id: string;
  }
  let { scope, options, onchange, onbrowse, id }: Props = $props();

  const TICKED: ReadonlyArray<{ kind: Kind; label: string; empty: string }> = [
    { kind: 'repos', label: 'Repos', empty: 'No repos registered on the Folds board yet.' },
    { kind: 'wiki', label: 'Wiki', empty: 'No wiki/ folder in this workspace.' },
  ];

  const current = (kind: Kind): string[] => scope[kind] ?? [];

  const whole = (kind: Kind, next: string[]) => ({
    repos: current('repos'),
    wiki: current('wiki'),
    folders: current('folders'),
    [kind]: next,
  });

  /** Offered values for a list, in a stable order: the known ones first, then
   *  anything the scope already holds that no list offers. */
  function rows(kind: Kind): Array<{ value: string; label: string; known: boolean }> {
    const known =
      kind === 'repos'
        ? options.repos.map((repo) => ({ value: repo.root, label: repo.name, known: true }))
        : options.wiki.map((value) => ({ value, label: value, known: true }));
    const extra = current(kind)
      .filter((value) => !known.some((row) => row.value === value))
      .map((value) => ({ value, label: value, known: false }));
    return [...known, ...extra];
  }

  function toggle(kind: Kind, value: string, on: boolean): void {
    onchange(whole(kind, on ? [...new Set([...current(kind), value])] : current(kind).filter((e) => e !== value)));
  }

  let total = $derived(scopeCount(scope));
</script>

<div class="sp">
  {#each TICKED as group (group.kind)}
    <div class="sp-group">
      <div class="sp-head">
        <span class="fk-caps">{group.label}</span>
        <button class="fk-btn sm" onclick={() => onbrowse(group.kind)}>Browse…</button>
      </div>
      {#if rows(group.kind).length === 0}
        <p class="fk-muted">{group.empty}</p>
      {:else}
        <div class="sp-list">
          {#each rows(group.kind) as row (row.value)}
            <label class="fk-check" title={row.value}>
              <input
                type="checkbox"
                checked={current(group.kind).includes(row.value)}
                aria-label={`Share ${row.label}`}
                data-scope={`${id}-${group.kind}`}
                onchange={(e) => toggle(group.kind, row.value, e.currentTarget.checked)}
              />
              <span class:foreign={!row.known}>{row.label}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  <FlockFolderList
    {id}
    folders={current('folders')}
    onbrowse={() => onbrowse('folders')}
    onremove={(folder) => onchange(whole('folders', current('folders').filter((e) => e !== folder)))}
  />
</div>
<p class="sp-total" class:none={total === 0}>
  {total === 0
    ? 'Nothing shared — the front desk can answer from no files at all.'
    : `${total} shared ${total === 1 ? 'thing' : 'things'}.`}
</p>

<style>
  /* auto-fit, not a fixed three plus a viewport breakpoint: the picker sits in
     a one-third-width tile now, so what decides how many columns fit is the
     TILE and not the window. A `@media (max-width: 700px)` rule cannot see that
     — on a 1900px screen it never fires, and the three columns were 185px each
     with every repo name ellipsed. */
  .sp { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
  .sp-group { min-width: 0; }
  .sp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .sp-head :global(.fk-caps) { flex: 1; }
  .sp-list { display: flex; flex-direction: column; max-height: 190px; overflow-y: auto; }
  .foreign { font-family: var(--vscode-editor-font-family, monospace); }
  .sp-total { margin: 0; color: var(--og-text-secondary); }
  .sp-total.none { color: var(--og-warning-text); }
</style>
