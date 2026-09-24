<script lang="ts">
  // t-s9k0q6 (Nests L4c): the sidebar's Chats half with the round-7 "Here |
  // Nest" control. SidebarLauncher mounts THIS where it mounted ChatsList.
  //
  // Rule 1 is the whole reason this is a wrapper: with Nests off (the host
  // sends no desks) or with this desk alone, it renders ChatsList with no
  // props at all, which is today's list to the element (nestSidebarGate.test.ts).
  // ChatsList is ONE instance in both states, never inside an {#if}, so a gate
  // that flips (a desk joins, the setting changes) does not remount it and lose
  // its ring states or a close that is still undoable.
  //
  // What this file owns: the wire (origami/nestIndex in, nestContinue and
  // nestOpenRead out, their results in; t-sc093o), the view (per viewer, webview state), what moved or
  // forked here this session, and the two snippets ChatsList draws in its rows
  // (the fork parent line, the from/fork pill). Ordering and words are
  // nestIndex.ts's.
  import { onMount, tick } from 'svelte';
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { arrive, awayChipTip, awayName, awayOf, notAway } from './nestAway'; // t-t7lfho
  import ChatsList from './ChatsList.svelte';
  import ChatsViewToggle from './ChatsViewToggle.svelte';
  import NestList from './NestList.svelte';
  import FromPill from './FromPill.svelte';
  import ForkParentLine from './ForkParentLine.svelte';
  import {
    continueCase,
    deskOf,
    hereHiddenIds,
    nestGateOn,
    parseNestIndex,
    type NestArrival,
    type NestIndex,
    type NestIndexRow,
  } from './nestIndex';

  const vscode = getVsCodeApi();
  const VIEW_KEY = 'chatsView';

  function savedView(): 'here' | 'nest' {
    const s = vscode.getState() as Record<string, unknown> | undefined;
    return s && s[VIEW_KEY] === 'nest' ? 'nest' : 'here';
  }

  let index = $state<NestIndex>({ rows: [], desks: [] });
  let view = $state<'here' | 'nest'>(savedView());
  let gone = $state<ReadonlySet<string>>(new Set());
  let pending = $state<ReadonlySet<string>>(new Set());
  let arrivals = $state<Record<string, NestArrival>>({});
  let error = $state('');
  let now = $state(Date.now());
  /** t-t7lfho: the row each Continue was asked for (the host's next index drops a taken one first), and the chat it landed in. */
  const asked: Record<string, NestIndexRow> = {};
  let selected = $state('');

  const on = $derived(nestGateOn(index));
  const hidden = $derived(hereHiddenIds(index, gone));
  const running = $derived(index.rows.filter((r) => !gone.has(r.id) && continueCase(r, deskOf(index, r.desk)) === 'running').length);

  function setView(next: 'here' | 'nest') {
    view = next;
    const s = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...s, [VIEW_KEY]: next });
  }

  function continueHere(row: NestIndexRow) {
    if (pending.has(row.id)) return;
    pending = new Set([...pending, row.id]);
    asked[row.id] = row;
    error = '';
    vscode.postMessage({ type: 'nestContinue', id: row.id });
  }

  /** A plain click: the host pulls the body if it is not here and opens the
   *  chat, which then shows read only (NestReadOnlyGate.svelte). */
  function openRead(id: string) {
    if (pending.has(id)) return;
    pending = new Set([...pending, id]);
    error = '';
    vscode.postMessage({ type: 'nestOpenRead', id });
  }

  function answered(msg: Record<string, unknown>): string {
    const id = typeof msg.id === 'string' ? msg.id : '';
    pending = new Set([...pending].filter((p) => p !== id));
    error = typeof msg.error === 'string' ? msg.error : '';
    return id;
  }

  /** The host decided: `taken` = the chat moved here (it leaves the Nest);
   *  `forked` = a copy was made here and the original's turn goes on there
   *  (it stays in the Nest). Either way Here is where the result is, so the
   *  view goes there and the chat's row is selected (nestAway.ts arrive). */
  function continued(msg: Record<string, unknown>) {
    const id = answered(msg);
    const got = id ? arrive(index, asked[id] ?? index.rows.find((r) => r.id === id), msg) : null;
    if (!got) return;
    if (got.gone) gone = new Set([...gone, got.gone]);
    arrivals = { ...arrivals, [got.id]: got.arrival };
    selected = got.id;
    setView('here');
    void tick().then(() => document.querySelector('.session-row.selected')?.scrollIntoView?.({ block: 'nearest' }));
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'origami/nestIndex') { index = parseNestIndex(msg); gone = notAway(gone, index); }
      else if (msg.type === 'nestContinueResult') continued(msg);
      else if (msg.type === 'nestOpenReadResult') answered(msg);
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'requestNestIndex' });
    const clock = setInterval(() => (now = Date.now()), 60_000);
    return () => { window.removeEventListener('message', onMsg); clearInterval(clock); };
  });
</script>

{#snippet lead(id: string)}
  {@const a = arrivals[id]}
  {#if a?.parent}
    {@const p = a.parent}
    <ForkParentLine title={p.title} desk={deskOf(index, p.desk)} name={a.fromDesk} onRead={() => openRead(p.id)} />
  {/if}
{/snippet}
{#snippet badge(id: string)}
  {@const a = arrivals[id]}{@const w = awayOf(index, id)}
  {#if w}<FromPill from={awayName(index, w.desk)} away={awayChipTip(index, w)} />{:else if a}<FromPill from={a.fromDesk} fork={a.kind === 'forked'} />{/if}
{/snippet}

<!-- One line on purpose: whitespace between these blocks would be a text node
     in the gated-off DOM, which must be today's exactly. -->
{#if on}<ChatsViewToggle {view} onChange={setView} selfName="" deskCount={index.desks.length} {running} />{/if}{#if on && view === 'nest'}<NestList {index} {gone} {pending} {now} {error} onOpen={(row) => openRead(row.id)} onContinue={continueHere} />{/if}<ChatsList
  hiddenIds={on ? hidden : undefined}
  listHidden={on && view === 'nest'}
  rowLead={on ? lead : undefined}
  rowBadge={on ? badge : undefined}
  selectedId={on ? selected : undefined} />
