<script lang="ts">
  // Folds board: a repo pill row over the lifecycle of the one repo you picked —
  // Triage / Todo / Pending on the top row, In progress / Blocked / Done on the
  // bottom, so you see every stage of one repo at once instead of one stage of every repo.
  //
  // Six blocks, not seven columns: Merged, the stage you look at least, folds
  // into Done as a collapsed subsection. The buckets are untouched (boardBuckets
  // still sorts into seven); only the render pairs them up.
  //
  // The ticket is the entity (a markdown file in <repo>/.origami/tickets); the
  // fold is provisioned when work starts, so a launched ticket is absorbed by
  // its fold card and draws once (dedupe rule in boardBuckets.ts).
  //
  // This pane is an orchestrator: it owns the wire (amState in, messages out)
  // and the view state a broadcast must never reset (selected repo, card
  // filter, the single open editor/diff panel/launch popover). Every pixel is
  // drawn by a child component.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import AgentCard from '../components/AgentCard.svelte';
  import RaceGroup from '../components/RaceGroup.svelte';
  import RepoCards from '../components/RepoCards.svelte';
  import RepoDetail from '../components/RepoDetail.svelte';
  import RepoHeader from '../components/RepoHeader.svelte';
  import StatusColumn from '../components/StatusColumn.svelte';
  import TicketCard from '../components/TicketCard.svelte';
  import QuickAdd from '../components/QuickAdd.svelte';
  import LaunchPopover from '../components/LaunchPopover.svelte';
  import {
    COLUMNS, buildColumns, clusters, rowMatches, ticketMatches,
    type ColumnContent, type ColumnId, type RepoBoard, type Row, type TicketRow,
  } from '../components/boardBuckets';
  import type { RepoDetailInfo } from '../components/repoGroups';

  interface ModelOpt { value: string; name: string; configured?: boolean; }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other'; }

  // The blocks that get a box of their own. Merged is deliberately absent — it
  // draws inside Done, off the SAME bucket, so a card can never be in both.
  const BLOCKS = COLUMNS.filter((c) => c.id !== 'merged');

  const vscode = getVsCodeApi();
  // Which repo you were last looking at, through the SAME webview state API
  // BoardShell uses for the picked view. A separate key, so the two cannot
  // clobber each other on a shared state object.
  const STATE_KEY = 'origami.folds.view';

  let repos = $state<RepoBoard[]>([]);
  let noRepo = $state(false);
  // Board-only display-name overrides (repoOps.ts), keyed by repo.root. Rides amState.
  let displayNames = $state<Record<string, string>>({});
  // Board toggle: auto-approve permission asks from background agent sessions
  // (they have no webview to answer, so without this they hang). Rides amState.
  let autoApprove = $state(true);
  // Error banner: an accumulating list, not a single slot — a fan-out can fire
  // several launches at once, so more than one can fail. Cleared on the next launch.
  let errorMsgs = $state<string[]>([]);
  let modelOptions = $state<ModelOpt[]>([]);
  let providerStatus = $state<ProviderStat[]>([]);
  let agentTypes = $state<Array<{ id: string; name: string }>>([]); // engine-modes roster, rides amState

  // ---- view state: NEVER reset by an amState refresh ----
  let selectedRoot = $state(loadSelected());
  let cardFilters = $state<Record<string, string>>({});
  // The id of the one card in edit mode ('' = none): the pane owns which card
  // is open (single-editor invariant).
  let editingId = $state('');
  // The one repo whose board name is being edited ('' = none). Pane-owned so a
  // repo switch closes the field; the field itself stays RepoHeader's.
  let renamingRoot = $state('');
  // Id of a Save awaiting host confirmation: a confirming amState closes the
  // editor, a rejecting amError keeps it open so a refused update isn't lost.
  let savePendingId = $state('');
  // The one card whose AgentDiffPanel is open ('' = none), and a transient
  // success note shown after a clean apply-to-main.
  let expandedId = $state('');
  let applyNote = $state('');
  // The one ticket whose popover is open (null = none), and which job it's for:
  // 'launch' provisions a worktree, 'spec' opens a chat that writes the
  // ticket's acceptance. One slot, since both are modal.
  let launchTicket = $state<TicketRow | null>(null);
  let launchMode = $state<'launch' | 'spec'>('launch');
  // Where that popover hangs: the viewport rect of the card it was opened
  // from, captured once, so the popover carries no transform.
  let launchAnchor = $state({ top: 0, bottom: 0, left: 0 });
  // Quick-add is collapsed to a "+ Add ticket" ghost until asked for — an
  // always-open form ate the top of the Triage block.
  let quickAddOpen = $state(false);
  // Merged is collapsed by default and stays view-only: a poll broadcast must
  // never fold it back under you.
  let mergedOpen = $state(false);
  // What the top strip's detail pane draws, keyed by the entry root: a
  // repository's checkouts and local branches. Host truth, so it's fetched on
  // select and on the first broadcast with nothing cached. "Make primary"
  // drops the entry so the reply after it re-reads the flags.
  let details = $state<Record<string, RepoDetailInfo>>({});
  let rootEl: HTMLDivElement | undefined;

  function post(msg: Record<string, unknown>): void {
    vscode.postMessage(msg);
  }
  /** The top strip's post, so ONE rule about the cached detail lives here rather
   *  than inside a component: "Make primary" moves the primary flag and the fold
   *  prefix, so the cache is dropped and the next broadcast re-asks. */
  function cardPost(msg: Record<string, unknown>): void {
    if (msg.type === 'amMakePrimary') {
      const root = String(msg.root ?? '');
      details = Object.fromEntries(Object.entries(details).filter(([r]) => r !== root));
    }
    post(msg);
  }
  function requestAll(): void {
    post({ type: 'amRequestState' });
    post({ type: 'requestModels' });
    post({ type: 'requestProviderStatus' });
  }

  function loadSelected(): string {
    try {
      const state = (vscode.getState() as Record<string, unknown>) || {};
      const saved = state[STATE_KEY] as { selectedRepo?: unknown } | undefined;
      return typeof saved?.selectedRepo === 'string' ? saved.selectedRepo : '';
    } catch {
      return '';
    }
  }
  function saveSelected(root: string): void {
    try {
      const state = (vscode.getState() as Record<string, unknown>) || {};
      vscode.setState({ ...state, [STATE_KEY]: { selectedRepo: root } });
    } catch {
      /* getState/setState unavailable in this host — best-effort only */
    }
  }
  /** Ask the host for a repository's checkouts and branches unless they are
   *  already cached. Called on select and on the broadcast that first resolves one. */
  function wantWorktrees(root: string): void {
    if (!root || root in details) return;
    details = { ...details, [root]: { worktrees: [], branches: [] } }; // claim the slot so we ask once
    post({ type: 'amRepoWorktrees', root });
  }
  function select(root: string): void {
    if (root === selectedRoot) return;
    selectedRoot = root;
    wantWorktrees(root);
    launchTicket = null;
    renamingRoot = ''; // the field names one repo; carrying it over would rename the wrong one
    quickAddOpen = false; // Quick-add is bound to the repo it was opened in
    saveSelected(root);
  }
  // A saved repo that is no longer registered must not leave the board blank —
  // fall back to the first pill. Nothing is written while the board is empty, so
  // a board with no repos cannot overwrite a real saved pick.
  function resolveSelection(): void {
    if (repos.some((r) => r.root === selectedRoot)) return;
    const next = repos[0]?.root ?? '';
    if (next === selectedRoot) return;
    selectedRoot = next;
    if (next) saveSelected(next);
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'amState') {
        repos = Array.isArray(msg.repos) ? msg.repos : [];
        noRepo = msg.noRepo === true;
        if (typeof msg.autoApprove === 'boolean') autoApprove = msg.autoApprove;
        if (Array.isArray(msg.agentTypes)) agentTypes = msg.agentTypes;
        if (msg.displayNames && typeof msg.displayNames === 'object') displayNames = msg.displayNames;
        // Do not clear errorMsgs here: a launch failure posts amError and then
        // this broadcast; errors persist until the next launch (openLaunch()).
        resolveSelection();
        wantWorktrees(selectedRoot); // the first broadcast picks a card for you
        // Prune per-repo view state for repos that vanished (keep the rest).
        const roots = new Set(repos.map((r) => r.root));
        cardFilters = Object.fromEntries(Object.entries(cardFilters).filter(([r]) => roots.has(r)));
        details = Object.fromEntries(Object.entries(details).filter(([r]) => roots.has(r)));
        if (renamingRoot && !roots.has(renamingRoot)) renamingRoot = ''; // unregistered under the editor
        // A Save awaiting confirmation: this broadcast is the host's ack of the
        // update, so close the editor. A refused update posts amError instead,
        // leaving the editor open with the edit intact.
        if (savePendingId) {
          if (hasQueued(savePendingId)) editingId = '';
          savePendingId = '';
        }
        // Close the inline editor if its card vanished or is no longer queued.
        if (editingId && !hasQueued(editingId)) editingId = '';
        // Collapse the diff/apply panel if its card vanished; also clears the
        // transient apply note.
        if (expandedId && !repos.some((r) => r.rows.some((row) => row.id === expandedId))) expandedId = '';
        applyNote = '';
        // The open popover's ticket was launched or deleted under us — either
        // way there is nothing left to launch.
        if (launchTicket) {
          const live = ticketsOf(selectedRoot).find((t) => t.id === launchTicket!.id);
          launchTicket = live && !live.fold ? live : null;
        }
      } else if (msg.type === 'amError') {
        const m = String(msg.message ?? '');
        if (!errorMsgs.includes(m)) errorMsgs = [...errorMsgs, m]; // accumulate; never drop a concurrent failure
        savePendingId = ''; // a rejected update: stop waiting, keep the editor + its edit
      } else if (msg.type === 'amWorktrees') {
        // `branches` is ABSENT on an older host, so it reads as an empty list
        // and the detail pane simply draws no Branches section.
        const root = String(msg.root ?? '');
        if (root) {
          details = { ...details, [root]: {
            worktrees: Array.isArray(msg.worktrees) ? msg.worktrees : [],
            branches: Array.isArray(msg.branches) ? msg.branches : [],
            loaded: true,
          } };
        }
      } else if (msg.type === 'modelOptions') {
        modelOptions = Array.isArray(msg.options) ? msg.options : [];
      } else if (msg.type === 'providerStatus') {
        providerStatus = Array.isArray(msg.providers) ? msg.providers : [];
      }
    };
    window.addEventListener('message', onMsg);
    // The popover is anchored to a card's on-screen position, worked out once on
    // open, so a scroll closes it rather than leaving it over an unrelated card.
    // Capture phase: a scroll inside a block's own body doesn't bubble to the window.
    const onScroll = () => { if (launchTicket) launchTicket = null; };
    window.addEventListener('scroll', onScroll, true);
    const onVis = () => {
      const visible = document.visibilityState === 'visible';
      post({ type: 'amVisible', visible });
      if (visible) requestAll();
    };
    document.addEventListener('visibilitychange', onVis);
    post({ type: 'amVisible', visible: true });
    requestAll();
    return () => {
      window.removeEventListener('message', onMsg);
      window.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('visibilitychange', onVis);
      post({ type: 'amVisible', visible: false });
    };
  });

  const hasQueued = (id: string): boolean =>
    repos.some((r) => r.rows.some((row) => row.id === id && row.state === 'queued'));
  const ticketsOf = (root: string): TicketRow[] => repos.find((r) => r.root === root)?.tickets ?? [];

  // Board shortcuts fire only when not typing, or they'd eat the intended character.
  function focusIn(selector: string): void {
    (rootEl?.querySelector(selector) as HTMLElement | null)?.focus();
  }
  function onWinKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (launchTicket) launchTicket = null;
      else editingId = '';
      return;
    }
    if (launchTicket) return; // the popover is modal: no focus jumps behind it
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
    if (e.key === '/') { e.preventDefault(); focusIn('.am-cardfilter'); }
    // 'n' expands quick-add; the form takes focus itself on mount.
    else if (e.key === 'n') { e.preventDefault(); quickAddOpen = true; }
  }

  // ---- card callbacks (the card renders + reports; the pane owns the invariants) ----
  function onStartEdit(r: Row): void { editingId = r.id; }
  function onCancelEdit(): void { editingId = ''; savePendingId = ''; }
  function onSaveEdit(root: string, id: string, changed: Record<string, unknown>): void {
    // Send only the changed fields; wait for the host to confirm rather than
    // closing optimistically (amState closes it, amError keeps it).
    post({ type: 'amUpdateQueued', root, id, ...changed });
    savePendingId = id;
  }
  function onToggleExpand(root: string, r: Row): void {
    if (expandedId === r.id) { expandedId = ''; return; }
    expandedId = r.id;
    applyNote = '';
    post({ type: 'amDiffFiles', root, id: r.id });
  }
  function onApplied(): void { applyNote = 'Applied to main — review & commit in your own tree.'; expandedId = ''; }
  function onCloseDiff(): void { expandedId = ''; }

  function openLaunch(t: TicketRow, at: DOMRect): void {
    errorMsgs = []; // a fresh attempt dismisses stale failures
    launchMode = 'launch';
    launchAnchor = at;
    launchTicket = t;
  }
  function openSpec(t: TicketRow, at: DOMRect): void {
    errorMsgs = [];
    launchMode = 'spec';
    launchAnchor = at;
    launchTicket = t;
  }

  // A ticket dropped on the Pending block. Only a spec'd ticket not yet
  // launched may be queued, and only from the repo on screen; anything else
  // is a stray drag, a no-op.
  function dropTicket(id: string): void {
    const t = ticketsOf(selectedRoot).find((x) => x.id === id);
    if (!t || t.malformed || t.status !== 'todo' || t.fold) return;
    errorMsgs = [];
    post({ type: 'amTicketLaunch', root: selectedRoot, id, agentName: '', model: '', start: false });
  }

  let selected = $derived(repos.find((r) => r.root === selectedRoot) ?? null);
  // The detail pane heads itself with the entry the board drives, not the
  // card's lead, so the name always matches the repo the messages will reach.
  let selectedLabel = $derived(selected ? (displayNames[selected.root] ?? selected.name) : '');
  let filter = $derived(selected ? (cardFilters[selected.root] ?? '') : '');
  // A missing folder has nothing to draw; the header still offers unregister.
  let live = $derived(selected && !selected.missing ? selected : null);
  let columns = $derived(buildColumns(
    (live?.rows ?? []).filter((r) => rowMatches(r, filter)),
    (live?.tickets ?? []).filter((t) => ticketMatches(t, filter)),
  ));
