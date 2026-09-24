<script lang="ts">
  // The board-remove ✕ and its confirm step, EXTRACTED from RepoHeader.svelte
  // (139/140 — the confirm would have pushed it over the cap). The header mounts
  // this behind its !repo.workspace guard, so this file never sees the workspace
  // repo. The first click only ARMS the branded ConfirmModal (house rule: no
  // native confirm); nothing reaches the host until the modal's Remove button.
  // Removal is board-only — the host (repoOps.onRemoveRepo) leaves files,
  // tickets and worktrees on disk — and the copy says exactly that.
  // `card`: the same control as the ✕ on a missing repo's card (RepoCards), so
  // both removal paths ask with one confirm.
  import ConfirmModal from './ConfirmModal.svelte';

  interface Props {
    /** Board label over folder name — the confirm names what the user sees. */
    name: string;
    root: string;
    post: (msg: Record<string, unknown>) => void;
    card?: boolean;
  }
  let { name, root, post, card = false }: Props = $props();
  // The arm RECORDS the root it was armed on, and the modal is open only while
  // that is still the root on screen. A broadcast can swap the selected repo
  // under an open confirm (the armed repo was removed by another window) — the
  // comparison disarms it, or the modal would name one repo and remove another.
  // An unchanged root (a poll tick) leaves the confirm open. Proven live: a
  // `$effect(() => { void root; ... })` reset did NOT re-run on the prop swap.
  let armedRoot = $state('');
</script>

<button class={card ? 'am-repocard-x' : 'am-repo-x'} title="Remove from board (files stay on disk)"
  aria-label="Remove {name} from the board" onclick={() => (armedRoot = root)}>✕</button>

<ConfirmModal open={armedRoot === root} tone="danger" title={`Remove ${name} from the board?`}
  body="Files, tickets and worktrees on disk are untouched." confirmLabel="Remove"
  onConfirm={() => { armedRoot = ''; post({ type: 'amRemoveRepo', root }); }}
  onCancel={() => (armedRoot = '')} />

<style>
  /* The button is a direct flex child of .am-repohead (a component adds no
     wrapper element), so margin-left: auto still parks it at the row's end. */
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
  .am-repocard-x {
    align-self: center; margin-left: -6px; padding: 1px 5px; font-size: 11px;
    background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer;
    color: #ff9d9d;
  }
  .am-repocard-x:hover { border-color: #c05050; }
</style>
