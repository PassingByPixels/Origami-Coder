<script lang="ts">
  // THE FOLDERS COLUMN — the one scope list that is not a checklist.
  //
  // Repos come from the Folds registry and wiki entries from a directory
  // listing, so both can be offered as ticks. There is no registry of "folders
  // you might share", so this is the list the owner has built: one row per
  // folder with an × to take it out, and a Browse… that adds one more.
  //
  // It exists because "shareable" used to mean a registered repo or a wiki
  // subfolder and nothing else. An owner whose notes live in neither had
  // nothing to tick, and no way to learn that any folder would do — which is
  // why the empty line says so in words rather than reading "no folders".
  //
  // Its own component rather than a third branch inside FlockScopePicker: the
  // picker sat 27 lines over its cap with this inline, and a list that adds and
  // removes whole paths is a different control from a box you tick.
  interface Props {
    /** The folders in this scope. Absolute paths; the engine checks them. */
    folders: string[];
    onbrowse: () => void;
    onremove: (folder: string) => void;
    /** Distinguishes the rows in the DOM when two pickers are on screen. */
    id: string;
  }
  let { folders, onbrowse, onremove, id }: Props = $props();
</script>

<div class="fl-group">
  <div class="fl-head">
    <span class="fk-caps">Folders</span>
    <button class="fk-btn sm" onclick={onbrowse}>Browse…</button>
  </div>
  {#if folders.length === 0}
    <p class="fk-muted">Any folder can be shared, not only a repo. Browse to one.</p>
  {:else}
    <div class="fl-list">
      {#each folders as folder (folder)}
        <span class="fl-row" title={folder}>
          <span class="path">{folder}</span>
          <button
            class="fk-btn sm"
            data-folder={`${id}-folders`}
            aria-label={`Stop sharing ${folder}`}
            onclick={() => onremove(folder)}>×</button
          >
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .fl-group { min-width: 0; }
  .fl-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .fl-head :global(.fk-caps) { flex: 1; }
  .fl-list { display: flex; flex-direction: column; max-height: 190px; overflow-y: auto; }
  /* An absolute path is long, so the ROW must not grow the column it sits in:
     the path ellipses and the × stays reachable at any width. */
  .fl-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .fl-row .path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
