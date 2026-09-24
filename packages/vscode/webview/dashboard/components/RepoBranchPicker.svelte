<script lang="ts">
  // The two pills above the composer: which repo this chat works in, and which of that
  // repo's worktrees. Its own component, mounted from ChatPane with one line, because
  // the composer files are at their caps and this is a whole feature.
  //
  // A branch here is a WORKTREE, never a checkout: picking one hands the host a
  // directory, and the host opens a chat in it. A session's cwd is fixed at creation,
  // so the dropdown says what a pick actually costs (CHANGE_REPO_FOOTER) instead of
  // pretending the current chat moves.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/warmTip';
  import WorktreeDot from './WorktreeDot.svelte'; // t-ru1i84 — the dot owns its own wire
  import { onMount } from 'svelte';
  import {
    CHANGE_REPO_FOOTER, NEW_BRANCH_LABEL, SEARCH_PLACEHOLDER,
    branchForCwd, filterBranches, rememberSelection, repoForCwd, sameDir, selectionFor,
    type BranchRow, type RepoOption,
  } from './repoBranchPicker';

  const { sessionId }: { sessionId: string } = $props();
  const vscode = getVsCodeApi();

  let repos = $state<RepoOption[]>([]);
  let cwdBySession = $state<Record<string, string>>({});
  let defaultRoot = $state('');
  let branches = $state<BranchRow[]>([]);
  let branchRoot = $state(''); // which repo `branches` belongs to
  // The repo the user has CHOSEN but not yet committed to by picking a worktree.
  // WITHOUT IT (t-qi09w0) `repo` could only ever be the repo the session's cwd is in,
  // so branches for any OTHER repo failed the `sameDir(branchRoot, repo.root)` gate
  // below, the dropdown rendered "No worktrees", the old repo stayed ticked, and there
  // was no row left to click — choosing another repo was a dead end.
  let pendingRoot = $state('');
  let repoOpen = $state(false);
  let branchOpen = $state(false);
  let query = $state('');
  let error = $state('');

  // The chat's directory: the host's own answer for this session, falling back to the
  // pick this webview made before the new chat's cwd came back.
  const cwd = $derived(cwdBySession[sessionId] || selectionFor(sessionId)?.path || defaultRoot);
  const repo = $derived(repos.find((r) => sameDir(r.root, pendingRoot)) ?? repoForCwd(repos, cwd));
  const rows = $derived(sameDir(branchRoot, repo?.root) ? branches : []);
  const branch = $derived(branchForCwd(rows, cwd) || selectionFor(sessionId)?.branch || '');
  const shown = $derived(filterBranches(rows, query));

  onMount(() => {
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data ?? {};
      if (msg.type === 'repoPickerOptions') {
        repos = Array.isArray(msg.repos) ? msg.repos : [];
        defaultRoot = typeof msg.defaultRoot === 'string' ? msg.defaultRoot : '';
        cwdBySession = msg.cwdBySession && typeof msg.cwdBySession === 'object' ? msg.cwdBySession : {};
      } else if (msg.type === 'repoPickerBranches') {
        branchRoot = typeof msg.root === 'string' ? msg.root : '';
        branches = Array.isArray(msg.branches) ? msg.branches : [];
      } else if (msg.type === 'repoPickerError') {
        error = typeof msg.message === 'string' ? msg.message : 'could not create that branch';
      } else if (msg.type === 'repoPickerSelected' && msg.sessionId === sessionId) {
        pendingRoot = '';
        cwdBySession = { ...cwdBySession, [sessionId]: String(msg.path ?? '') };
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'repoPickerOptions' });
    return () => window.removeEventListener('message', onMessage);
  });

  function askBranches(root: string) {
    if (root) vscode.postMessage({ type: 'repoPickerBranches', root });
  }

  function toggleRepo() {
    branchOpen = false;
    repoOpen = !repoOpen;
  }

  function toggleBranch() {
    repoOpen = false;
    branchOpen = !branchOpen;
    if (branchOpen) { query = ''; error = ''; askBranches(repo?.root ?? ''); }
  }

  function chooseRepo(option: RepoOption) {
    repoOpen = false;
    // A repo has no directory of its own to open until a worktree is picked, so the
    // repo pill's job ends at loading that repo's branches and opening the list.
    pendingRoot = option.root;
    branchRoot = '';
    branches = [];
    branchOpen = true;
    query = '';
    askBranches(option.root);
  }

  function chooseBranch(row: BranchRow) {
    branchOpen = false;
    // The pick is made, so the pills go back to describing THIS chat's real cwd:
    // a repo change opens a new chat (CHANGE_REPO_FOOTER), it never moves this one,
    // and a pill left naming the other repo would claim it had.
    pendingRoot = '';
    rememberSelection(sessionId, { root: branchRoot, path: row.path, branch: row.branch });
    vscode.postMessage({ type: 'repoPickerSelect', sessionId, root: branchRoot, branch: row.branch, path: row.path });
  }

  function newBranch() {
    const name = (query || '').trim();
    if (!name) return; // the search field doubles as the name field — nothing typed, nothing made
    branchOpen = false;
    vscode.postMessage({ type: 'repoPickerNewBranch', sessionId, root: branchRoot || (repo?.root ?? ''), name });
  }
</script>

