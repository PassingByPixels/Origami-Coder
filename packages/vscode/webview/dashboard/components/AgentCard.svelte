<script lang="ts">
  // The FOLD card on the Folds kanban. A fold is now provisioned FOR a ticket, so
  // the card headlines the WORK (the ticket title), not the branch slug. Below
  // that: at most three chips (agent · model · state/elapsed), the rest moved into
  // the line's tooltip — a column is 230px wide and a six-chip line was unreadable
  // in it. A working card also carries one live activity line, the only thing on
  // the board that answers "what is it doing right now?" without opening a chat.
  //
  // The rail keeps the TWO actions this state calls for; the rest are worded
  // entries under ⋯ (CardOverflow), where prune confirms inline. The single-editor
  // / single-expansion invariants stay the PANE's: it passes `editing`/`expanded`
  // for THIS card plus the callbacks; the card renders, reports, and keeps only
  // the local editor working fields.
  import AgentModelSelect from './AgentModelSelect.svelte';
  import AgentTypeSelect from './AgentTypeSelect.svelte';
  import AgentDiffPanel from './AgentDiffPanel.svelte';
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import CardOverflow from './CardOverflow.svelte';
  import { age, bucketRow, type Row } from './boardBuckets';

  interface ModelOpt { value: string; name: string; configured?: boolean; }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other'; }

  interface Props {
    repoRoot: string;
    defaultModel: string;
    row: Row;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    agentTypes: Array<{ id: string; name: string }>; // roster for the queued-task editor + line2 name

    editing: boolean;   // is THIS card the single one being edited (pane-owned)
    expanded: boolean;  // is THIS card's diff panel open (pane-owned)
    post: (msg: Record<string, unknown>) => void;
    onStartEdit: (r: Row) => void;
    onCancelEdit: () => void;
    onSaveEdit: (root: string, id: string, changed: Record<string, unknown>) => void;
    onToggleExpand: (root: string, r: Row) => void;
    onApplied: () => void;
    onCloseDiff: () => void;
  }
  let {
    repoRoot, defaultModel, row, modelOptions, providerStatus, agentTypes, editing, expanded,
    post, onStartEdit, onCancelEdit, onSaveEdit, onToggleExpand, onApplied, onCloseDiff,
  }: Props = $props();
  // line2 shows the agent-type DISPLAY name (capitalized, matching the dropdown)
  // for a known engine mode, else the raw id ('tsuru'/unharvested). Display-only.
  const typeName = (id: string): string => { const n = agentTypes.find((t) => t.id === id)?.name ?? id; return n ? n[0].toUpperCase() + n.slice(1) : n; };

  // Local editor working fields, seeded on Edit. Originals captured so Save sends
  // only the changed fields (amUpdateQueued updates only what it is given).
  let editTask = $state('');
  let editAgent = $state('tsuru');
  let editModel = $state('');
  let editOrig = $state<{ task: string; agent: string; model: string }>({ task: '', agent: 'tsuru', model: '' });

  function startEdit(): void {
    editTask = row.queuedPrompt;
    editAgent = row.agentName || 'tsuru';
    editModel = row.model; // the stored RAW pick ('' = repo/engine default)
    editOrig = { task: row.queuedPrompt, agent: row.agentName || 'tsuru', model: row.model };
    onStartEdit(row);
  }
  function saveEdit(): void {
    if (!editTask.trim()) return; // no empty/whitespace task (mirrors the launch guard)
    const changed: Record<string, unknown> = {};
    if (editTask !== editOrig.task) changed.prompt = editTask;
    if (editAgent !== editOrig.agent) changed.agentName = editAgent;
    if (editModel !== editOrig.model) changed.model = editModel;
    onSaveEdit(repoRoot, row.id, changed);
  }

  function pretty(v: string): string {
    const parts = v.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : v;
  }
  function stateLabel(r: Row): string {
    switch (r.state) {
      case 'provisioning': return 'provisioning…';
      case 'working': return 'working…';
      case 'queued': return 'queued';
      case 'idle': return `idle${r.stopReason ? ` (${r.stopReason})` : ''}`;
      case 'error': return `error — ${r.errorDetail}`;
      default: return r.orphan ? 'orphan (adopted from disk)' : 'detached (no live session)';
    }
  }

  const hasChanges = (r: Row): boolean => r.ahead + r.adds + r.dels > 0;
  const isDone = (r: Row): boolean => r.state === 'idle' || r.state === 'error' || r.state === 'detached';
  const promotable = (r: Row): boolean => isDone(r) && hasChanges(r);
  const isMerged = (r: Row): boolean => r.mergedAt > 0;
  // A finished run that changed nothing and was not merged — otherwise
  // indistinguishable from a broken card.
  const noChanges = (r: Row): boolean => isDone(r) && !hasChanges(r) && !isMerged(r);
  function toggleExpand(): void {
    if (!promotable(row)) return; // only finished cards open the apply surface
    onToggleExpand(repoRoot, row);
  }

  // The card headlines the WORK: its ticket's title, else the queued task's first
  // line, else the worktree name (a plain fold with nothing else to say).
  let headline = $derived(row.ticketTitle || (row.queuedPrompt || '').split('\n')[0].trim() || row.name);
  // Blocked is derived from the SAME rule the column uses, so a card cannot sit
  // in Blocked without the border that says so.
  let blocked = $derived(bucketRow(row) === 'blocked');
  // Everything line2 has no room for. One tooltip, one line each.
  let extras = $derived([
    row.branch,
    row.needsYou ? `needs you: ${row.needsYou.preview}` : '',
    noChanges(row) ? 'the run finished without changing any files — open Chat to see what it did' : '',
    row.groupId ? 'part of a race — siblings share this group' : '',
    row.setupNote ? `setup: ${row.setupNote}` : '',
    isMerged(row) ? `merged ${age(row.mergedAt)} ago` : '',
    row.state === 'working' && Date.now() - row.startedAt > 120_000 ? 'local models can be slow; open Chat to watch live' : '',
  ].filter(Boolean).join('\n'));

  interface OverflowItem { label: string; title?: string; danger?: boolean; confirm?: string; run: () => void }
  let overflow = $derived.by<OverflowItem[]>(() => {
    const del = (deleteBranch: boolean) => post({ type: 'amDelete', root: repoRoot, id: row.id, deleteBranch });
    const prune: OverflowItem = {
      label: 'Prune — remove the worktree AND the branch',
      title: 'The work in this worktree is gone', danger: true,
      confirm: 'Prune for real? the work is gone', run: () => del(true),
    };
    if (row.state === 'provisioning' || row.state === 'working') {
      return [{ label: 'Open a terminal in the worktree', run: () => post({ type: 'amOpenTerminal', root: repoRoot, id: row.id }) }];
    }
    if (row.state === 'queued') return [prune];
    const items: OverflowItem[] = [];
    if (row.state === 'error' && row.queuedPrompt) {
      items.push({ label: 'Retry — run the queued task', run: () => post({ type: 'amStart', root: repoRoot, id: row.id }) });
    }
    items.push({ label: 'Delete — remove the worktree, keep the branch', run: () => del(false) }, prune);
    return items;
  });
