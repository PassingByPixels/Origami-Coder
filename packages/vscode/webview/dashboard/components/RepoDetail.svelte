<script lang="ts">
  // The SELECTED repository, as a pane of its own. 0.4.53 hung this list UNDER
  // the card it belonged to, which is the design UAT round 2 threw out: a reveal
  // that pushed the board down, on a row of cards that already wrapped. Here the
  // cards scroll sideways in the middle of the top strip and the repository you
  // picked is drawn once, on the right, at a fixed width.
  //
  // ONE list at a time, behind a TOGGLE (UAT round 4). Round 3 stacked the two
  // under a mini-header each; the question that came back was "what separates
  // checkouts from branches", which a label the eye scrolls past cannot answer.
  // Two buttons in the top right do, and each list then gets the pane's whole
  // height instead of half of it. CHECKOUTS leads, primary at the top, one
  // RepoCheckoutRow each — that file owns a row and its three actions. BRANCHES is
  // READ-ONLY: a branch is not a place to act, it is the answer to "is that work
  // already checked out somewhere", so each one says which checkout has it out.
  //
  // That mapping is DERIVED from the rows, never sent twice. Two sources for one
  // fact can only ever disagree, and the rows already carry every branch a
  // checkout is on.
  import RepoCheckoutRow from './RepoCheckoutRow.svelte';
  import type { RepoDetailInfo } from './repoGroups';

  interface Props {
    /** The selected ENTRY's root ('' = nothing selected). Every action is keyed
     *  by it — the same key the card's reveal used, so the host routes unchanged. */
    root: string;
    /** That entry's board display name. */
    label: string;
    /** The folder is gone from disk: nothing to list, and nothing to act on. */
    missing: boolean;
    /** Host truth for this repository; absent until the reply lands. */
    detail: RepoDetailInfo | undefined;
    post: (msg: Record<string, unknown>) => void;
  }
  let { root, label, missing, detail, post }: Props = $props();

  // The host already leads with the primary. Ordering again here is what makes
  // the pane's own promise — the checkout that owns the work is the one you read
  // first — hold whatever order a reply happens to arrive in.
  let rows = $derived.by(() => {
    const all = detail?.worktrees ?? [];
    return [...all.filter((w) => w.primary), ...all.filter((w) => !w.primary)];
  });
  // Branches that ARE checked out lead the list: they are the ones the section's
  // only question — "is that work already open somewhere" — is asked about. The
  // rest keep the order git gave them.
  let branches = $derived.by(() => {
    const at = new Map<string, string>();
    for (const w of detail?.worktrees ?? []) if (w.branch) at.set(w.branch, w.name);
    const all = (detail?.branches ?? []).map((name) => ({ name, at: at.get(name) ?? '' }));
    return [...all.filter((b) => b.at !== ''), ...all.filter((b) => b.at === '')];
  });
  // Which list you left a repository on, keyed by its root: view state, so it is
  // neither persisted nor asked of the host. A repository you never toggled opens
  // on Checkouts — the list you act from.
  let view = $state<Record<string, 'checkouts' | 'branches'>>({});
  let mode = $derived(view[root] ?? 'checkouts');
  const show = (m: 'checkouts' | 'branches') => { view = { ...view, [root]: m }; };
</script>

<aside class="am-detail" aria-label="Selected repository">
  {#if !root}
    <div class="am-detail-empty">Pick a repository to see its checkouts and its branches.</div>
  {:else}
    <div class="am-detail-title">
      <div class="am-detail-head" title={root}>{label}</div>
      {#if !missing}
        <div class="am-detail-views" role="group" aria-label="Which list to show">
          <button class="am-viewbtn" class:on={mode === 'checkouts'} aria-pressed={mode === 'checkouts'}
            title="The folders this repository is checked out into" onclick={() => show('checkouts')}
            ><span class="am-view-name">Checkouts</span><span class="am-view-count">{rows.length}</span></button>
          <button class="am-viewbtn" class:on={mode === 'branches'} aria-pressed={mode === 'branches'}
            title="Every local branch, and which checkout has it out" onclick={() => show('branches')}
            ><span class="am-view-name">Branches</span><span class="am-view-count">{branches.length}</span></button>
        </div>
      {/if}
    </div>
    {#if missing}
      <div class="am-detail-empty">folder missing from disk</div>
    {:else if mode === 'checkouts'}
      {#if rows.length === 0}<div class="am-detail-empty">Reading worktrees…</div>{/if}
      {#each rows as wt (wt.path)}
        <RepoCheckoutRow root={root} wt={wt} post={post} />
      {/each}
    {:else}
      {#if branches.length === 0}<div class="am-detail-empty">No local branches read yet.</div>{/if}
      {#each branches as b (b.name)}
        <div class="am-brrow" class:out={b.at !== ''}>
          <span class="am-brrow-name" title={b.name}>{b.name}</span>
          {#if b.at}<span class="am-brrow-at" title="checked out in {b.at}">in {b.at}</span>{/if}
        </div>
      {/each}
    {/if}
  {/if}
</aside>

<style>
  /* A fixed column on the right of the top strip: it must NOT grow with the
     cards beside it (the strip is the only pane that flexes), and it scrolls
     itself rather than making the strip taller. 262 -> 290px, which is what buys
     a row's second line room for its action cluster; the strip absorbs it. */
  .am-detail {
    flex: none;
    width: 290px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    padding: 7px 9px;
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    background: var(--og-surface, rgba(255, 255, 255, 0.03));
  }
  /* The name and the toggle share ONE row: the strip is capped at 190px, so a
     toggle on a line of its own would cost the lists the height it exists to give
     them. The name is the half that gives way — it already ellipsizes. */
  .am-detail-title { flex: none; display: flex; align-items: center; gap: 6px; }
  .am-detail-head {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .am-detail-empty { font-size: 10px; opacity: 0.6; line-height: 1.35; padding: 2px 4px; }
  /* The toggle. Each button carries its own count, so the one you are NOT looking
     at still says how much is over there — the scale the mini-headers used to give
     both lists at once. The active one takes the accent, the same "this is on"
     mark a selected card wears. */
  .am-detail-views { flex: none; display: flex; gap: 3px; }
  .am-viewbtn {
    display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 5px;
    background: transparent; color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
    font: inherit; font-size: 9px; white-space: nowrap; cursor: pointer; opacity: 0.6;
  }
  .am-viewbtn:hover { opacity: 1; }
  .am-viewbtn.on { opacity: 1; border-color: var(--og-accent, #3b6ea5); background: var(--og-accent, #3b6ea5); }
  .am-view-count { font-variant-numeric: tabular-nums; opacity: 0.75; }
  /* The rhythm between checkout rows belongs to the LIST, not to a row that
     cannot see its neighbours — RepoCheckoutRow draws one row and knows nothing
     of the one above it, so the hairline is written here, through :global. */
  .am-detail :global(.am-wtrow + .am-wtrow) { border-top: 1px solid var(--og-border, rgba(255, 255, 255, 0.08)); }
  /* A branch row has no buttons on purpose: the actions belong to a CHECKOUT.
     The only thing a branch says is whether one already has it out — so it is
     drawn quieter than a checkout: one line, with the marker in a column of its
     own on the right rather than trailing the name as prose. */
  .am-brrow { flex: none; display: flex; align-items: baseline; gap: 6px; font-size: 9px; padding: 1px 4px; }
  .am-brrow-name { flex: 1 1 auto; min-width: 0; opacity: 0.55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-brrow.out .am-brrow-name { opacity: 0.95; }
  .am-brrow-at { flex: none; max-width: 45%; opacity: 0.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