<div class="pills">
  <span class="anchor">
  <button class="pill" data-testid="repo-pill" use:tip={'Which repo this chat works in'} onclick={toggleRepo}>
    <span class="glyph" aria-hidden="true">🗀</span>{repo?.name || 'No repo'}
  </button>
  {#if repoOpen}
    <div class="pop" data-testid="repo-pop">
      {#each repos as option (option.root)}
        <button class="row" class:current={sameDir(option.root, repo?.root)} onclick={() => chooseRepo(option)}>
          <span class="glyph" aria-hidden="true">🗀</span><span class="label">{option.name}</span>
          {#if sameDir(option.root, repo?.root)}<span class="tick" aria-hidden="true">✓</span>{/if}
        </button>
      {:else}
        <div class="empty">No repos registered</div>
      {/each}
      <div class="footer">{CHANGE_REPO_FOOTER}</div>
    </div>
  {/if}
  </span>

  <span class="anchor">
  <button class="pill branch" data-testid="branch-pill" use:tip={'Branch = worktree. Picking one opens a chat there.'} onclick={toggleBranch}>
    <span class="glyph" aria-hidden="true">⑂</span>{branch || 'No branch'}<WorktreeDot dir={cwd} />
  </button>
  {#if branchOpen}
    <div class="pop" data-testid="branch-pop">
      <label class="search">
        <span class="glyph" aria-hidden="true">⌕</span>
        <input placeholder={SEARCH_PLACEHOLDER} bind:value={query} />
      </label>
      <div class="rows">
        {#each shown as row (row.path)}
          <button class="row" class:current={sameDir(row.path, cwd)} onclick={() => chooseBranch(row)}>
            <span class="glyph" aria-hidden="true">⑂</span><span class="label">{row.branch}</span>
            {#if sameDir(row.path, cwd)}<span class="tick" aria-hidden="true">✓</span>{/if}
          </button>
        {:else}
          <div class="empty">No worktrees</div>
        {/each}
        <button class="row new" data-testid="new-branch" onclick={newBranch}>
          <span class="glyph" aria-hidden="true">＋</span><span class="label">{NEW_BRANCH_LABEL}</span>
        </button>
      </div>
      {#if error}<div class="error">{error}</div>{/if}
      <div class="footer">{CHANGE_REPO_FOOTER}</div>
    </div>
  {/if}
  </span>
</div>

<style>
  /* The pills live ON the composer's utility row now (CHANGES.md round 3,
     change 44), level with the second-opinion scales and the focus eye — not
     on a row of their own above the composer. So: no row padding of its own,
     and the pill is sized to the row (20px, 10px type, 5px radius) rather than
     to a header. At the old 12px/10px-radius size they were the tallest thing
     on the composer and the row read as two rows again. */
  .pills { display: flex; gap: 6px; padding: 0; min-width: 0; }
  /* The cap belongs on the ANCHOR, never on the pill — but as a fixed PIXEL
     measure, not a percentage (t-rnavdc): 46% of the row clipped "ArmourPaint"
     to "ArmourPa" even though the pill had plenty of room, because a percentage
     cap ignores the label's actual width and only ever asks "how much of the
     row." ~180px is wide enough for an ordinary repo/branch name and still
     ellipsises anything longer, which is what a size-to-content pill needs. */
  .anchor { position: relative; display: inline-flex; min-width: 0; max-width: 180px; }
  /* The popover keeps its own reading size — the PILL shrank, not the list. */
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    height: 20px; padding: 0 8px; border-radius: 5px;
    border: 1px solid var(--og-border); background: var(--og-surface);
    color: var(--og-text-secondary); font: inherit; font-size: 10px; line-height: 1; cursor: pointer;
    max-width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pill:hover { color: var(--og-text); background: var(--og-surface-alt); border-color: var(--og-chat); }
  .pill.branch { border-color: transparent; background: var(--og-surface-alt); }
  /* The two glyphs are the row's only colour: which REPO in the chat blue,
     which WORKTREE in the accent, so the pair reads as two questions. */
  .glyph { opacity: 0.8; font-size: 11px; line-height: 1; }
  .pill .glyph { color: var(--og-chat); }
  .pill.branch .glyph { color: var(--og-accent); }
  .pop {
    /* UPWARD. The pills sit directly above the composer, which is at the BOTTOM of
       the pane, so a downward list is clipped by the viewport — the first screenshot
       of this component cut its own footer off. */
    position: absolute; bottom: 100%; left: 0; margin-bottom: 6px;
    z-index: 30; min-width: 240px; max-width: 320px;
    border: 1px solid var(--og-border); border-radius: 10px;
    background: var(--og-surface); color: var(--og-text);
    padding: 4px; display: flex; flex-direction: column;
  }
  .search { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--og-border); }
  .search input {
    flex: 1; border: 0; background: transparent; color: var(--og-text);
    font: inherit; font-size: 12px; outline: none;
  }
  .rows { max-height: 220px; overflow-y: auto; }
  .row {
    width: 100%; display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; border: 0; border-radius: 8px; background: transparent;
    color: var(--og-text); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  }
  .row:hover { background: var(--og-surface-alt); }
  .row.current { background: var(--og-accent); color: var(--og-btn-text); }
  .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty, .footer, .error { padding: 7px 10px; font-size: 11px; color: var(--og-text-muted); }
  .footer { border-top: 1px solid var(--og-border); }
  .error { color: var(--og-error-text); }
  /* Phone width: one pill. The branch name is the longer of the two and the repo is
     the one that answers "where am I" — so the branch pill is what goes. */
  @media (max-width: 420px) {
    .anchor:last-child { display: none; }
    .pill { max-width: 100%; }
  }
</style>