</script>

<div class="am-card" class:working={row.state === 'working' || row.state === 'provisioning'} class:blocked>
  {#if editing}
    <div class="am-editor">
      <label class="am-task">
        <span>Task</span>
        <textarea rows="3" bind:value={editTask} placeholder="What should this agent do?"></textarea>
      </label>
      <label>
        <span>Agent</span>
        <AgentTypeSelect agentTypes={agentTypes} value={editAgent} onchange={(v) => (editAgent = v)} />
      </label>
      <label>
        <span>Model</span>
        <AgentModelSelect options={modelOptions} providerStatus={providerStatus}
          value={editModel} onchange={(v) => (editModel = v)}
          leading={[{ value: '', label: defaultModel ? 'Repo default' : 'Engine default' }]} placeholder="Model" />
      </label>
      <div class="am-editor-actions">
        <button class="am-btn primary" onclick={saveEdit} disabled={!editTask.trim()}>Save</button>
        <button class="am-btn" onclick={onCancelEdit}>Cancel</button>
      </div>
    </div>
  {:else}
    <div class="am-card-main">
      <div class="am-content">
        <div class="am-line1">
          <svg class="am-crane {row.state}" viewBox="0 0 64 64" aria-hidden="true"><polygon points="30,40 47,40 52,11"/><polygon points="26,40 48,40 43,7"/><polygon points="44,40 62,29 47,48"/><polygon points="28,39 48,41 36,55"/><polygon points="21,44 28,39 36,55"/><polygon points="9,12 15,13 28,41 22,44"/><polygon points="9,12 15,13 14,19 2,17"/></svg>
          {#if row.ticketId}<span class="am-tk-chip" title="launched from ticket {row.ticketId}">{row.ticketId.toUpperCase()}</span>{/if}
          <span class="am-name" title={row.path}>{headline}</span>
          <button class="am-git" type="button" disabled={!promotable(row)}
            title={promotable(row) ? 'Review & apply to main — commits ahead · line adds/dels vs the base commit' : (hasChanges(row) ? 'Commits ahead · line adds/dels vs the base commit' : 'No changes vs the base commit')}
            onclick={toggleExpand}>
            {#if row.ahead > 0}<span class="ahead">↑{row.ahead}</span>{/if}
            {#if row.adds > 0}<span class="adds">+{row.adds}</span>{/if}
            {#if row.dels > 0}<span class="dels">−{row.dels}</span>{/if}
          </button>
        </div>
        <div class="am-line2" title={extras}>
          {#if row.agentName}<span class="am-type"><ArchetypeGlyph id={row.agentName} />{typeName(row.agentName)}</span>{/if}
          {#if row.model}<span class="am-model">{pretty(row.model)}</span>{/if}
          <span class="am-state">{stateLabel(row)} · {age(row.startedAt)}</span>
        </div>
        {#if row.state === 'working' && row.activity}
          <div class="am-activity" title={row.activity}>{row.activity}</div>
        {/if}
      </div>
      <div class="am-rail">
        {#if row.state === 'queued'}
          <button class="am-rail-btn" title="Run this task now" aria-label="Run this task now"
            onclick={() => post({ type: 'amStart', root: repoRoot, id: row.id })}>▶</button>
          <button class="am-rail-btn" title="Edit the queued task" aria-label="Edit the queued task"
            onclick={startEdit}>✎</button>
        {:else if row.state === 'provisioning' || row.state === 'working'}
          {#if row.hasSession}
            <button class="am-rail-btn" title="Open the agent chat" aria-label="Open the agent chat"
              onclick={() => post({ type: 'amOpenChat', root: repoRoot, id: row.id })}>❝</button>
          {/if}
          <button class="am-rail-btn" title="Stop this agent" aria-label="Stop this agent"
            onclick={() => post({ type: 'amCancel', root: repoRoot, id: row.id })}>■</button>
        {:else}
          <!-- Merged + the done family (idle/error/detached/orphan): Chat is ALWAYS
               shown; the reopen path serves dead sessions from the persisted id. -->
          <button class="am-rail-btn" title="Open the agent chat" aria-label="Open the agent chat"
            onclick={() => post({ type: 'amOpenChat', root: repoRoot, id: row.id })}>❝</button>
          {#if !isMerged(row)}
            <button class="am-rail-btn merge" disabled={!hasChanges(row)}
              title={hasChanges(row) ? 'Review & apply to main' : 'No changes to apply'}
              aria-label="Review and apply to main"
              onclick={toggleExpand}>⤴</button>
          {/if}
        {/if}
        <CardOverflow items={overflow} />
      </div>
    </div>
    {#if expanded}
      <AgentDiffPanel root={repoRoot} id={row.id} mergedAt={row.mergedAt} onApplied={onApplied} onClose={onCloseDiff} />
    {/if}
  {/if}
</div>

<style>
  .am-card {
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.1));
    border-radius: 6px;
    padding: 7px 9px;
    background: var(--og-bg, rgba(0, 0, 0, 0.12));
  }
  .am-card.working { border-color: var(--og-accent, #3b6ea5); }
  /* Blocked wins the border: a card that needs you must not read as "running". */
  .am-card.blocked { border-color: #e6a23c; }
  .am-line1 { display: flex; align-items: center; gap: 6px; }
  .am-line2 {
    display: flex;
    gap: 6px;
    font-size: 10px;
    opacity: 0.7;
    margin-top: 3px;
    flex-wrap: wrap;
  }
  /* The crane IS the status indicator: fill tracks row state (old dot palette), pulsing while working. */
  .am-crane { width: 15px; height: 15px; flex: none; fill: #888; }
  .am-crane.provisioning, .am-crane.working { fill: #d9b44a; animation: am-pulse 1.1s ease-in-out infinite; }
  .am-crane.queued { fill: #7aa7d6; }
  .am-crane.idle { fill: #6fbf73; }
  .am-crane.error { fill: #e05555; }
  .am-crane.detached { fill: #888; }
  .am-tk-chip {
    flex: none; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px; letter-spacing: 0.04em; opacity: 0.65; padding: 0 3px;
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.18)); border-radius: 3px;
  }
  .am-type { display: inline-flex; align-items: center; gap: 3px; }
  .am-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-activity { font-size: 10px; font-style: italic; opacity: 0.55; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .am-git { display: flex; gap: 5px; margin-left: auto; font-size: 10px; font-variant-numeric: tabular-nums; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 0 3px; color: inherit; cursor: pointer; }
  .am-git:hover:not(:disabled) { border-color: var(--og-border, rgba(255, 255, 255, 0.2)); }
  .am-git:disabled { cursor: default; }
  .ahead { color: var(--og-accent, #7aa7d6); }
  .adds { color: #7fc97f; }
  .dels { color: #e08a8a; }
  /* Two-part card: content grows, the icon rail hugs the right edge. */
  .am-card-main { display: flex; align-items: flex-start; gap: 6px; }
  .am-content { flex: 1; min-width: 0; }
  .am-rail {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: center;
  }
  .am-rail-btn {
    width: 22px; height: 22px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
    font-size: 12px; line-height: 1; cursor: pointer;
  }
  .am-rail-btn:hover { filter: brightness(1.25); }
  .am-rail-btn:disabled { opacity: 0.4; cursor: default; filter: none; }
  .am-editor { display: flex; flex-direction: column; gap: 8px; }
  .am-editor label { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
  .am-editor label span { min-width: 44px; opacity: 0.75; }
  .am-editor label.am-task { align-items: flex-start; }
  .am-editor textarea {
    flex: 1; min-width: 0; padding: 4px 8px; font: inherit; font-size: 12px;
    background: var(--og-bg); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15)); border-radius: 4px;
  }
  .am-editor-actions { display: flex; gap: 6px; }
  .am-state { margin-left: auto; }
  @keyframes am-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .am-btn {
    padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
  }
  .am-btn:hover { filter: brightness(1.2); }
  .am-btn.primary { background: var(--og-accent, #3b6ea5); border-color: transparent; }
  .am-btn:disabled { opacity: 0.5; cursor: default; }
</style>
