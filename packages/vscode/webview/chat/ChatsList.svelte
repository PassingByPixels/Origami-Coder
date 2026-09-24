<script lang="ts">
  // The sidebar's Chats half, extracted from SidebarLauncher.svelte. Owns the
  // session list end to end (handshake, ring lifecycle, drag reorder, rename)
  // plus chat-grouping sections. New chat / History / Agent Manager left with
  // the toolbar: they are SidebarDock.svelte's now.
  //
  // No built-in section besides "Main" — sections exist only when the user
  // makes one. "Main" is pinned top (undeletable, unrenamable, carries the +
  // create-section control; the old "ungrouped" list with its own header),
  // and any number of user sections sit below it (add/rename/delete —
  // deleting moves its chats back to Main). Sections are a display filter
  // over the one global order array; dropping onto a row still just reorders
  // that array, dropping onto a section header sets the chat's membership.
  // Membership/collapsed/section defs persist via the extension's
  // chatSections.ts and ride their own messages, independent of the reorder wire.
  //
  // The per-section header markup is ChatSectionBlock.svelte, generic over
  // Main vs. a custom section. What stays here: every row's own markup and
  // each section's name area, passed to ChatSectionBlock as snippets, because
  // Svelte scopes a snippet's CSS to the file that writes its markup.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { onMount, type Snippet } from 'svelte';
  import ChatSectionBlock from './ChatSectionBlock.svelte';
  // t-s9k0q6 (Nests L4c): ChatsHereNest.svelte's mount point. All absent = today's list. `hiddenIds` = other desks' chats (Nest only);
  // `listHidden` = the Nest tab is up (the rows state stays mounted); `rowLead`/`rowBadge` = a fork's parent line / the from/fork pill.
  // t-t7lfho: `selectedId` = the chat Continue here just landed in (marked, aria-current).
  let { hiddenIds, listHidden = false, rowLead, rowBadge, selectedId }: { hiddenIds?: ReadonlySet<string>; listHidden?: boolean; rowLead?: Snippet<[string]>; rowBadge?: Snippet<[string]>; selectedId?: string } = $props();
  import { animateIn } from './animatedList';
  import {
    groupSessionIds,
    defaultChatSectionsState,
    type ChatSectionDef,
    type ChatSectionsState,
  } from './chatSections';
  import { deriveRowVisualState, addPendingAsk, removePendingAsk } from './sessionRowState';
  import { trackSpawnedChild, clearDoneChild } from './runningChildren';
  import { engineTurnRunning } from '../shared/engineStatus';
  import InlineToast from '../dashboard/components/InlineToast.svelte';
  import { closeToastText, createCloseFuse, type PendingClose } from './pendingClose';

  const vscode = getVsCodeApi();

  // `state` drives the per-row activity ring. 'idle' = no activity seen yet (no
  // ring); 'working' = a turn in flight; 'ready' = the turn came back.
  // `pendingAsks` is the ring's third input, folded in at render time by
  // sessionRowState.ts's deriveRowVisualState rather than living in RowState.
  type RowState = 'idle' | 'working' | 'ready';
  interface SessionRow { id: string; number: number; agentName: string; title?: string; state: RowState; pendingAsks: ReadonlySet<string>; runningChildren: ReadonlySet<string> }
  let sessions = $state<SessionRow[]>([]);

  // The ring's truth is `sessionStatus` (../shared/engineStatus.ts), the only
  // input that covers a turn the engine started. An engine that doesn't send
  // it falls back to the older turn-lifecycle events below:
  //   echoUser — the host echoing the prompt it just accepted; the only
  //     start-of-turn signal for an ordinary chat send. Skipped when it
  //     carries `replay: true` (a history recall), which is not a turn in flight.
  //   busy — the /loop path's start-of-run signal, for runs nobody typed.
  //   turnDone — every terminal path (reply, error, blocked, idle, loop_run).
  //   firstfoldDone — /firstfold's own terminal signal.
  //   requestPermission / permissionAudit — the third ring state's inputs
  //     (see sessionRowState.ts for the wire-shape gotchas).
  function markSession(id: unknown, next: RowState) {
    const sid = typeof id === 'string' ? id : '';
    if (!sid) return;
    // 'ready' also clears pendingAsks: Cancel answers every queued ask
    // host-side without necessarily emitting its own permissionAudit per ask.
    const clearsAsks = next === 'ready' ? { pendingAsks: new Set<string>() } : {};
    sessions = sessions.map(s => s.id === sid ? { ...s, state: next, ...clearsAsks } : s);
  }

  // --- t-kgserq: chat-list sections ---------------------------------------
  let chatSections = $state<ChatSectionsState>(defaultChatSectionsState());
  const knownSectionIds = $derived(new Set(chatSections.sections.map((sec) => sec.id)));
  // A chat waiting on its close fuse is off the list everywhere at once —
  // filtered HERE, so the section counts drop with the row.
  const grouped = $derived(groupSessionIds(
    sessions.filter(s => s.id !== pendingClose?.id && !hiddenIds?.has(s.id)).map(s => s.id), chatSections.membership, knownSectionIds));
  const indexById = $derived(new Map(sessions.map((s, i) => [s.id, i] as const)));
  // Two different empty-Main lines: no chats at all vs. every chat already
  // claimed by a section below it.
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

  // Create/delete are not optimistic — the id is host-generated
  // (chatSections.ts's generateSectionId), so there's nothing correct to
  // render until the `chatSections` echo names it.
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

  /** Still used by the RENAME inputs below (per-chat AND a section name). */
  function focusOnMount(node: HTMLInputElement) { node.focus(); }

  // New chat, the History popup and the Agent Manager moved to SidebarDock.svelte
  // with the toolbar that held them — see that file's header. What is left here
  // is the list itself.
  // Open (or reveal) this chat's own editor tab.
  function openChat(id: string) { vscode.postMessage({ type: 'popOutSession', sessionId: id }); }
  // CLOSING A CHAT IS UNDOABLE (t-ru13hb item 2). The row leaves the list at
  // once and the host hears NOTHING until the fuse burns: an optimistic post
  // plus a later reopen would be a lossier feature, since a reopened session is
  // not the object the sidebar was showing. The fuse, and the one-at-a-time
  // rule, are pendingClose.ts's — this file only draws the toast.
  let pendingClose = $state<PendingClose | null>(null);
  const closeFuse = createCloseFuse({
    post: (id) => {
      vscode.postMessage({ type: 'closeSession', sessionId: id });
      // Drop it locally too. The filter above only hides what is still
      // UNDOABLE, so without this the row would flash back for as long as the
      // host takes to echo a `sessionList` without it. A refused close comes
      // back on that echo, which is the same authority every other row has.
      sessions = sessions.filter((s) => s.id !== id);
    },
    onChange: (p) => (pendingClose = p),
  });
  function closeChat(s: SessionRow) { closeFuse.close({ id: s.id, label: s.title ?? s.agentName }); }

  // Drag-to-reorder the Chats list. Native HTML5 DnD. The dragged index is
  // held in component state rather than dataTransfer, since dataTransfer is
  // string-only and unreadable during dragover, exactly when the drop
  // indicator has to decide; still setData, since Firefox refuses to start a
  // drag without it. Reorder happens locally first and the host is told
  // after, then echoes the settled order back.
  //
  // Deferred: no keyboard path for reorder or drag-into-a-section (pointer
  // only). Removing from a section has a keyboard path (un-group button).
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
  function startRename(s: SessionRow) { editingId = s.id; editDraft = s.title ?? ''; }
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
          // Authoritative full list, the mount-time handshake response —
          // covers a launcher that missed the bootstrap broadcast.
          const rows = Array.isArray(msg.sessions) ? msg.sessions : [];
          // Carry each row's ring state across the rebuild. Open asks trust
          // the host's own report (`pendingAskIds`) over `prior` (empty at
          // boot), else an early `requestPermission` is lost forever.
          const prior = new Map(sessions.map(s => [s.id, s]));
          sessions = rows.map((r: { id?: unknown; number?: unknown; agentName?: unknown; title?: unknown; pendingAskIds?: unknown; runningChildIds?: unknown }) => ({
            id: String(r.id ?? ''),
            number: Number(r.number ?? 0),
            agentName: String(r.agentName ?? 'Tsuru'),
            title: typeof r.title === 'string' && r.title ? r.title : undefined,
            state: prior.get(String(r.id ?? ''))?.state ?? 'idle',
            pendingAsks: Array.isArray(r.pendingAskIds) ? new Set(r.pendingAskIds.filter((x): x is string => typeof x === 'string')) : (prior.get(String(r.id ?? ''))?.pendingAsks ?? new Set<string>()),
            runningChildren: Array.isArray(r.runningChildIds) ? new Set(r.runningChildIds.filter((x): x is string => typeof x === 'string')) : (prior.get(String(r.id ?? ''))?.runningChildren ?? new Set<string>()),
          })).filter((s: SessionRow) => s.id);
          break;
        }
        case 'sessionCreated': {
          if (msg.sessionId && !sessions.some(s => s.id === msg.sessionId)) {
            sessions = [...sessions, {
              id: msg.sessionId,
              number: msg.sessionNumber,
              agentName: msg.agentName || 'Tsuru',
              // A reopened chat already knows its stored name (the engine
              // replays it on session/load); dropping it here would leave a
              // restored row as a bare agent name.
              title: typeof msg.title === 'string' && msg.title ? msg.title : undefined,
              state: 'idle',
              pendingAsks: new Set<string>(),
              runningChildren: new Set<string>(),
            }];
          }
          // CollabsList listens for this same broadcast itself, so there's
          // nothing to forward from here.
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
        case 'sessionStatus': {
          // The engine's own run state — see the case-group comment, and
          // engineStatus.ts for why only 'idle' settles the ring.
          const running = engineTurnRunning(msg.status);
          if (running !== null) markSession(msg.sessionId, running ? 'working' : 'ready');
          break;
        }
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
        case 'toolResult': sessions = trackSpawnedChild(sessions, msg); break;
        case 'subagentDone': sessions = clearDoneChild(sessions, msg); break;
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

<!-- One row's markup, shared by every section below so a chat looks and
     behaves identically wherever it sits. `section` is the CURRENT section
     this row is rendered under (null for Main) — it only changes which
     extra button shows. -->
{#snippet chatRow(s: SessionRow, i: number, section: string | null)}
  {@const visualState = deriveRowVisualState(s.state, s.pendingAsks.size > 0, s.runningChildren.size > 0)}
  {#if rowLead}{@render rowLead(s.id)}{/if}<div
    class="session-row"
    role="listitem"
    title={visualState === 'waiting' ? 'Waiting for you — approval or question open' : visualState === 'working' ? 'Working…' : visualState === 'subagents' ? 'Sub-agents running' : visualState === 'ready' ? 'Your turn' : undefined}
    class:dragging={dragIndex === i}
    class:selected={!!selectedId && s.id === selectedId} aria-current={!!selectedId && s.id === selectedId ? 'true' : undefined}
    class:drop-above={overIndex === i && dragIndex !== null && dragIndex > i}
    class:drop-below={overIndex === i && dragIndex !== null && dragIndex < i}
    draggable={editingId !== s.id}
    ondragstart={(e) => startDrag(e, i)}
    ondragover={(e) => dragOverRow(e, i)}
    ondrop={(e) => dropOnRow(e, i)}
    ondragend={endDrag}
    use:animateIn
  >
    <!-- The activity indicator: a full-pill border overlay, not a dot.
         position:absolute + inset:0 so its presence/absence never shifts the
         row's text. `visualState` folds in the waiting-for-user override
         (sessionRowState.ts). -->
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
      <!-- Mock-Redesign change 29: a small dot reads state at a glance beside
           the ring's whole-pill border. Blue pulsing = a turn is live
           (working/subagents), amber = parked on you (waiting), grey = idle
           or your turn. The number moves to the title — a row's identity is
           its name, not its ordinal. -->
      <button
        class="session-open"
        onclick={() => openChat(s.id)}
        title="#{s.number} — Open this chat in its editor tab"
      >
        <span
          class="session-dot"
          data-state={visualState === 'working' || visualState === 'subagents' ? 'running' : visualState === 'waiting' ? 'asking' : 'idle'}
          aria-hidden="true"
        ></span>
        <span class="session-name">{s.agentName}{s.title ? ': ' + s.title : ''}</span>
        <!-- The unread count reuses the SAME pendingAsks set the ring's
             'waiting' state already tracks (requestPermission /
             permissionAudit) — the number of open asks in this chat. There is
             no separate unread-message field on the wire to read instead. -->
        {#if s.pendingAsks.size > 0}
          <span class="session-unread" aria-label="{s.pendingAsks.size} waiting">{s.pendingAsks.size}</span>
        {/if}{#if rowBadge}{@render rowBadge(s.id)}{/if}
      </button>
      <button class="session-rename-btn" onclick={() => startRename(s)} title="Rename chat" aria-label="Rename chat">✎</button>
    {/if}
    {#if section}
      <button class="session-ungroup-btn" onclick={() => removeFromSection(s.id)} title="Remove from section" aria-label="Remove from section">↩</button>
    {/if}
    <!-- t-ql9ari: swipe-to-delete (A1, t-q8zfo7) misread a horizontal drag as
         a reorder attempt. The x is the only delete affordance again. -->
    <!-- t-ql9ari: swipe-to-delete (A1, t-q8zfo7) misread a horizontal drag as
         a reorder attempt. The x is the only delete affordance again. -->
    <button class="session-close" onclick={() => closeChat(s)} title="Close this chat" aria-label="Close chat">&times;</button>
  </div>
{/snippet}

<!-- MAIN — pinned top: undeletable, unrenamable, carries the + control that
     creates a new user section. This is the old "ungrouped" list with its
     own header, so a chat with no explicit membership has always lived here. -->
{#if !listHidden}
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
        <!-- The pencil button after this is the keyboard-accessible path to
             the same action; dblclick here is a mouse convenience only. -->
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
{/if}

<!-- The Undo, for as long as the fuse burns. Fixed to the sidebar's foot: the
     row it belongs to has just left the list, so there is nothing to anchor to. -->
{#if pendingClose}
  <div class="chat-close-toast">
    <InlineToast text={closeToastText(pendingClose.label)} actionLabel="Undo"
      onAction={closeFuse.undo} onDismiss={closeFuse.commit} />
  </div>
{/if}

<style>
  .chat-close-toast { position: fixed; left: 8px; bottom: 10px; z-index: 60; }
  .session-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 5px;
  }
  .session-row:hover { background: var(--og-btn-bg); }
  .session-row.selected { background: var(--og-btn-bg); box-shadow: inset 2px 0 0 0 var(--og-accent); }
  /* ENTRANCE (change 3, react-bits AnimatedList as written): shrunk and
     transparent until the row is 50% visible, then 200ms to rest after a
     fixed 100ms delay — no per-index stagger. animatedList.ts toggles
     `is-in`; leaving the viewport reverses it. */
  .session-row {
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
                transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
    transition-delay: 100ms;
  }
  /* :global on the RUNTIME class only — animatedList.ts adds `is-in`, which
     never appears in this file's markup, so Svelte would otherwise prune the
     rule as unused and the rows would stay invisible for ever. The
     `.session-row` half stays scoped, so this cannot leak. */
  .session-row:global(.is-in) { opacity: 1; transform: scale(1); }
  @media (prefers-reduced-motion: reduce) {
    .session-row { opacity: 1; transform: none; transition: none; }
  }
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
  .session-ring[data-state='subagents'] { background: conic-gradient(from var(--sl-ring-angle), color-mix(in srgb, var(--og-warning) 55%, transparent) 0deg 90deg, var(--og-border) 90deg 360deg); animation: sl-ring-spin 2.4s linear infinite; }
  /* Respect the OS "reduce motion" setting: freeze the arc in place instead
     of spinning it (angle stays at the @property initial-value, 0deg — a
     static partial arc). Colour alone still separates working (partial arc)
     from ready (closed, steady border). */
  @media (prefers-reduced-motion: reduce) {
    .session-ring[data-state='working'], .session-ring[data-state='subagents'] { animation: none; }
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
  /* t-qmzz3q — change 29's dot. A separate signal from .session-ring (which
     wraps the whole pill): the ring says "this row needs attention", the dot
     says WHICH of the three states that is, at a glance down the list. */
  .session-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    margin-right: 1px;
    border-radius: 50%;
    background: var(--og-text-muted);
    opacity: 0.55;
  }
  .session-dot[data-state='running'] {
    background: var(--og-chat);
    opacity: 1;
    animation: session-dot-pulse 1.6s cubic-bezier(0.77, 0, 0.175, 1) infinite;
  }
  .session-dot[data-state='asking'] { background: var(--og-warning); opacity: 1; }
  @keyframes session-dot-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--og-chat) 55%, transparent); }
    55% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--og-chat) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .session-dot { animation: none !important; }
  }
  .session-unread {
    flex: none;
    min-width: 15px;
    height: 15px;
    margin-left: auto;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--og-chat);
    color: var(--og-bg);
    font-size: 9px;
    font-weight: 700;
    line-height: 15px;
    text-align: center;
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
  /* t-kgserq v2 — Main's create-section control. t-qmzz3q (change 32) made it
     hover-only, matching the rename/delete idiom above: findable on hover
     over the header, not a permanently-on fourth icon beside the count. */
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
    opacity: 0;
    transition: opacity 140ms ease;
  }
  :global(.chat-section-header):hover .chat-section-add-btn,
  :global(.chat-section-header):focus-within .chat-section-add-btn { opacity: 0.8; }
  .chat-section-add-btn:hover { opacity: 1; color: var(--og-accent); background: var(--og-btn-bg); }
</style>
