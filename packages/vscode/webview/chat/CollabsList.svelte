<script lang="ts">
  // Collabs M2 — the sidebar's Collabs half, EXTRACTED from SidebarLauncher.svelte.
  //
  // The extraction is not cosmetic: that file was at 938 of its 950-line
  // architecture cap, and its cap comment names this exact seam ("the Chats
  // half and the Collabs half are each an obvious seam") as the remedy instead
  // of a raise. M2 adds an archive flow, a History subsection, per-collab
  // activity rings and a roster picker — none of which fits in twelve lines.
  //
  // The half owns its own wire end to end (handshake, list, create, archive,
  // rings), so the launcher above it keeps only the Chats half and the shell.
  // The row markup and its styles came across verbatim; Svelte scopes styles
  // per component, so the rules the rows need live here now rather than being
  // inherited from a parent that no longer draws them.
  //
  // M3 (Slack model, owner's call): CREATE IS TITLE-ONLY. The roster picker
  // that used to gate Create on `pickedSlugs.length > 0` is gone from this
  // half entirely — a title alone reaches the engine with `agentSlugs: []`.
  // That removes the race this form used to lose: `pickedSlugs` started at
  // `[]` and was filled in only once the engine's agent list came back, so a
  // title typed and a Create click landing before that reply (or after one
  // that failed and silently wiped an already-good list, see
  // collab_data's CollabAgentsPayload.error) hit a DISABLED button — and a
  // disabled button fires no click, so `commitNewCollab`'s own refusal
  // message never ran either. No collab, no error, nothing on screen said
  // why. Agents now join AFTER the room exists, invited from the collab's
  // own pane (CollabRoster's + button), never from here.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { onMount } from 'svelte';
  import CollabCreateForm from './CollabCreateForm.svelte';
  import HistoryDropdown from './HistoryDropdown.svelte';

  const vscode = getVsCodeApi();

  /** 'idle' = nothing seen for this collab yet (NO ring — an untouched collab
   *  must not claim to be waiting on you); 'working' = at least one agent is
   *  queued or running; 'ready' = everyone went idle after we saw activity. */
  type RowState = 'idle' | 'working' | 'ready';
  interface CollabRow { id: string; title: string; archivedAt?: string }

  let collabs = $state<CollabRow[]>([]);
  let collabError = $state('');
  let ringState = $state<Record<string, RowState>>({});

  // The inline draft (CollabCreateForm.svelte) — open/closed is all this half
  // still owns; the fields and their keys live in the form.
  let newCollabOpen = $state(false);
  let historyOpen = $state(false);
  /** The collab an archive confirm is pending for. A modal, not a bare click:
   *  archiving ends a room several agents are in, and it is the one control on
   *  this half that changes something the user cannot undo from here. */
  let confirming = $state<CollabRow | null>(null);

  const live = $derived(collabs.filter((c) => !c.archivedAt));
  const archived = $derived(collabs.filter((c) => !!c.archivedAt));

  // The History panel is the chats half's HistoryDropdown, fed from the list
  // this half ALREADY holds: `collabList` carries the archived rooms with the
  // live ones, so there is no round trip to make and `loading` is never true.
  // The filter is on the TITLE alone — a collab has no folder to match on.
  let historyQuery = $state('');
  const archivedRows = $derived(
    archived
      .filter((c) => c.title.toLowerCase().includes(historyQuery.trim().toLowerCase()))
      .map((c) => ({ id: c.id, title: c.title, meta: 'archived', tooltip: 'Open this archived collab (read-only)' })),
  );

  // Drag-to-reorder — same native HTML5 DnD as SidebarLauncher.svelte:121-134;
  // see its comment there for the full rationale. Indices are into `live`.
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);
  function startDrag(e: DragEvent, i: number) {
    dragIndex = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', live[i]?.id ?? '');
    }
  }
  function dragOverRow(e: DragEvent, i: number) {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    overIndex = i;
  }
  function dropOnRow(e: DragEvent, i: number) {
    if (dragIndex === null) return;
    e.preventDefault();
    const from = dragIndex;
    endDrag();
    if (from === i) return;
    const nextLive = [...live];
    const [moved] = nextLive.splice(from, 1);
    nextLive.splice(i, 0, moved);
    collabs = [...nextLive, ...archived];
    vscode.postMessage({ type: 'reorderCollabs', order: nextLive.map((c) => c.id) });
  }
  function endDrag() { dragIndex = null; overIndex = null; }

  /** Flock M4: `objective` rides the create ONLY when it was typed. An empty
   *  objective and no objective are the same absence, and sending `''` would
   *  make the engine store one. */
  function commitNewCollab(title: string, objective: string) {
    newCollabOpen = false;
    vscode.postMessage({ type: 'newCollab', title, agentSlugs: [], ...(objective ? { objective } : {}) });
  }
  function openCollab(c: CollabRow) {
    vscode.postMessage({ type: 'openCollab', collabId: c.id, title: c.title });
  }
  /** The History panel picks by id — an archived room opens through the SAME
   *  path a live row does, so "readable, nothing more can be posted" stays the
   *  pane's own statement rather than a second rule here. */
  function openCollabById(id: string) {
    const c = collabs.find((x) => x.id === id);
    if (c) openCollab(c);
  }
  function confirmArchive() {
    const c = confirming;
    confirming = null;
    if (c) vscode.postMessage({ type: 'collabArchive', collabId: c.id });
  }
  /** Re-ask for the collab list. Used both as the mount handshake and as the
   *  one retry, when a session finally exists to answer it. */
  function retryCollabHandshake() {
    vscode.postMessage({ type: 'requestCollabs' });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      switch (msg.type) {
        case 'sessionCreated':
          // The handshake can land BEFORE the engine has a session, and
          // `collab_list` then answers "open a chat first". A session appearing
          // is exactly the event that makes the question answerable, so retry
          // it then — and only then, so an ordinary new chat costs nothing.
          if (collabError) retryCollabHandshake();
          break;
        case 'collabList': {
          collabs = (Array.isArray(msg.collabs) ? msg.collabs : [])
            .map((c: { id?: unknown; title?: unknown; archivedAt?: unknown }) => ({
              id: String(c.id ?? ''),
              title: typeof c.title === 'string' && c.title ? c.title : String(c.id ?? ''),
              archivedAt: typeof c.archivedAt === 'string' ? c.archivedAt : undefined,
            }))
            .filter((c: CollabRow) => c.id);
          collabError = typeof msg.error === 'string' ? msg.error : '';
          break;
        }
        case 'collabCreated':
          // Only a REFUSAL needs saying — a success arrives as the collabList
          // broadcast the host sends straight after it.
          if (typeof msg.error === 'string' && msg.error) collabError = msg.error;
          break;
        case 'collabOpResult':
          if (typeof msg.error === 'string' && msg.error) collabError = msg.error;
          else vscode.postMessage({ type: 'requestCollabs' });
          break;
        case 'collabStateData': {
          // The RING's only input. A collab pane polls while it is open and the
          // host fans every reply out to every view, so this half gets the same
          // payloads for free — no second timer, and nothing to leak.
          //
          // THE HONEST LIMIT, stated because the UI cannot: a ring only lives
          // while some pane for that collab is polling. A collab whose tab is
          // shut shows no ring at all, which is why 'idle' draws nothing rather
          // than drawing "finished".
          const id = typeof msg.collabId === 'string' ? msg.collabId : '';
          if (!id || !Array.isArray(msg.agents)) break;
          const busy = (msg.agents as Array<{ state?: unknown }>).some(
            (a) => a.state === 'running' || a.state === 'queued',
          );
          const prior = ringState[id] ?? 'idle';
          const next: RowState = busy ? 'working' : prior === 'working' ? 'ready' : prior;
          if (next !== prior) ringState = { ...ringState, [id]: next };
          break;
        }
      }
    };
    window.addEventListener('message', onMsg);
    retryCollabHandshake();
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<div class="chats-toolbar">
  <button class="chat-action primary" onclick={() => (newCollabOpen = true)} title="Start a new collab (opens its own editor tab)">＋ New collab</button>
  {#if archived.length > 0}
    <button
      class="chat-action"
      class:active={historyOpen}
      onclick={() => { historyOpen = !historyOpen; historyQuery = ''; }}
      title="Archived collabs — still readable, nothing more can be posted to them"
    >⟲ History ({archived.length})</button>
  {/if}
</div>

{#if newCollabOpen}
  <!-- TITLE (+ an optional objective), inline. Still no roster to pick here
       (M3): the room opens empty and agents join from its own pane afterward. -->
  <CollabCreateForm onCreate={commitNewCollab} onCancel={() => (newCollabOpen = false)} />
{/if}

{#if collabError}
  <div class="collab-error">{collabError}</div>
{/if}

<div class="collab-list" role="list">
  {#if live.length === 0}
    <div class="collabs-empty">
      {collabs.length === 0 ? 'No collabs yet. Hit ＋ New collab.' : 'No open collabs — the rest are in History.'}
    </div>
  {:else}
    {#each live as c, i (c.id)}
      <div
        class="session-row collab-row"
        role="listitem"
        title={ringState[c.id] === 'working' ? 'Working…' : ringState[c.id] === 'ready' ? 'Your turn' : undefined}
        class:dragging={dragIndex === i}
        class:drop-above={overIndex === i && dragIndex !== null && dragIndex > i}
        class:drop-below={overIndex === i && dragIndex !== null && dragIndex < i}
        draggable="true"
        ondragstart={(e) => startDrag(e, i)}
        ondragover={(e) => dragOverRow(e, i)}
        ondrop={(e) => dropOnRow(e, i)}
        ondragend={endDrag}
      >
        <span class="collab-ring" data-state={ringState[c.id] ?? 'idle'} aria-hidden="true"></span>
        <button class="session-open" onclick={() => openCollab(c)} title="Open this collab in its editor tab">
          <span class="session-name">{c.title}</span>
        </button>
        <button class="session-close" onclick={() => (confirming = c)} title="Archive this collab" aria-label={`Archive ${c.title}`}>&times;</button>
      </div>
    {/each}
  {/if}
</div>

{#if historyOpen && archived.length > 0}
  <!-- Archived collabs stay READABLE: the row still opens its tab, and the
       pane itself renders the archived tag and disables its composer. The
       panel is the chats half's, searchable and fed from the resident list. -->
  <HistoryDropdown
    items={archivedRows}
    loading={false}
    query={historyQuery}
    onQuery={(v) => (historyQuery = v)}
    onPick={openCollabById}
    onClose={() => (historyOpen = false)}
    emptyText="No matches."
  />
{/if}

{#if confirming}
  <div class="collab-confirm" role="dialog" aria-label="Archive this collab?">
    <div class="collab-confirm-text">Archive “{confirming.title}”? It moves to History and nothing more can be posted to it.</div>
    <div class="collab-new-actions">
      <button class="chat-action primary" onclick={confirmArchive}>Archive</button>
      <button class="chat-action" onclick={() => (confirming = null)}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  /* --- carried across from SidebarLauncher.svelte with the markup --- */
  .chats-toolbar {
    display: flex;
    gap: 6px;
    padding: 2px 10px 6px;
  }
  .chat-action {
    font-size: 11px;
    padding: 4px 8px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .chat-action:hover { border-color: var(--og-chat); color: var(--og-text); }
  .chat-action.primary { color: var(--og-text); border-color: var(--og-chat); }
  .chat-action.active { background: color-mix(in srgb, var(--og-accent) 14%, transparent); color: var(--og-text); }
  .chat-action:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); }

  /* The archived list is HistoryDropdown.svelte now — its rows, its tag line
     and its styles all live there, so nothing here draws an archived room. */
  .collab-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px 6px;
  }
  .collabs-empty {
    padding: 4px 12px 6px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
  }
  /* .collab-new / .session-rename moved to CollabCreateForm.svelte with the
     draft's markup; .collab-new-actions stays — the archive confirm uses it. */
  .collab-new-actions { display: flex; gap: 6px; padding: 6px 0 0; }
  .collab-error {
    margin: 0 10px 6px;
    padding: 5px 8px;
    font-size: 10px;
    border-radius: 5px;
    color: var(--og-error-text);
    background: var(--og-error-soft);
  }
  .session-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 5px;
  }
  .session-row:hover { background: var(--og-btn-bg); }
  .session-row[draggable='true'] { cursor: grab; }
  .session-row.dragging { opacity: 0.4; }
  .session-row.drop-above { box-shadow: inset 0 2px 0 0 var(--og-accent); }
  .session-row.drop-below { box-shadow: inset 0 -2px 0 0 var(--og-accent); }
  .session-open {
    flex: 1 1 auto;
    display: flex;
    align-items: baseline;
    gap: 7px;
    text-align: left;
    padding: 6px 8px;
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: inherit;
    overflow: hidden;
  }
  .session-name {
    font-size: 12px;
    color: var(--og-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-close {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 13px;
    padding: 0 6px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    opacity: 0;
  }
  .session-row:hover .session-close { opacity: 0.7; }
  .session-close:hover { opacity: 1; background: var(--og-error); color: var(--og-bg); }

  /* The per-collab activity ring — the SAME pill-sweep the chat rows and the
     collab pane's roster chips use, so "this one is working" reads identically
     on all three surfaces. Its own property name (--cl-, not --sl-) because the
     two components register these independently and a shared name would make
     one file's animation silently depend on the other being loaded. */
  @property --cl-ring-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  .collab-ring {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    padding: 2px;
    pointer-events: none;
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
  }
  .collab-ring[data-state='ready'] { background: var(--og-success); }
  .collab-ring[data-state='working'] {
    background: conic-gradient(from var(--cl-ring-angle), var(--og-warning) 0deg 90deg, var(--og-border) 90deg 360deg);
    animation: cl-ring-spin 0.9s linear infinite;
  }
  @keyframes cl-ring-spin { to { --cl-ring-angle: 360deg; } }
  @media (prefers-reduced-motion: reduce) {
    .collab-ring[data-state='working'] { animation: none; }
  }

  .collab-confirm {
    margin: 0 10px 6px;
    padding: 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-surface);
  }
  .collab-confirm-text { font-size: 11px; color: var(--og-text); line-height: 1.45; }
</style>
