<script lang="ts">
  // Flock pane: messaging between Origami agents (contacts, mailbox, Front Desk).
  // Three columns: a contacts rail, the selected thread, and a right rail
  // (Front Desk, Identity, Invite, Permissions).
  // This file is the wire only. The columns are their own components
  // (FlockRail, FlockThread, FlockAllMail, FlockSide); shared chrome is
  // FlockChrome.svelte. This file keeps only page-level state: which rail
  // row is selected, and which chips are open.
  // Data comes from src/dashboard/flockPane.ts: `flockData` for the page,
  // `flockMailbox` for threads, `flockScopeOptions` for the pickers.
  // Every write posts and waits for the re-read; nothing updates
  // optimistically, so a refused write is never shown as done.
  // The model catalog loads on mount as a broadcast, not state, so a pane
  // that mounts late must re-request it.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import FlockAllMail from '../components/FlockAllMail.svelte';
  import FlockChrome from '../components/FlockChrome.svelte';
  import FlockElsewhere from '../components/FlockElsewhere.svelte';
  import FlockExplainer from '../components/FlockExplainer.svelte';
  import FlockRail from '../components/FlockRail.svelte';
  import FlockSide from '../components/FlockSide.svelte';
  import FlockThread from '../components/FlockThread.svelte';
  import type { MailRow } from './flockMail';
  import { copy } from './flockCopy';
  import { deliverMessage, type MailSession } from './flockDeliverTargets';
  import { flockInbound, type ModelOpt, type ProviderStat } from './flockInbound';
  import { chipOpen, scopeCount, type ChipId } from './flockChips';
  import { ALL_MAIL, contactThreads, defaultSelection } from './flockThread';
  import type { FlockPickedFolder, FlockScopeOptions, FlockState } from './flockTypes';
  const vscode = getVsCodeApi();

  /** Where the open/shut chips are remembered, inside the board's own state. */
  const CHIP_KEY = 'flockChips';

  let state: FlockState | null = $state(null);
  let error = $state('');
  let threads: MailRow[] = $state([]);
  let sessions: MailSession[] = $state([]);
  let invite = $state('');
  let inviteQr = $state('');
  let modelOptions: ModelOpt[] = $state([]);
  let providerStatus: ProviderStat[] = $state([]);
  let scopeOptions: FlockScopeOptions = $state({ repos: [], wiki: [] });
  let picked: FlockPickedFolder | null = $state(null);
  let pickCount = 0;
  /** origamicoder.flock.enabled, same read ChatView does (`=== true` only — an absent global reads OFF); the `enabled` inbound message updates it live. */
  let enabled = $state((window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__ === true);

  /** '' = the owner has not picked yet, so the default rule still applies. It
   *  is NOT seeded to the default once: the default depends on the mailbox,
   *  which arrives after mount and changes while the pane is open. */
  let chosen = $state('');
  let savedChips: Partial<Record<ChipId, boolean>> = $state(
    ((vscode.getState() as Record<string, unknown> | null)?.[CHIP_KEY] as Partial<Record<ChipId, boolean>>) ?? {},
  );

  let waiting = $derived(threads.filter((row) => row.direction === 'in' && row.state === 'pending').length);
  let contacts = $derived(contactThreads(threads, state?.friends ?? []));
  let selected = $derived(chosen || defaultSelection(contacts));
  let current = $derived(contacts.find((thread) => thread.handle === selected));
  let facts = $derived({
    named: Boolean(state?.identity.name.trim()),
    hasContacts: (state?.friends.length ?? 0) > 0,
    shared: scopeCount(state?.frontDesk.scope) > 0,
  });
  let chips = $derived(chipOpen(savedChips, facts));

  /**
   * The only way out of this pane. `state` is `$state`, so values read
   * from it are Svelte proxies. `postMessage` structured-clones its
   * payload, which throws on a proxy, so an un-snapshotted payload is
   * simply never sent.
   *
   * Snapshotting here, not in each picker, covers every caller: a plain
   * payload passes through unchanged.
   */
  function post(msg: Record<string, unknown>): void {
    vscode.postMessage($state.snapshot(msg));
  }

  function load(): void {
    post({ type: 'flockRequest' });
    post({ type: 'flockScopeOptions' });
    post({ type: 'flockMailboxRequest' });
  }

  // Sanitising lives in flockInbound.ts; this only assigns $state and bumps the pick nonce.
  window.addEventListener('message', (event: MessageEvent) => {
    const patch = flockInbound(event.data || {});
    if (!patch) return;
    switch (patch.kind) {
      case 'data': error = patch.error; state = patch.state; return;
      case 'mailbox': threads = patch.threads; return;
      case 'sessions': sessions = patch.sessions; return;
      case 'invite': invite = patch.invite; inviteQr = patch.qr; return;
      case 'scopeOptions': scopeOptions = patch.options; return;
      case 'picked': picked = { ...patch.pick, nonce: ++pickCount }; return;
      case 'models': modelOptions = patch.options; return;
      case 'providers': providerStatus = patch.providers; return;
      case 'enabled': enabled = patch.enabled; if (patch.error) error = patch.error; return;
    }
  });

  load();
  post({ type: 'requestModels' });
  post({ type: 'requestProviderStatus' });

  /** Persisted beside the board's own view id, not instead of it. */
  function toggleChip(id: ChipId): void {
    savedChips = { ...savedChips, [id]: !chips[id] };
    const previous = (vscode.getState() as Record<string, unknown> | null) ?? {};
    vscode.setState({ ...previous, [CHIP_KEY]: $state.snapshot(savedChips) });
  }
</script>

<div class="flock-pane">
  <FlockChrome />
  <div class="head">
    <h1><span class="big">Flock</span></h1>
    <span class="fk-sec">One contact, one thread. It works like any other messenger.</span>
    <button class="fk-btn" onclick={load} title="Re-read your flock and the waiting questions">Refresh</button>
  </div>

  {#if error}
    <div class="err" role="alert">{error}</div>
  {/if}

  {#if state}
    <FlockExplainer />
    <FlockElsewhere transport={state.transport} holderPid={state.holder?.pid} />

    <div class="grid" class:off={!enabled}>
      <FlockRail threads={contacts} {selected} onselect={(key) => (chosen = key)} />

      {#if current}
        {#key current.handle}<FlockThread
          thread={current}
          {sessions}
          ondecide={(thread, action, extra) => post({ type: 'flockDecide', thread, action, ...extra })}
          onsend={(thread, text) => post({ type: 'flockSend', thread, ...(text === undefined ? {} : { text }) })}
          ondeliver={(row, target) => post(deliverMessage(row, target))}
          onmark={(thread) => post({ type: 'flockMark', thread, mark: 'read' })}
          onfollowup={(row, question) => post({ type: 'flockFollowUp', to: row.contact, question, followUpOf: row.id })}
          onask={(to, question) => post({ type: 'flockFollowUp', to, question })}
          onrevoke={(handle) => post({ type: 'flockRevoke', handle })}
          edit={{ flock: state, picked, options: scopeOptions, onpost: post }}
          oncopy={copy}
        />{/key}
      {:else}
        <FlockAllMail
          {threads}
          {sessions}
          {waiting}
          ondecide={(thread, action, extra) => post({ type: 'flockDecide', thread, action, ...extra })}
          onsend={(thread, text) => post({ type: 'flockSend', thread, ...(text === undefined ? {} : { text }) })}
          ondeliver={(row, target) => post(deliverMessage(row, target))}
          onmark={(thread) => post({ type: 'flockMark', thread, mark: 'read' })}
          onfollowup={(row, question) => post({ type: 'flockFollowUp', to: row.contact, question, followUpOf: row.id })}
        />
      {/if}

      <FlockSide
        {state}
        {waiting}
        {invite}
        {inviteQr}
        {modelOptions}
        {providerStatus}
        {scopeOptions}
        {picked}
        {enabled}
        open={chips}
        ontoggle={toggleChip}
        oncopy={copy}
        onpost={post}
        onbrowse={(kind) => post({ type: 'flockBrowseFolder', kind, target: '' })}
        onenabled={(v) => post({ type: 'flockSetEnabled', enabled: v })}
      />
    </div>
  {/if}
</div>

<style>
  /* THE PANE FILLS ITS HOST. No max width: the board body is a flex column with
     a real height, so the pane takes all of it and the grid inside splits it
     between the three columns. A cap here left a third of a 1900px screen
     empty, which is the fault the owner named. */
  .flock-pane {
    flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto;
    padding: 16px 24px 40px; font-size: 11.5px; line-height: 1.5; color: var(--og-text);
    container-type: inline-size;
  }
  .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .head h1 { margin: 0; font-size: 11.5px; font-weight: 700; } .head .big { font-size: 26px; letter-spacing: -0.01em; }
  .head .fk-btn { margin-left: auto; }
  .err { padding: 8px 16px; margin-top: 16px; border-radius: 6px; background: var(--og-surface); border: 1px solid var(--og-error); color: var(--og-error-text); }
  :global(.flock-pane > .fk-banner) { margin-top: 16px; }
  /* `flex: 1` (basis 0, shrinkable), NOT `1 0 auto`: the grid fills exactly
     what is left of the pane's own bounded height, stretching every column —
     rail, thread, side — to it. `1 0 auto` locked the grid to its CONTENT
     height, so a long thread outgrew the pane and `.flock-pane` scrolled the
     whole page instead of `.thread-body` scrolling in place. `min-height:
     420px` is a FLOOR for a short board, not a lock against shrinking above it. */
  .grid {
    flex: 1; display: grid; gap: 16px; margin-top: 16px; min-height: 420px;
    grid-template-columns: 250px minmax(0, 1fr) 300px;
  }
  /* Off: the rail and the thread dim, but not the desk (`.side`) — the switch
     that turns it back on lives there. */
  .grid.off > :global(:not(.side)) { opacity: 0.4; pointer-events: none; }
  /* CONTAINER queries on the pane's own inline size, not the viewport: this
     pane lives in a VS Code webview whose width tracks the user's side panels,
     not the screen, so `@media` cannot see a narrow Agent Manager on a wide
     monitor. Under 1000px the right rail drops under the thread; under 720 the
     contacts rail becomes a strip above it. */
  @container (max-width: 999px) {
    .grid { grid-template-columns: 250px minmax(0, 1fr); }
    .grid > :global(.side) { grid-column: 1 / -1; overflow: visible; }
  }
  @container (max-width: 719px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .grid > :global(.rail) { max-height: 220px; }
  }
</style>
