<script lang="ts">
  // A ticket card — the Hermes anatomy the contract names: id chip · priority ·
  // labels · title · @assignee · acceptance · age. The FILE is the brief, so the
  // card never tries to show the body: ✎ opens the markdown in the editor, which
  // is where a human specs it. Spec (Triage only) hands the ticket to a chat
  // agent that writes the acceptance INTO the file for you; ▶ (Todo only) hands
  // off to the launch popover; ✕ closes the ticket (hidden, not deleted — the
  // file stays on disk).
  //
  // A Todo card is also DRAGGABLE onto the Pending block (contract §11.4). The
  // payload is the bare ticket id and nothing else: the board owns the rule for
  // what may be queued, so the card cannot smuggle a launch past it.
  import { age, type TicketRow } from './boardBuckets';

  interface Props {
    root: string;
    ticket: TicketRow;
    onlaunch: (t: TicketRow, at: DOMRect) => void;
    onspec: (t: TicketRow, at: DOMRect) => void;
    post: (msg: Record<string, unknown>) => void;
  }
  let { root, ticket, onlaunch, onspec, post }: Props = $props();

  // Both pickers hang off THIS card (§12.1): it reports where it is, nothing more.
  let el = $state<HTMLElement>();
  const at = (): DOMRect => el!.getBoundingClientRect();

  // A malformed file has no trustworthy fields, so it offers ONE action: open it.
  let broken = $derived(ticket.malformed === true);
  let closable = $derived(!broken && (ticket.status === 'triage' || ticket.status === 'todo'));
  // `spec` is ABSENT on an older host, so undefined must read as "no spec
  // session" — a card that assumed the field would never leave "speccing…".
  let speccing = $derived(ticket.spec === true);
  let draggable = $derived(!broken && ticket.status === 'todo' && !ticket.fold);

  function onDragStart(e: DragEvent): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ticket.id);
  }
</script>

<article class="am-ticket" class:broken bind:this={el} draggable={draggable} ondragstart={onDragStart}>
  <div class="am-tk-top">
    <span class="am-tk-id">{(ticket.id || '?').toUpperCase()}</span>
    {#if speccing}<span class="am-tk-spec" title="a spec chat is open for this ticket">speccing…</span>{/if}
    {#if !broken && (ticket.priority === 'high' || ticket.priority === 'low')}
      <span class="am-tk-pri {ticket.priority}" title="priority: {ticket.priority}">{ticket.priority}</span>
    {/if}
    {#each ticket.labels ?? [] as label (label)}<span class="am-tk-label">{label}</span>{/each}
    <span class="am-tk-age" title="last updated">{age(ticket.updatedAt)}</span>
  </div>

  <div class="am-tk-title">{ticket.title || '(untitled)'}</div>
  {#if broken}
    <div class="am-tk-warn">malformed ticket file — open it to fix the frontmatter</div>
  {/if}

  <div class="am-tk-foot">
    {#if ticket.assignee}<span class="am-tk-assignee">@{ticket.assignee}</span>{/if}
    {#if !broken && ticket.acceptance && ticket.acceptance.total > 0}
      <span class="am-tk-acc" title="acceptance boxes ticked">✓ {ticket.acceptance.done}/{ticket.acceptance.total}</span>
    {/if}
    <span class="am-tk-actions">
      {#if !broken && ticket.status === 'triage'}
        <button class="am-tk-btn spec" disabled={speccing}
          title="Spec this ticket in a chat — the agent writes testable acceptance into the file"
          aria-label="Spec this ticket" onclick={() => onspec(ticket, at())}>Spec</button>
      {/if}
      <button class="am-tk-btn" title="Open the ticket file — it is the full brief" aria-label="Open the ticket file"
        onclick={() => post({ type: 'amTicketOpen', root, id: ticket.id })}>✎</button>
      {#if !broken && ticket.status === 'todo'}
        <button class="am-tk-btn go" title="Launch a fold for this ticket" aria-label="Launch a fold for this ticket"
          onclick={() => onlaunch(ticket, at())}>▶</button>
      {/if}
      {#if closable}
        <button class="am-tk-btn" title="Close this ticket — the file stays on disk" aria-label="Close this ticket"
          onclick={() => post({ type: 'amTicketClose', root, id: ticket.id })}>✕</button>
      {/if}
    </span>
  </div>
</article>

<style>
  .am-ticket {
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.1));
    border-left: 2px solid var(--og-border, rgba(255, 255, 255, 0.2));
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--og-bg, rgba(0, 0, 0, 0.12));
  }
  .am-ticket.broken { border-left-color: #e6a23c; }
  .am-tk-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 10px; }
  .am-tk-id { font-family: var(--vscode-editor-font-family, monospace); letter-spacing: 0.04em; opacity: 0.75; }
  .am-tk-pri { border-radius: 3px; padding: 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
  .am-tk-pri.high { color: #e6a23c; border: 1px solid rgba(230, 162, 60, 0.5); }
  .am-tk-pri.low { opacity: 0.5; border: 1px solid var(--og-border, rgba(255, 255, 255, 0.15)); }
  .am-tk-label { background: var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 3px; padding: 0 4px; opacity: 0.85; }
  .am-tk-age { margin-left: auto; opacity: 0.5; font-variant-numeric: tabular-nums; }
  .am-tk-title { font-size: 12px; line-height: 1.35; margin: 3px 0; }
  .am-tk-warn { font-size: 10px; color: #e6a23c; margin-bottom: 3px; }
  .am-tk-foot { display: flex; align-items: center; gap: 6px; font-size: 10px; opacity: 0.8; }
  .am-tk-assignee { opacity: 0.8; }
  .am-tk-acc { font-variant-numeric: tabular-nums; opacity: 0.8; }
  .am-tk-actions { margin-left: auto; display: flex; gap: 3px; }
  .am-tk-btn {
    width: 20px; height: 20px; padding: 0; font-size: 11px; line-height: 1; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--og-surface, rgba(255, 255, 255, 0.06)); color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12)); border-radius: 4px;
  }
  .am-tk-btn:hover:not(:disabled) { filter: brightness(1.25); }
  .am-tk-btn:disabled { opacity: 0.5; cursor: default; }
  .am-tk-btn.go { background: var(--og-accent, #3b6ea5); border-color: transparent; }
  /* Spec is a WORDED primary action: it needs room the 20px icon squares do not
     have, and it must not answer to `.go`, which means "launch a fold". */
  .am-tk-btn.spec {
    width: auto; padding: 0 6px; font-size: 10px;
    background: var(--og-accent, #3b6ea5); border-color: transparent;
  }
  .am-ticket[draggable='true'] { cursor: grab; }
  .am-tk-spec { color: var(--og-accent, #7aa7d6); animation: am-tk-pulse 1.3s ease-in-out infinite; }
  @keyframes am-tk-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
