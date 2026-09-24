<script lang="ts">
  // ARTIFACTS — the pane the dock's Artifacts pill opens (design note section
  // 6). An artifact is a small bundle an agent made for you to look at: a page,
  // a report, a lane's output. Each machine keeps its own copy, and a copy has
  // a version number.
  //
  // The ENGINE SIDE DOES NOT EXIST YET (t-rz4555 is deliberately first). Every
  // read can therefore answer "method not found", which arrives as an error
  // string beside an empty list — so the EMPTY STATE is this pane's normal
  // first screen, not its failure screen, and nothing here may throw on it.
  //
  // Rules (device naming, search, sync line, conflict sentence) live in
  // artifactRows.ts; this file holds state and markup only.
  //
  // Round 3 (t-s9kc6o) adds four row actions — Open, Open chat about, Rename,
  // Delete — plus Show in Explorer on each version. RENAME edits `rows`
  // optimistically the moment Enter commits it (like the title it is, not a
  // publish). DELETE reuses pendingClose.ts's fuse UNCHANGED: the row leaves
  // `rows` at once, a 4s Undo toast runs, and the host hears `artifactDelete`
  // only once the fuse burns — the exact shape ChatsList.svelte's × already
  // proved (t-ru13hb item 2).
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { tip } from '../../shared/warmTip';
  import ArtifactVersions from '../components/ArtifactVersions.svelte';
  import ArtifactConflictBanner from '../components/ArtifactConflictBanner.svelte';
  import ArtifactsHelp from '../components/ArtifactsHelp.svelte';
  import InlineToast from '../components/InlineToast.svelte';
  import DeskChip from '../../chat/DeskChip.svelte';
  import { closeToastText, createCloseFuse, type PendingClose } from '../../chat/pendingClose';
  import {
    artifactRows, filterArtifacts, deviceLabel, lastChange, motherBaseOf, originLine, syncLine, versionRows,
    type ArtifactRow, type MotherBase, type VersionRow,
  } from './artifactRows';

  const vscode = getVsCodeApi();

  let rows = $state<ArtifactRow[]>([]);
  // t-v47qh6: false until the first artifactsData — "not answered yet" is not "empty".
  let loaded = $state(false);
  let homeDevice = $state('');
  let motherBase = $state<MotherBase | undefined>(undefined); // t-vbj8xu: the roster's mark, Nests on only
  let error = $state('');
  let query = $state('');
  let selected = $state('');
  let versions = $state<VersionRow[]>([]);
  let versionsError = $state('');
  let diff = $state<{ from: number; to: number; added: string[]; removed: string[]; changed: string[]; error?: string } | undefined>(undefined);
  let opened = $state('');
  let renamingId = $state('');
  let renameDraft = $state('');

  let pendingDelete = $state<PendingClose | null>(null);
  const deleteFuse = createCloseFuse({
    post: (id) => {
      post({ type: 'artifactDelete', artifactId: id });
      rows = rows.filter((r) => r.id !== id);
      if (selected === id) selected = '';
    },
    onChange: (p) => (pendingDelete = p),
  });

  // The filter hides whatever is still UNDOABLE; the actual removal from
  // `rows` happens only when the fuse commits (pendingClose.ts's `post`),
  // exactly the split ChatsList.svelte's own close toast uses — without it
  // the row would flash back for as long as the host took to answer.
  let shown = $derived(filterArtifacts(rows, query).filter((r) => r.id !== pendingDelete?.id));
  let current = $derived(rows.find((r) => r.id === selected));

  /** The only way out of this pane. `rows` is `$state`, so anything read off
   *  it is a Svelte proxy, and postMessage structured-clones its payload —
   *  an un-snapshotted payload is simply never sent. */
  function post(msg: Record<string, unknown>): void {
    vscode.postMessage($state.snapshot(msg));
  }

  function load(): void {
    post({ type: 'artifactsRequest' });
  }

  function select(id: string): void {
    selected = id;
    versions = [];
    versionsError = '';
    diff = undefined;
    post({ type: 'artifactVersionsRequest', artifactId: id });
  }

  function open(version?: number): void {
    if (!selected) return;
    post({ type: 'artifactOpen', artifactId: selected, ...(version === undefined ? {} : { version }) });
  }

  function restore(version: number): void {
    if (!selected) return;
    post({ type: 'artifactRestore', artifactId: selected, version });
  }

  function compare(version: number): void {
    if (!current) return;
    post({ type: 'artifactDiff', artifactId: current.id, from: version, to: current.latest });
  }

  function reveal(version: number): void {
    if (!selected) return;
    post({ type: 'artifactReveal', artifactId: selected, version });
  }

  function openChatAbout(row: ArtifactRow): void {
    post({ type: 'artifactOpenChatAbout', artifactId: row.id, title: row.title, version: row.latest });
  }

  function startRename(row: ArtifactRow): void {
    renamingId = row.id;
    renameDraft = row.title;
  }

  function cancelRename(): void {
    renamingId = '';
  }

  /** Edits `rows` at once — a rename is a title, not a publish, so there is no
   *  reason to wait on the engine's echo before the pane shows it. */
  function commitRename(row: ArtifactRow): void {
    const title = renameDraft.trim();
    renamingId = '';
    if (!title || title === row.title) return;
    rows = rows.map((r) => (r.id === row.id ? { ...r, title } : r));
    post({ type: 'artifactRename', artifactId: row.id, title });
  }

  function renameKeydown(e: KeyboardEvent, row: ArtifactRow): void {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(row); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }

  function deleteRow(row: ArtifactRow): void {
    deleteFuse.close({ id: row.id, label: row.title });
  }

  /** The rename input has no menu item beside it to click — autofocus is the
   *  only way in, the same as ChatsList.svelte's rename box. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }

  const strings = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : []).filter((f): f is string => typeof f === 'string');

  window.addEventListener('message', (event: MessageEvent) => {
    const msg = (event.data || {}) as Record<string, unknown>;
    switch (msg['type']) {
      case 'artifactsData': {
        rows = artifactRows(msg['artifacts']);
        loaded = true;
        homeDevice = typeof msg['homeDevice'] === 'string' ? (msg['homeDevice'] as string) : '';
        motherBase = motherBaseOf(msg['motherBase']);
        error = typeof msg['error'] === 'string' ? (msg['error'] as string) : '';
        // The list is on screen, so the arrivals in it have been seen: the
        // pill's badge clears here rather than on a click nobody made.
        post({ type: 'artifactsOpened', ids: rows.filter((r) => r.unopened).map((r) => r.id).join(',') });
        return;
      }
      case 'origami/nestArtifacts': {
        // t-sj39jx: another desk's artifact index moved; re-read the merged list.
        load();
        return;
      }
      case 'artifactVersions': {
        if (msg['artifactId'] !== selected) return;
        versions = versionRows(msg['versions']);
        versionsError = typeof msg['error'] === 'string' ? (msg['error'] as string) : '';
        return;
      }
      case 'artifactDiffData': {
        if (msg['artifactId'] !== selected) return;
        diff = {
          from: Number(msg['from'] ?? 0), to: Number(msg['to'] ?? 0),
          added: strings(msg['added']), changed: strings(msg['changed']), removed: strings(msg['removed']),
          ...(typeof msg['error'] === 'string' ? { error: msg['error'] as string } : {}),
        };
        return;
      }
      case 'artifactOpened': {
        opened = typeof msg['error'] === 'string' ? (msg['error'] as string) : '';
        return;
      }
      case 'artifactRestored': {
        opened = typeof msg['error'] === 'string' ? (msg['error'] as string) : '';
        if (selected) post({ type: 'artifactVersionsRequest', artifactId: selected });
        return;
      }
      case 'artifactRenamed':
      case 'artifactDeleted':
      case 'artifactChatOpened':
      case 'artifactRevealed': {
        // A refusal on any of the four new actions surfaces exactly where an
        // Open/Restore refusal already does — one alert line, no dead click.
        opened = typeof msg['error'] === 'string' ? (msg['error'] as string) : '';
        return;
      }
    }
  });

  load();
</script>

<div class="af-pane">
  <div class="af-head">
    <h1 class="af-title">Artifacts</h1>
    <ArtifactsHelp />
    <input class="af-search" type="search" placeholder="Search by title" bind:value={query} aria-label="Search artifacts by title" />
    <button class="af-btn" type="button" onclick={load}>Refresh</button>
  </div>

  {#if opened}
    <p class="af-error" role="alert">{opened}</p>
  {/if}

  {#if !loaded}
    <p class="af-note" role="status">Loading artifacts…</p>
  {:else if rows.length === 0}
    <div class="af-empty">
      <p class="af-empty-head">No artifacts yet</p>
      <p class="af-empty-body">
        An artifact is a small bundle an agent made for you to look at: a page, a report or a lane's output.
        Each desk keeps its own artifacts, with a version number. With Nests on, the list reaches your other desks.
        The files come over when you open one.
      </p>
      {#if error}<p class="af-note">{error}</p>{/if}
    </div>
  {:else}
    <ul class="af-list">
      {#each shown as row (row.id)}
        <li class="af-row" class:is-on={row.id === selected} data-artifact-id={row.id}>
          {#if renamingId === row.id}
            <input class="af-rename-input" bind:value={renameDraft} use:focusOnMount
              onkeydown={(e) => renameKeydown(e, row)} onblur={() => commitRename(row)}
              aria-label={`Rename ${row.title}`} />
          {:else}
            <button class="af-rowbtn" type="button" onclick={() => select(row.id)}>
              <span class="af-rowtitle">{row.title}</span>
              <span class="af-rowver">v{row.latest}</span>
              {#if row.desk}<DeskChip desk={row.desk} name={row.desk.name} />{/if}
              <span class="af-rowmeta">{deviceLabel(row.ownerDevice, homeDevice, motherBase)}</span>
              <span class="af-rowmeta">{lastChange(row.updated)}</span>
              <span class="af-rowmeta">{originLine(row)}</span>
              {#if row.here === false}<span class="af-away" use:tip={'The files are not on this machine yet'}>not here</span>{/if}
            </button>
            <div class="af-actions">
              <button class="af-btn" type="button" onclick={() => { selected = row.id; open(); }}>Open</button>
              <button class="af-btn" type="button" onclick={() => openChatAbout(row)}>Open chat about</button>
              <button class="af-btn" type="button" onclick={() => startRename(row)}>Rename</button>
              <button class="af-btn af-btn-danger" type="button" onclick={() => deleteRow(row)}>Delete</button>
            </div>
          {/if}
          <p class="af-sync">{syncLine(row, homeDevice, motherBase)}</p>
          <ArtifactConflictBanner
            {row}
            {homeDevice}
            {motherBase}
            onOpenTheirs={(v) => { selected = row.id; open(v); }}
            onKeepMine={(v) => { selected = row.id; restore(v); }}
          />
          {#if row.id === selected}
            <ArtifactVersions
              artifactId={row.id}
              {versions}
              latest={row.latest}
              {homeDevice}
              {motherBase}
              error={versionsError}
              {diff}
              onOpen={open}
              onRestore={restore}
              onCompare={compare}
              onReveal={reveal}
            />
          {/if}
        </li>
      {/each}
    </ul>
    {#if shown.length === 0}
      <p class="af-note">No artifact matches that title.</p>
    {/if}
  {/if}
</div>

<!-- The Undo, for as long as the delete's fuse burns — same fixed-footer shape
     as ChatsList.svelte's chat-close toast, the row it belongs to has just
     left the list. -->
{#if pendingDelete}
  <div class="af-delete-toast">
    <InlineToast text={closeToastText(pendingDelete.label)} actionLabel="Undo"
      onAction={deleteFuse.undo} onDismiss={deleteFuse.commit} />
  </div>
{/if}

<style>
  .af-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    color: var(--og-text);
    background: var(--og-bg);
    height: 100%;
    overflow: auto;
  }
  .af-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .af-title {
    margin: 0;
    font-size: 18px;
  }
  .af-search {
    margin-left: auto;
    padding: 4px 8px;
    border: 1px solid var(--og-input-border);
    border-radius: 6px;
    background: var(--og-input-bg);
    color: var(--og-text);
    font-size: 12px;
  }
  .af-empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    background: var(--og-surface);
  }
  .af-empty-head {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .af-empty-body {
    margin: 0;
    font-size: 12px;
    color: var(--og-text-secondary);
    max-width: 62ch;
  }
  .af-note {
    margin: 0;
    font-size: 12px;
    color: var(--og-text-muted);
  }
  .af-error {
    margin: 0;
    font-size: 12px;
    color: var(--og-error-text);
  }
  .af-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .af-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    background: var(--og-surface);
  }
  .af-row.is-on {
    border-color: var(--og-accent);
  }
  .af-rowbtn {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--og-text);
    text-align: left;
    cursor: pointer;
  }
  .af-rowtitle {
    font-size: 13px;
    font-weight: 600;
  }
  .af-rowver,
  .af-rowmeta,
  .af-sync {
    font-size: 12px;
    color: var(--og-text-muted);
  }
  .af-sync {
    margin: 0;
  }
  .af-away {
    margin-left: auto;
    padding: 1px 6px;
    border: 1px solid var(--og-border);
    border-radius: 999px;
    font-size: 11px;
    color: var(--og-text-secondary);
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
  .af-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .af-btn-danger {
    color: var(--og-error-text);
  }
  .af-rename-input {
    padding: 4px 8px;
    border: 1px solid var(--og-input-border);
    border-radius: 6px;
    background: var(--og-input-bg);
    color: var(--og-text);
    font-size: 13px;
    font-weight: 600;
  }
  .af-delete-toast {
    position: fixed;
    left: 8px;
    bottom: 10px;
    z-index: 60;
  }
</style>
