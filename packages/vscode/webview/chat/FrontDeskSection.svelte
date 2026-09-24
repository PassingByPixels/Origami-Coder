<script lang="ts">
  // THE SIDEBAR'S FRONT DESK — how much of your mail is somebody's turn.
  //
  // Two kinds of row, and the badge counts both: a contact's QUESTION waiting on
  // a decision, and a contact's REPLY nobody has read. Both are things a person
  // is waiting on, and until this header said so the only place either appeared
  // was a pane on a board tab nobody has open.
  //
  // COLLAPSED BY DEFAULT, and the badge is the whole point of that: the section
  // costs nothing while it is shut, and the number on it is the reason to open
  // it. Zero renders NO badge — a badge that says 0 is a badge that says "look".
  //
  // THE HEADER ROW IS GONE (change 1). Opening and the badge both moved to the
  // dock, so `collapsed` is now BOUND to the parent and `count` is reported up.
  // Persistence stays here, because the key and the shape are this section's.
  //
  // IT POLLS, and that is a deliberate choice rather than a missing feature. A
  // flock question used to be a parked permission, so `requestPermission` was a
  // free "something changed" signal; the mailbox is a file two engines write, so
  // there is no session-scoped event to ride. The poll is the mailbox read
  // itself — the rows are what the buttons act on, so a count without them would
  // be a badge that could not be cleared from here.
  //
  // THE ROWS THEMSELVES are FrontDeskRows.svelte — extracted when this file was
  // two lines under its cap and the owner asked for two more controls on them.
  import { onMount } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import FrontDeskRows from './FrontDeskRows.svelte';
  import { badgeCount, type MailRow } from '../dashboard/panes/flockMail';
  import { deliverMessage, type DeliverTarget, type MailSession } from '../dashboard/panes/flockDeliverTargets';

  const vscode = getVsCodeApi();

  const POLL_MS = 60_000; // fallback only — the engine pushes origami/flockMailbox from a flock.json watch
  const STATE_KEY = 'origami.sidebar.frontDesk';

  let {
    collapsed = $bindable(true),
    /** The dock draws the badge, so the count has to reach it. */
    oncount,
  }: { collapsed?: boolean; oncount?: (n: number) => void } = $props();

  let threads: MailRow[] = $state([]);
  let sessions: MailSession[] = $state([]);

  let waiting = $derived(threads.filter((row) => row.direction === 'in' && row.state === 'pending'));
  let replies = $derived(threads.filter((row) => row.direction === 'out' && row.unread && row.reply));
  let count = $derived(badgeCount(threads));

  function persist(): void {
    try {
      const all = (vscode.getState() as Record<string, unknown>) || {};
      vscode.setState({ ...all, [STATE_KEY]: { collapsed } });
    } catch {
      /* getState/setState unavailable in this host — best-effort only */
    }
  }

  // The saved value is READ on mount and written on every later change. The
  // first run is skipped deliberately: persisting what we just loaded would
  // write the default back over a real preference on a host with no state.
  let loaded = false;
  $effect(() => {
    void collapsed;
    if (!loaded) { loaded = true; return; }
    persist();
  });

  $effect(() => oncount?.(count));

  function decide(thread: string, action: 'answer' | 'decline'): void {
    vscode.postMessage({ type: 'flockDecide', thread, action });
  }

  function deliver(row: MailRow, target: DeliverTarget): void {
    // The SAME message the mail manager posts, built by the SAME function: the
    // engine writes the text, so both surfaces send nothing but a row id and a
    // destination. Two spellings of it is how one of the two stops working.
    vscode.postMessage(deliverMessage(row, target));
  }

  function openFlock(): void {
    // Two messages, one intent: open the board tab, and tell it which view to
    // land on. The board may not have attached when the second arrives — its
    // own `boardReady` handshake replays a pending section, which is the
    // mechanism the collab room's "Manage bots" link already uses.
    vscode.postMessage({ type: 'openAgentManager' });
    vscode.postMessage({ type: 'openBoardSection', section: 'friends' });
  }

  onMount(() => {
    try {
      const saved = ((vscode.getState() as Record<string, unknown>) || {})[STATE_KEY] as { collapsed?: boolean };
      if (typeof saved?.collapsed === 'boolean') collapsed = saved.collapsed;
    } catch {
      /* best-effort */
    }

    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      // A `flockMailbox` posted for the PANE lands here too, which is why
      // deciding a row over there updates this header with no wire of its own.
      if (msg.type === 'flockMailbox') threads = Array.isArray(msg.threads) ? msg.threads : [];
      // The picker needs the open chats, and their ENGINE ids: the chat that
      // asked is matched on those (flockDeliverTargets.ts).
      if (msg.type === 'flockSessions') sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'flockMailboxRequest' });
    const timer = setInterval(() => vscode.postMessage({ type: 'flockMailboxRequest' }), POLL_MS);
    return () => {
      window.removeEventListener('message', onMsg);
      clearInterval(timer);
    };
  });
</script>

<div class="fd-section" class:collapsed>
  {#if !collapsed}
    <div class="section-label">Front Desk</div>
    <div class="fd-body">
      {#if count === 0}
        <p class="fd-empty">Nothing waiting. A contact's question and a contact's reply both land here.</p>
      {/if}
      <FrontDeskRows {waiting} {replies} {sessions} ondecide={decide} ondeliver={deliver} />
      <button class="fd-link" onclick={openFlock}>Open Flock</button>
    </div>
  {/if}
</div>

<style>
  .fd-section { flex-shrink: 0; display: flex; flex-direction: column; }
  .fd-body { display: flex; flex-direction: column; gap: 5px; padding: 4px 10px 2px; }
  .fd-empty { margin: 0; font-size: 11px; line-height: 1.45; color: var(--og-text-secondary); }
  .fd-link {
    align-self: flex-start; font: inherit; font-size: 10px; padding: 0; background: none;
    border: none; cursor: pointer; color: var(--og-text-muted); text-decoration: underline;
  }
  .fd-link:hover { color: var(--og-text); }
  /* The section-label rule lives in SidebarLauncher's own <style>; Svelte scopes
     styles per component, so the shared class needs its size restated here.
     NO SIDE PADDING, written into this rule rather than undone by a second one:
     the 12px it used to carry was a 12px hole between FRONT DESK and its count
     badge, and the `.fd-name` override that meant to close it could not — equal
     specificity, and this rule is the later of the two, so it won. */
  .section-label {
    padding: 8px 12px 2px; font-size: 10px; font-weight: 600; letter-spacing: 1px;
    text-transform: uppercase; color: var(--og-text-muted);
  }
</style>
