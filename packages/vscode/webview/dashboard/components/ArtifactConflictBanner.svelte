<script lang="ts">
  // The conflict banner (design note section 6). Both machines published, both
  // versions exist, and the owner decides which one is the latest — so the
  // banner offers the two real answers and never resolves anything itself.
  //
  // "Keep mine as a sibling" is `artifact_restore` on the version you opened:
  // it publishes yours again, on top of theirs, so both survive.
  import { conflictSentence, type ArtifactRow, type MotherBase } from '../panes/artifactRows';

  let { row, homeDevice = '', motherBase, onOpenTheirs, onKeepMine }: {
    row: ArtifactRow;
    homeDevice?: string;
    motherBase?: MotherBase;
    onOpenTheirs: (version: number) => void;
    onKeepMine: (version: number) => void;
  } = $props();
</script>

{#if row.conflict}
  <div class="af-conflict" role="alert" data-artifact-conflict={row.id}>
    <p class="af-conflict-text">{conflictSentence(row, homeDevice, motherBase)}</p>
    <div class="af-conflict-actions">
      <button class="af-btn" type="button" onclick={() => onOpenTheirs(row.conflict!.theirVersion)}>
        Open v{row.conflict.theirVersion}
      </button>
      <button class="af-btn" type="button" onclick={() => onKeepMine(row.conflict!.yourVersion)}>
        Keep mine as a sibling
      </button>
    </div>
  </div>
{/if}

<style>
  .af-conflict {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--og-warning);
    border-radius: 8px;
    background: var(--og-warning-soft);
    color: var(--og-warning-text);
  }
  .af-conflict-text {
    margin: 0;
    font-size: 12px;
  }
  .af-conflict-actions {
    display: flex;
    gap: 8px;
  }
  .af-btn {
    padding: 4px 10px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-btn-bg);
    color: var(--og-btn-text);
    font-size: 12px;
    cursor: pointer;
  }
  .af-btn:hover {
    background: var(--og-btn-hover);
  }
</style>