</script>

<svelte:window onkeydown={onWinKey} />

{#snippet cardFor(repo: RepoBoard, r: Row, status: ColumnId)}
  <AgentCard repoRoot={repo.root} defaultModel={repo.defaultModel} row={r} status={status}
    modelOptions={modelOptions} providerStatus={providerStatus} agentTypes={agentTypes}
    editing={editingId === r.id} expanded={expandedId === r.id} post={post}
    onStartEdit={onStartEdit} onCancelEdit={onCancelEdit} onSaveEdit={onSaveEdit}
    onToggleExpand={onToggleExpand} onApplied={onApplied} onCloseDiff={onCloseDiff} />
{/snippet}

<!-- One bucket's worth of cards. Shared by a block and by the Merged subsection
     inside Done, so the two cannot drift into drawing a card differently.
     `status` is the STATUS EDGE colour (t-qn09vr, CHANGES.md change 35), not
     necessarily `content`'s own column: the Merged subsection draws under
     Done and takes Done's colour, since there is no fourth Merged block. -->
{#snippet bucketBody(repo: RepoBoard, content: ColumnContent, status: ColumnId)}
  {#each clusters(content.rows, repo.rows) as cl (cl.kind === 'group' ? `g:${cl.groupId}` : `s:${cl.row.id}`)}
    {#if cl.kind === 'group'}
      <RaceGroup base={cl.base} count={cl.rows.length} repoRoot={repo.root} groupId={cl.groupId}
        siblings={cl.siblings} post={post} />
      {#each cl.rows as r (r.id)}
        {@render cardFor(repo, r, status)}
      {/each}
    {:else}
      {@render cardFor(repo, cl.row, status)}
    {/if}
  {/each}
  <!-- Keyed by id AND position: a malformed file can carry an empty or
       duplicate id, and a duplicate key blanks the whole board. -->
  {#each content.tickets as t, i (`${t.id}::${i}`)}
    <TicketCard root={repo.root} ticket={t} status={status} onlaunch={openLaunch} onspec={openSpec} post={post} />
  {/each}
{/snippet}

<div class="am-root" bind:this={rootEl}>
  <!-- The top strip: two panes on one row. The cards carousel scrolls in the
       middle (the "Agents run in isolated git worktrees" explainer that used
       to sit left of it was redundant with the panel titles below — removed,
       t-q8zufa), and the repository you picked is drawn once on the right. -->
  <div class="am-toppanes">
    <div class="am-strip">
      <RepoCards repos={repos} displayNames={displayNames} selected={selectedRoot}
        onselect={select} post={cardPost} />
    </div>
    <RepoDetail root={selectedRoot} label={selectedLabel} missing={selected?.missing === true}
      detail={details[selectedRoot]} post={cardPost} />
  </div>
  {#each errorMsgs as m}<div class="am-error">{m}</div>{/each}
  {#if applyNote}<div class="am-note">{applyNote}</div>{/if}

  {#if noRepo}
    <p class="am-hub">No repositories on the board yet. Add the repo you want agents to work on — it does not need to be open in this window.</p>
  {/if}

  {#if selected}
    <RepoHeader repo={selected} displayNames={displayNames} modelOptions={modelOptions} providerStatus={providerStatus}
      filter={filter} onfilter={(v) => (cardFilters = { ...cardFilters, [selected!.root]: v })}
      autoApprove={autoApprove} renaming={renamingRoot === selected.root}
      onrenaming={(open) => (renamingRoot = open ? selected!.root : '')} post={post} />
  {/if}

  {#if selected && selected.missing}
    <div class="am-missing">folder missing from disk</div>
  {:else if live}
    <div class="am-board">
      {#each BLOCKS as col (col.id)}
        {@const content = columns[col.id]}
        <StatusColumn label={col.label} subtitle={col.subtitle}
          count={content.rows.length + content.tickets.length} tone={col.id}
          ondropticket={col.id === 'pending' ? dropTicket : undefined}>
          {#snippet action()}
            {#if col.id === 'pending' && content.rows.length > 0}
              <button class="am-runall" title="Start every queued agent in this repo"
                onclick={() => post({ type: 'amStartAll', root: live!.root })}>Run all ({content.rows.length})</button>
            {/if}
          {/snippet}
          {#if col.id === 'triage'}
            {#if quickAddOpen}
              <QuickAdd root={live.root} post={post} oncollapse={() => (quickAddOpen = false)} />
            {:else}
              <button class="am-qa-open" title="Capture a raw idea in Triage  ( n )"
                onclick={() => (quickAddOpen = true)}>+ Add ticket</button>
            {/if}
          {/if}
          {@render bucketBody(live, content, col.id)}
          {#if col.id === 'done'}
            {@const mg = columns.merged}
            <div class="am-merged">
              <button class="am-merged-head" aria-expanded={mergedOpen}
                title="Applied to main — retired" onclick={() => (mergedOpen = !mergedOpen)}>
                <span class="am-merged-chev" aria-hidden="true">{mergedOpen ? '▾' : '▸'}</span>
                <span class="am-merged-name">Merged</span>
                <span class="am-merged-count">{mg.rows.length + mg.tickets.length}</span>
              </button>
              {#if mergedOpen}{@render bucketBody(live, mg, 'done')}{/if}
            </div>
          {/if}
        </StatusColumn>
      {/each}
    </div>
  {/if}

  {#if launchTicket && live}
    <LaunchPopover repo={live} ticket={launchTicket} anchor={launchAnchor} agentTypes={agentTypes}
      modelOptions={modelOptions} providerStatus={providerStatus} mode={launchMode}
      post={post} onclose={() => (launchTicket = null)} />
  {/if}
</div>

<style>
  .am-root {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    height: 100%;
    min-height: 0;
    color: var(--og-text);
  }
  /* Three panes, ONE row, and only the middle one grows. The row is capped so a
     repository with many checkouts scrolls its detail pane instead of eating the
     board's height — the whole complaint the old top line earned. */
  .am-toppanes { display: flex; align-items: stretch; gap: 8px; flex: none; max-height: 190px; }
  /* `min-width: 0` is what makes the sideways scroll real: without it a flex
     item sizes to its content, so a long row of cards would push the detail
     pane off the edge instead of scrolling under it. The cards inside are a
     TWO-ROW grid that shares this pane's height, so the `max-height` above is
     also what decides how tall a card gets (RepoCards.svelte). */
  .am-strip { flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
  .am-error {
    background: rgba(192, 80, 80, 0.15);
    border: 1px solid rgba(192, 80, 80, 0.4);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    flex: none;
  }
  .am-note {
    background: rgba(90, 160, 100, 0.15);
    border: 1px solid rgba(90, 160, 100, 0.4);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    flex: none;
  }
  .am-hub { font-size: 12px; opacity: 0.7; line-height: 1.4; margin: 0; flex: none; }
  .am-missing { font-size: 12px; opacity: 0.7; padding: 8px 2px; flex: none; }
  /* 2 rows x 3 columns filling the pane. `minmax(0, 1fr)` on BOTH axes is what
     makes each block scroll its own body: the default `auto` minimum sizes a
     track to its content, so the tallest column would push the grid past the
     pane instead of overflowing inside its own box. */
  .am-board {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-rows: repeat(2, minmax(0, 1fr));
    gap: 8px;
    flex: 1;
    min-height: 0;
    padding-bottom: 4px;
  }
  /* The collapsed quick-add, on the SAME ghost idiom as the "+ Add repo" pill:
     dashed, transparent, full width of the block it opens in. */
  .am-qa-open {
    flex: none;
    padding: 4px 8px;
    background: transparent;
    color: var(--og-text);
    border: 1px dashed var(--og-border, rgba(255, 255, 255, 0.18));
    border-radius: 6px;
    font: inherit;
    font-size: 11px;
    text-align: left;
    opacity: 0.7;
    cursor: pointer;
  }
  .am-qa-open:hover { opacity: 1; border-color: var(--og-accent, #3b6ea5); }
  /* Merged inside Done: a divider you open, not a column you scroll past. */
  .am-merged { border-top: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); margin-top: 2px; padding-top: 4px; }
  .am-merged-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    color: var(--og-text);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 3px;
    font: inherit;
    font-size: 10px;
    cursor: pointer;
    opacity: 0.65;
  }
  .am-merged-head:hover { opacity: 1; border-color: var(--og-border, rgba(255, 255, 255, 0.12)); }
  .am-merged-chev { width: 9px; }
  .am-merged-name { font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .am-merged-count {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    background: var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    padding: 0 6px;
  }
  .am-runall {
    margin-left: auto;
    background: var(--og-accent, #3b6ea5);
    color: var(--og-text);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 1px 7px;
    font-size: 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .am-runall:hover { filter: brightness(1.2); }
</style>
