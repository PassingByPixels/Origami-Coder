<script lang="ts">
  // The sidebar's Chats half, EXTRACTED from SidebarLauncher.svelte — the
  // seam that file's own cap comment named ("the Chats half and the Collabs
  // half are each an obvious seam"), the same move CollabsList.svelte made
  // for the other half at M2. Owns the session list end to end (handshake,
  // ring lifecycle, drag reorder, rename, history) PLUS t-kgserq's chat-
  // grouping sections — none of which fit in the launcher's remaining
  // headroom without this file existing.
  //
  // t-r43glr (2026-08-14): the owner wants NO built-in section besides
  // "Main" — sections exist only when the user makes one. This retires
  // t-kgserq v2's fixed "Loops" row (pinned bottom) and the pre-v2 "spare"
  // single custom section; a chat that was filed under either now simply
  // reads back as Main (see src/dashboard/chatSections.ts's migration
  // comment). What remains: "Main" PINNED top (undeletable, unrenamable,
  // carries the + create-section control; it is simply the old "ungrouped"
  // list, now with its own header) and any number of user sections BELOW it
  // (add/rename/delete — deleting moves its chats back to Main). Sections
  // are a DISPLAY FILTER over the one global order array (dropping onto a
  // ROW still just reorders that array, unchanged from before); dropping
  // onto a SECTION HEADER sets that chat's membership (or clears it, for
  // Main). Membership/collapsed/section defs persist via the extension's
  // chatSections.ts (workspaceState) and ride their own small messages,
  // independent of the reorder wire.
  //
  // The per-section HEADER markup (chevron, count, delete) is
  // ChatSectionBlock.svelte, generic over Main vs. a custom section so two
  // near-identical header blocks did not have to exist here. What stays
  // here: every ROW's own markup (drag/open/rename/close — identical
  // wherever a chat sits) and each section's NAME area (plain text for Main,
  // name+pencil+dblclick-rename for a custom one) — passed to
  // ChatSectionBlock as snippets, because Svelte scopes a snippet's CSS to
  // the file that WRITES its markup, not the one that renders it.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { onMount } from 'svelte';
  import HistoryDropdown from './HistoryDropdown.svelte';
  import ChatSectionBlock from './ChatSectionBlock.svelte';
  import {
    groupSessionIds,
    defaultChatSectionsState,
    type ChatSectionDef,
    type ChatSectionsState,
  } from './chatSections';
  import { deriveRowVisualState, addPendingAsk, removePendingAsk } from './sessionRowState';

  const vscode = getVsCodeApi();

  // `state` drives the per-row activity ring. 'idle' = this launcher has seen no
  // activity for the chat yet (no ring at all — an untouched chat must not claim
  // to be waiting on you); 'working' = a turn is in flight; 'ready' = the turn
  // came back and the chat is yours again. `pendingAsks` (open tool-permission/
  // question toolCallIds) is the ring's THIRD input, folded in at render time by
  // sessionRowState.ts's deriveRowVisualState rather than living inside RowState.
  type RowState = 'idle' | 'working' | 'ready';
  interface SessionRow { id: string; number: number; agentName: string; title?: string; state: RowState; pendingAsks: ReadonlySet<string> }
  let sessions = $state<SessionRow[]>([]);

  // The host has no per-chat "is it busy" broadcast to subscribe to, so the ring
  // reads the turn-lifecycle events it ALREADY fans out to every attached view:
  //   echoUser — the host echoing the prompt it just accepted. This is the only
  //     start-of-turn signal that covers an ordinary chat: `busy` is posted by
  //     the /loop scheduled-run path alone (one producer), because a normal send
  //     originates IN ChatPane, which flips its own composer locally and never
  //     needs to be told. The sidebar is not the sender, so it needs the echo.
  //     EXCEPT when it carries `replay: true` — that tags the ONE echoUser a
  //     loadSession history recall produces (DashboardPanel's onUserMessageChunk,
  //     fed only by ACP replay), one per historical user turn with no turnDone
  //     ever following. A restored chat is not a turn in flight, so a
  //     replay-tagged echoUser must NOT flip the ring.
  //   busy — the /loop path's start-of-run signal, for the runs nobody typed.
  //   turnDone — every terminal path (reply, error, blocked, idle, loop_run).
  //   firstfoldDone — /firstfold's own terminal signal (it never posts a plain
  //     turnDone; its start (firstfoldStart) is always preceded by its own
  //     echoUser on the same session, so only the terminal side needs a case).
  //   requestPermission / permissionAudit — the THIRD ring state's inputs (see
  //     sessionRowState.ts and the two case blocks below for the wire-shape
  //     gotchas: no sessionId on the resolution, and the 'requested' variant
  //     that is not one).
  function markSession(id: unknown, next: RowState) {
    const sid = typeof id === 'string' ? id : '';
    if (!sid) return;
    // 'ready' also clears pendingAsks — the Cancel/Stop backstop: a Cancel
    // answers every queued ask host-side without necessarily emitting its own
    // permissionAudit per ask, but its in-flight prompt() call still settles
    // into a 'ready' turnDone, which must not leave a stale waiting ring.
    const clearsAsks = next === 'ready' ? { pendingAsks: new Set<string>() } : {};
    sessions = sessions.map(s => s.id === sid ? { ...s, state: next, ...clearsAsks } : s);
  }

  // --- t-kgserq: chat-list sections ---------------------------------------
  let chatSections = $state<ChatSectionsState>(defaultChatSectionsState());
  const knownSectionIds = $derived(new Set(chatSections.sections.map((sec) => sec.id)));
  const grouped = $derived(groupSessionIds(sessions.map(s => s.id), chatSections.membership, knownSectionIds));
  const indexById = $derived(new Map(sessions.map((s, i) => [s.id, i] as const)));
  // Two different empty-Main lines, same distinction the old plain list drew:
  // no chats at all vs. every chat already claimed by a section below it.
  // (Main is pinned TOP; custom sections render below it — see the layout
  // note at the top of this file.)
  const mainEmptyText = $derived(sessions.length === 0 ? 'No open chats. Hit ＋ New chat.' : 'Every open chat is in a section below.');

  function withLocalSection(membership: Record<string, string>, id: string, section: string | null): Record<string, string> {
    const next = { ...membership };
    if (section) next[id] = section; else delete next[id];
    return next;
  }
  function toggleSection(id: string) {
    if (id === 'main') chatSections = { ...chatSections, mainCollapsed: !chatSections.mainCollapsed };
    else chatSections = { ...chatSections, sections: chatSections.sections.map(s => s.id === id ? { ...s, collapsed: !s.collapsed } : s) };
    vscode.postMessage({ type: 'toggleChatSectionCollapse', section: id });
  }
  function dragOverSection(e: DragEvent) {
    if (dragIndex === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }
  /** `section` null = Main (clear membership). */
  function dropOnSection(e: DragEvent, section: string | null) {
    if (dragIndex === null) return;
    e.preventDefault();
    const id = sessions[dragIndex]?.id;
    endDrag();
    if (!id || (chatSections.membership[id] ?? null) === section) return;
    chatSections = { ...chatSections, membership: withLocalSection(chatSections.membership, id, section) };
    vscode.postMessage({ type: 'setChatSection', sessionId: id, section });
  }
  function removeFromSection(id: string) {
    chatSections = { ...chatSections, membership: withLocalSection(chatSections.membership, id, null) };
    vscode.postMessage({ type: 'setChatSection', sessionId: id, section: null });
  }

  // Section CRUD (t-kgserq v2). Create/delete are NOT optimistic — the id is
  // host-generated (chatSections.ts's generateSectionId), so there is
  // nothing correct to render until the `chatSections` echo names it. Same
  // pattern newChat() below already uses for a host-assigned session id.
  function createSection() { vscode.postMessage({ type: 'createChatSection' }); }
  function deleteSection(id: string) {
    chatSections = {
      ...chatSections,
      sections: chatSections.sections.filter(s => s.id !== id),
      membership: Object.fromEntries(Object.entries(chatSections.membership).filter(([, sec]) => sec !== id)),
    };
    vscode.postMessage({ type: 'deleteChatSection', id });
  }

  let editingSectionId = $state<string | null>(null);
  let sectionNameDraft = $state('');
  function startRenameSection(sec: ChatSectionDef) { editingSectionId = sec.id; sectionNameDraft = sec.name; }
  function commitRenameSection() {
    const id = editingSectionId;
    const name = sectionNameDraft.trim();
    editingSectionId = null;
    if (!id) return;
    const current = chatSections.sections.find(s => s.id === id);
    if (name && current && name !== current.name) {
      chatSections = { ...chatSections, sections: chatSections.sections.map(s => s.id === id ? { ...s, name } : s) };
      vscode.postMessage({ type: 'renameChatSection', id, name });
    }
  }
  function renameSectionKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitRenameSection(); }
    else if (e.key === 'Escape') { e.preventDefault(); editingSectionId = null; }
  }

  // Theme picker, ControlStrip and the brand header stay in SidebarLauncher —
  // this half owns only what is below.

  // In-webview history dropdown (same wire as ChatPane: requestHistory →
  // historyList; recallSession opens the recalled chat in a fresh tab).
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let historyQuery = $state('');
  interface HistoryItem { sessionId: string; title: string; folder: string; updatedAt: string }
  let historyItems = $state<HistoryItem[]>([]);
  let historyFiltered = $derived.by(() => {
    const q = historyQuery.trim().toLowerCase();
    if (!q) return historyItems;
    return historyItems.filter(h => `${h.title} ${h.folder}`.toLowerCase().includes(q));
  });
  function openHistoryDropdown() {
    historyOpen = true;
    historyLoading = true;
    historyItems = [];
    historyQuery = '';
    vscode.postMessage({ type: 'requestHistory' });
  }
  function toggleHistory() { historyOpen ? (historyOpen = false) : openHistoryDropdown(); }
  function recallSession(sessionId: string) {
    historyOpen = false;
    vscode.postMessage({ type: 'recallSession', sessionId });
  }
  function fmtHistoryDate(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }
  /** Still used by the RENAME inputs below (per-chat AND a section name). */
  function focusOnMount(node: HTMLInputElement) { node.focus(); }

  // Any launcher action that changes session state also collapses the
  // recall panel (recallSession already does; keep them consistent).
  function newChat() { historyOpen = false; vscode.postMessage({ type: 'newSession' }); }
  // Open (or reveal) this chat's own editor tab.
  function openChat(id: string) { historyOpen = false; vscode.postMessage({ type: 'popOutSession', sessionId: id }); }
  function closeChat(id: string) { vscode.postMessage({ type: 'closeSession', sessionId: id }); }

  // Drag-to-reorder the Chats list. Native HTML5 DnD (no library in the repo;
  // the only precedent is InputBar's file drop). The dragged index is held in
  // component state rather than in dataTransfer: the payload we need is a list
  // position, dataTransfer is string-only, and reading it back is unavailable
  // during dragover — which is exactly when the drop indicator has to decide.
  // We still setData, because Firefox refuses to start a drag without it.
  //
  // Reorder happens LOCALLY first and the host is told after, so the row follows
  // the pointer without a round trip; the host is authoritative for what gets
  // persisted, and echoes the settled order back.
  //
  // DEFERRED: no keyboard path — this is pointer-only, so the reorder (and the
  // drag-into-a-section move) is not accessible. Removing FROM a section has a
  // keyboard path (the row's un-group button); moving INTO one does not yet.
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);

  function startDrag(e: DragEvent, i: number) {
    dragIndex = i;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sessions[i]?.id ?? '');
    }
  }
  function dragOverRow(e: DragEvent, i: number) {
    if (dragIndex === null) return;   // something else is being dragged — not ours
    e.preventDefault();               // without this the drop event never fires
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    overIndex = i;
  }
  function dropOnRow(e: DragEvent, i: number) {
    if (dragIndex === null) return;
    e.preventDefault();
    const from = dragIndex;
    endDrag();
    if (from === i) return;
    const next = [...sessions];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    sessions = next;
    vscode.postMessage({ type: 'reorderSessions', order: next.map(s => s.id) });
  }
  function endDrag() { dragIndex = null; overIndex = null; }

  // Inline rename: the pencil edits the chat name in place. Enter/blur commits
  // (posts renameSession to the shared host, which writes the title via the
  // config channel and echoes it back as 'sessionTitle'); Escape cancels.
  let editingId = $state<string | null>(null);
  let editDraft = $state('');
  function startRename(s: SessionRow) { historyOpen = false; editingId = s.id; editDraft = s.title ?? ''; }
  function commitRename(s: SessionRow) {
    const title = editDraft.trim();
    editingId = null;
    if (title && title !== (s.title ?? '')) vscode.postMessage({ type: 'renameSession', sessionId: s.id, title });
  }
  function renameKey(e: KeyboardEvent, s: SessionRow) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(s); }
    else if (e.key === 'Escape') { e.preventDefault(); editingId = null; }
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      switch (msg.type) {
        case 'sessionList': {
          // Authoritative full list — the mount-time handshake response.
          // Covers the case where this launcher is the PRIMARY webview and
          // missed the bootstrap `sessionCreated` broadcast (posted before
          // its listener was ready). Incremental events below keep it live.
          const rows = Array.isArray(msg.sessions) ? msg.sessions : [];
          // Carry each row's ring state across the rebuild (mid-turn must not
          // drop back to "no ring"). Open asks trust the HOST's own report
          // (`pendingAskIds`) over `prior` (empty at boot) — else an early
          // `requestPermission` is lost forever. Falls back to `prior` for an older reply.
          const prior = new Map(sessions.map(s => [s.id, s]));
          sessions = rows.map((r: { id?: unknown; number?: unknown; agentName?: unknown; title?: unknown; pendingAskIds?: unknown }) => ({
            id: String(r.id ?? ''),
            number: Number(r.number ?? 0),
            agentName: String(r.agentName ?? 'Tsuru'),
            title: typeof r.title === 'string' && r.title ? r.title : undefined,
            state: prior.get(String(r.id ?? ''))?.state ?? 'idle',
            pendingAsks: Array.isArray(r.pendingAskIds) ? new Set(r.pendingAskIds.filter((x): x is string => typeof x === 'string')) : (prior.get(String(r.id ?? ''))?.pendingAsks ?? new Set<string>()),
          })).filter((s: SessionRow) => s.id);
          break;
        }
        case 'sessionCreated': {
          if (msg.sessionId && !sessions.some(s => s.id === msg.sessionId)) {
            sessions = [...sessions, {
              id: msg.sessionId,
              number: msg.sessionNumber,
              agentName: msg.agentName || 'Tsuru',
              // A REOPENED chat already knows its stored name by the time this
              // launcher attaches (the engine replays it on session/load), so
              // dropping it here is what left a restored row as a bare agent name.
              title: typeof msg.title === 'string' && msg.title ? msg.title : undefined,
              state: 'idle',
              pendingAsks: new Set<string>(),
            }];
          }
          // NOTE: CollabsList listens for this same broadcast itself — it is
          // what makes its "open a chat first" handshake retryable — so there
          // is nothing to forward from here.
          break;
        }
        case 'sessionClosed':
          sessions = sessions.filter(s => s.id !== msg.sessionId);
          break;
        // --- the ring's inputs (see markSession) ---
        case 'echoUser':
          // A replay-tagged echo (loadSession history recall) is not a turn
          // starting — it must leave the ring exactly as it was.
          if (msg.replay) break;
          markSession(msg.sessionId, 'working');
          break;
        case 'busy':
          markSession(msg.sessionId, 'working');
          break;
        case 'turnDone':
        case 'firstfoldDone':
          markSession(msg.sessionId, 'ready');
          break;
        case 'requestPermission': {
          const tcid = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
          const rsid = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          if (tcid && rsid) sessions = sessions.map(s => s.id === rsid ? { ...s, pendingAsks: addPendingAsk(s.pendingAsks, tcid) } : s);
          break;
        }
        case 'permissionAudit': {
          // Only a RESOLUTION clears the ask — see the case-group comment above.
          if (msg.action !== 'approved' && msg.action !== 'denied') break;
          const tcid = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
          if (tcid) sessions = sessions.map(s => ({ ...s, pendingAsks: removePendingAsk(s.pendingAsks, tcid) }));
          break;
        }
        case 'agentSwitched': {
          if (msg.sessionId && msg.agentName) {
            sessions = sessions.map(s => s.id === msg.sessionId ? { ...s, agentName: String(msg.agentName) } : s);
          }
          break;
        }
        case 'sessionTitle': {
          const t = typeof msg.title === 'string' && msg.title ? msg.title : undefined;
          sessions = sessions.map(s => s.id === msg.sessionId ? { ...s, title: t } : s);
          break;
        }
        case 'chatSections': {
          const s = msg.state;
          if (!s || typeof s !== 'object') break;
          const sections: ChatSectionDef[] = Array.isArray(s.sections)
            ? (s.sections as unknown[])
                .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object'
                  && typeof (x as Record<string, unknown>).id === 'string'
                  && typeof (x as Record<string, unknown>).name === 'string')
                .map((x) => ({ id: x.id as string, name: x.name as string, collapsed: x.collapsed === true }))
            : [];
          const knownIds = new Set(sections.map((sec) => sec.id));
          const membership: Record<string, string> = {};
          if (s.membership && typeof s.membership === 'object') {
            for (const [id, section] of Object.entries(s.membership as Record<string, unknown>)) {
              if (!id) continue;
              if (typeof section === 'string' && knownIds.has(section)) membership[id] = section;
            }
          }
          chatSections = {
            membership,
            sections,
            mainCollapsed: s.mainCollapsed === true,
          };
          break;
        }
        case 'showHistory':
          openHistoryDropdown();
          break;
        case 'historyList':
          historyItems = Array.isArray(msg.sessions) ? msg.sessions : [];
          historyLoading = false;
          break;
      }
    };
    window.addEventListener('message', onMsg);
    // Handshake: ask the host for the current session list now that our
    // listener is live, so a bootstrap session created before mount still
    // shows in the Chats list. (The Collabs half runs its own, in CollabsList.)
    vscode.postMessage({ type: 'requestSessions' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<svelte:window onkeydown={(e) => { if (historyOpen && e.key === 'Escape') historyOpen = false; }} />

<div class="chats-toolbar">
  <button class="chat-action primary" onclick={newChat} title="Start a new chat (opens its own editor tab)">＋ New chat</button>
  <button class="chat-action" class:active={historyOpen} onclick={toggleHistory} title="Recall a past chat">⟲ History</button>
  <button class="chat-action" onclick={() => { historyOpen = false; vscode.postMessage({ type: 'openAgentManager' }); }}
    title="Agent Manager — background agents in isolated git worktrees, on their own board">⚑ Agents</button>
</div>

{#if historyOpen}
  <!-- Inline searchable history — flows under the toolbar (no absolute
       anchor), so section order doesn't matter. The panel itself is
       HistoryDropdown.svelte, shared with the Collabs half; the FILTER
       stays here, because only this half matches on the folder too. -->
  <HistoryDropdown
    items={historyFiltered.map(h => ({
      id: h.sessionId,
      title: h.title,
      meta: [h.folder, fmtHistoryDate(h.updatedAt)].filter(Boolean).join(' · '),
    }))}
    loading={historyLoading}
    query={historyQuery}
    onQuery={(v) => (historyQuery = v)}
    onPick={recallSession}
    onClose={() => (historyOpen = false)}
    emptyText={historyItems.length === 0 ? 'No past chats yet.' : 'No matches.'}
  />
{/if}

<!-- One row's markup, shared by every section below so a chat looks and
     behaves identically wherever it sits. `section` is the CURRENT section
     this row is rendered under (null for Main) — it only changes which
     extra button shows. -->
{#snippet chatRow(s: SessionRow, i: number, section: string | null)}
  {@const visualState = deriveRowVisualState(s.state, s.pendingAsks.size > 0)}
  <div
    class="session-row"
    role="listitem"
    title={visualState === 'waiting' ? 'Waiting for you — approval or question open' : visualState === 'working' ? 'Working…' : visualState === 'ready' ? 'Your turn' : undefined}
    class:dragging={dragIndex === i}
    class:drop-above={overIndex === i && dragIndex !== null && dragIndex > i}
    class:drop-below={overIndex === i && dragIndex !== null && dragIndex < i}
    draggable={editingId !== s.id}
    ondragstart={(e) => startDrag(e, i)}
    ondragover={(e) => dragOverRow(e, i)}
    ondrop={(e) => dropOnRow(e, i)}
    ondragend={endDrag}
  >
    <!-- The activity indicator: a full-pill border overlay, not a dot. It is
         position:absolute + inset:0, so its presence/absence NEVER changes the
         row's box — a turn starting or finishing cannot shift any row's text.
         No child element: the sweep is a background on this node alone, so
         there is nothing here whose own box can grow past the ring. `visualState`
         folds in the waiting-for-user override (sessionRowState.ts). -->
    <span class="session-ring" data-state={visualState} aria-hidden="true"></span>
    {#if editingId === s.id}
      <input
        class="session-rename"
        bind:value={editDraft}
        use:focusOnMount
        onkeydown={(e) => renameKey(e, s)}
        onblur={() => commitRename(s)}
        aria-label="Rename chat" />
    {:else}
      <button class="session-open" onclick={() => openChat(s.id)} title="Open this chat in its editor tab">
        <span class="session-tag">#{s.number}</span>
        <span class="session-name">{s.agentName}{s.title ? ': ' + s.title : ''}</span>
      </button>
      <button class="session-rename-btn" onclick={() => startRename(s)} title="Rename chat" aria-label="Rename chat">✎</button>
    {/if}
    {#if section}
      <button class="session-ungroup-btn" onclick={() => removeFromSection(s.id)} title="Remove from section" aria-label="Remove from section">↩</button>
    {/if}
    <button class="session-close" onclick={() => closeChat(s.id)} title="Close this chat" aria-label="Close chat">&times;</button>
  </div>
{/snippet}

<!-- MAIN — pinned top: undeletable, unrenamable, carries the + control that
     creates a new user section. This is the old "ungrouped" list with its
     own header, so a chat with no explicit membership has always lived here. -->
<ChatSectionBlock
  ariaLabel="Main section"
  count={grouped.main.length}
  collapsed={chatSections.mainCollapsed}
  onToggleCollapse={() => toggleSection('main')}
  deletable={false}
  emptyText={mainEmptyText}
  ondragover={dragOverSection}
  ondrop={(e) => dropOnSection(e, null)}
>
  {#snippet nameSlot()}
    <span class="chat-section-name">Main</span>
  {/snippet}
  {#snippet extra()}
    <button class="chat-section-add-btn" onclick={createSection} title="New section" aria-label="New section">＋</button>
  {/snippet}
  {#each grouped.main as id (id)}
    {@const i = indexById.get(id) ?? -1}
    {#if i >= 0}{@render chatRow(sessions[i], i, null)}{/if}
  {/each}
</ChatSectionBlock>

<!-- USER SECTIONS — addable/renamable/deletable, in creation order. Deleting
     one (ChatSectionBlock's own trash button) moves its chats back to Main —
     see chatSections.ts's removeSection. -->
{#each chatSections.sections as sec (sec.id)}
  <ChatSectionBlock
    ariaLabel="{sec.name} section"
    count={(grouped.bySection[sec.id] ?? []).length}
    collapsed={sec.collapsed}
    onToggleCollapse={() => toggleSection(sec.id)}
    deletable={true}
    onDelete={() => deleteSection(sec.id)}
    emptyText="Drag a chat here to group it."
    ondragover={dragOverSection}
    ondrop={(e) => dropOnSection(e, sec.id)}
  >
    {#snippet nameSlot()}
      {#if editingSectionId === sec.id}
        <input
          class="chat-section-rename"
          bind:value={sectionNameDraft}
          use:focusOnMount
          onkeydown={renameSectionKey}
          onblur={commitRenameSection}
          aria-label="Rename section" />
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- the pencil button right after this is the fully keyboard-
             accessible path to the SAME action; dblclick here is a mouse
             convenience only. -->
        <span class="chat-section-name" role="button" tabindex="-1" ondblclick={() => startRenameSection(sec)} title="Double-click to rename">{sec.name}</span>
        <button class="chat-section-rename-btn" onclick={() => startRenameSection(sec)} title="Rename section" aria-label="Rename section">✎</button>
      {/if}
    {/snippet}
    {#each (grouped.bySection[sec.id] ?? []) as id (id)}
      {@const i = indexById.get(id) ?? -1}
      {#if i >= 0}{@render chatRow(sessions[i], i, sec.id)}{/if}
    {/each}
  </ChatSectionBlock>
{/each}

<style>
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
  /* Drop indicator: a line on the edge the dragged row would land against.
     inset box-shadow rather than a border, so the row never changes height
     mid-drag and shove the rest of the list under the pointer. */
  .session-row.drop-above { box-shadow: inset 0 2px 0 0 var(--og-accent); }
  .session-row.drop-below { box-shadow: inset 0 -2px 0 0 var(--og-accent); }

  /* Per-chat activity border — wraps the WHOLE pill, not a dot beside it.
     position:absolute + inset:0 makes it a pure overlay: it never occupies
     row layout, so idle/working/ready render at the exact same box and a
     state change cannot shift a row's text. pointer-events:none so it never
     steals clicks meant for the open/rename/close buttons underneath.
     overflow:hidden is belt-and-braces — there is no child that could escape
     the ring's box, but nothing here is allowed to grow past it either.

     The ring shape is the standard "gradient border" cut: `padding: 2px` +
     mask-composite:exclude turns a filled rounded box into a thin donut
     (border-image can't do this — it ignores border-radius and would square
     off the pill's corners).
       idle: no background at all — an untouched chat must not claim to be
         waiting on you.
       ready: the donut filled with a steady var(--og-success) — the turn is
         back with you, no motion needed to say so.
       waiting: the donut filled with a steady var(--og-status-waiting) — an
         approval or question is open and the engine is PARKED on the user
         (sessionRowState.ts), so it borrows 'ready's no-motion treatment
         rather than spinning a lie about live activity.
       working: the donut is filled by a conic-gradient painted directly on
         THIS element (no oversized rotating child). The sweep is animated by
         registering --sl-ring-angle as a typed <angle> custom property via
         @property and driving it through @keyframes, which the browser can
         interpolate because the property has a declared syntax; animating an
         unregistered var() would not tween. That keeps the ring's own box
         (and mask) completely static while the gradient's start-angle turns
         inside it — nothing ever grows past inset:0, so the row can never
         gain scrollable width from this. It also paints the gradient at the
         PILL's actual (wide/short) aspect ratio instead of rotating a square
         texture cropped into it, so the sweep reads at an even speed all the
         way around. */
  @property --sl-ring-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  .session-ring {
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
  .session-ring[data-state='ready'] { background: var(--og-success); }
  .session-ring[data-state='waiting'] { background: var(--og-status-waiting); }
  .session-ring[data-state='working'] {
    background: conic-gradient(from var(--sl-ring-angle), var(--og-warning) 0deg 90deg, var(--og-border) 90deg 360deg);
    animation: sl-ring-spin 0.9s linear infinite;
  }
  @keyframes sl-ring-spin { to { --sl-ring-angle: 360deg; } }
  /* Respect the OS "reduce motion" setting: freeze the arc in place instead
     of spinning it (angle stays at the @property initial-value, 0deg — a
     static partial arc). Colour alone still separates working (partial arc)
     from ready (closed, steady border). */
  @media (prefers-reduced-motion: reduce) {
    .session-ring[data-state='working'] { animation: none; }
  }

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
  .session-tag {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    color: var(--og-text-muted);
    flex: 0 0 auto;
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
  }
  .session-close:hover { background: var(--og-error); color: white; }

  .session-rename-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 5px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    opacity: 0;
  }
  .session-row:hover .session-rename-btn { opacity: 0.7; }
  .session-rename-btn:hover { opacity: 1; color: var(--og-text); }
  .session-rename {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 12px;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-accent);
    border-radius: 4px;
    padding: 4px 8px;
    outline: none;
  }

  /* t-kgserq — a row's un-group control. Same hover-reveal idiom as the
     rename pencil above, so a section row does not carry a permanently-on
     third icon next to Rename/Close. */
  .session-ungroup-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 4px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    opacity: 0;
  }
  .session-row:hover .session-ungroup-btn { opacity: 0.7; }
  .session-ungroup-btn:hover { opacity: 1; color: var(--og-text); }

  /* A section's NAME area — plain text for Main, this plus the pencil
     below for a custom (renamable) one. */
  .chat-section-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-section-rename-btn {
    background: none;
    border: none;
    color: var(--og-text-muted);
    cursor: pointer;
    font-size: 11px;
    padding: 0 5px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    opacity: 0;
  }
  /* `.chat-section-header` is ChatSectionBlock.svelte's element, not this
     file's — a plain descendant selector would be scoped to a class this
     component never renders and so would never match. `:global()` on just
     that ancestor step reaches across the boundary while `.chat-section-
     rename-btn` (rendered here, inside `nameSlot`) stays normally scoped. */
  :global(.chat-section-header):hover .chat-section-rename-btn { opacity: 0.7; }
  .chat-section-rename-btn:hover { opacity: 1; color: var(--og-text); }
  .chat-section-rename {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    color: var(--og-text);
    background: var(--og-btn-bg);
    border: 1px solid var(--og-accent);
    border-radius: 4px;
    padding: 4px 8px;
    outline: none;
  }
  /* t-kgserq v2 — Main's create-section control. Always visible (not a
     hover-reveal like rename/delete on an individual row): creating a
     section is a deliberate, findable action, not decluttering. */
  .chat-section-add-btn {
    background: none;
    border: none;
    color: var(--og-text-secondary);
    cursor: pointer;
    font-size: 13px;
    padding: 0 4px;
    line-height: 1;
    border-radius: 3px;
    flex: 0 0 auto;
    font-family: inherit;
  }
  .chat-section-add-btn:hover { color: var(--og-accent); background: var(--og-btn-bg); }
</style>
