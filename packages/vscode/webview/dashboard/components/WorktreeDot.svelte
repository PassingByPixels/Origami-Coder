<script lang="ts">
  // ONE source, TWO consumers (t-ru1i84): the composer's branch pill and the Agent
  // Manager's repo card both mount this, and both read the same host message. It is a
  // component rather than a line in each of them because RepoBranchPicker.svelte had
  // four lines of headroom under its cap — the ratchet asked for an extraction, and a
  // dot that owns its own wire is a better leaf than a dot each surface re-wires.
  //
  // NOTHING RENDERS until a `worktreeState` for this directory arrives. Against a host
  // that never sends one the dot is simply absent: a grey "clean" dot would be a claim
  // about somebody's working tree that nobody made.
  //
  // The asking, not the answering, is what bounds the cost: the host throttles git to
  // one read per directory per WORKTREE_POLL_MS, and this only asks while the document
  // is visible, so a hidden panel runs no git at all.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/warmTip';
  import { dirKey, worktreeClean, worktreeCounts, worktreeStateOf, worktreeTip, type WorktreeStateView } from './worktreeStateView';

  const { dir, counts = false }: { dir: string; counts?: boolean } = $props();
  const vscode = getVsCodeApi();
  const ASK_MS = 5_000;

  let state = $state<WorktreeStateView | undefined>(undefined);

  const ask = () => {
    if (dir && document.visibilityState === 'visible') vscode.postMessage({ type: 'requestWorktreeState', root: dir });
  };

  // The directory is not known at mount — the composer's pill learns its chat's cwd from
  // a host message that arrives after it. So the ask follows `dir`, and a change of
  // directory DROPS the old answer: a dot left over from the repo the user just switched
  // away from would describe the wrong tree.
  $effect(() => {
    const next = dir;
    state = undefined;
    if (next) ask();
  });

  onMount(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data ?? {};
      if (msg.type === 'worktreeState' && dirKey(msg.root) === dirKey(dir)) state = worktreeStateOf(msg.state);
    };
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', ask);
    const timer = setInterval(ask, ASK_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', ask);
      clearInterval(timer);
    };
  });
</script>

{#if state}
  <span class="wt" data-testid="worktree-state" use:tip={worktreeTip(state)}>
    <span class="wt-dot" class:clean={worktreeClean(state)} data-testid="worktree-dot"></span>
    {#if counts && worktreeCounts(state)}<span class="wt-counts">{worktreeCounts(state)}</span>{/if}
  </span>
{/if}

<style>
  .wt { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
  /* --og-warning for a tree with uncommitted work, --og-success for a clean one.
     Both exist in theme.css; there is no --og-green/--og-red to reach for. */
  .wt-dot {
    flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%;
    background: var(--og-warning);
  }
  .wt-dot.clean { background: var(--og-success); opacity: 0.7; }
  /* `inherit`, not a muted token: the same counts sit on the Agent Manager's SELECTED
     repo card, whose ground is the accent — a fixed muted grey there was barely legible. */
  .wt-counts {
    font-size: 9px; line-height: 1; color: inherit; opacity: 0.8;
    font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
