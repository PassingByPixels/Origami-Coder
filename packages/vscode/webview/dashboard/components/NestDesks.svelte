<script lang="ts">
  // DESKS — the Nests view's desk group card (t-s9jr6u; born as the Remote
  // pane's "Your desks" card in t-rz1b14, redrawn to the owner's round-4 rules).
  //
  // Three questions at a glance: which desk am I on, which desks are in the
  // nest, and are they online. One status line says all of it. Each desk is one
  // tile: OS glyph, host name, the home icon on the mother base, a dot and one
  // meta line. "Add a desk" is the only way to invite; its panel closes itself
  // when the new desk joins ("MacBook joined."). No key chips, no device ids.
  //
  // PRESENTATION + INTENT. NestsPane.svelte owns the groupData wire and hands
  // the snapshot down; this card posts the owner's actions and never changes a
  // desk optimistically — every button posts, and the host re-posts the truth.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import NestDeskTile from './NestDeskTile.svelte';
  import NestDesksEmpty from './NestDesksEmpty.svelte';
  import RemoteGroupInvite from './RemoteGroupInvite.svelte';
  import NestJoinCheck from './NestJoinCheck.svelte';
  import { deskLabel, statusLine, tailLine, type NestDesk, type NestTailState } from './nestsStatus';
  import type { JoinCheck } from './nestJoinCheck';

  interface Props {
    desks: NestDesk[];
    inviteKey: string | null;
    inviteQr: string;
    inviteExpiresAt: number | null;
    /** t-sj32zl: a join in flight (Accept step), and why the last one ended. */
    joinCheck?: JoinCheck | null;
    joinNotice?: string | null;
    error: string | null;
    /** The desk that joined while the invite was open (the pane works it out). */
    joined: NestDesk | null;
    /** Bumped on every groupData, so a pending Join knows its reply came. */
    seq: number;
    onDismissJoined: () => void;
    /** t-selspn: set on the mother base only; each other desk's tile says how much of it is held here. */
    tail?: NestTailState | null;
  }
  let { desks, inviteKey, inviteQr, inviteExpiresAt, joinCheck = null, joinNotice = null, error, joined, seq, onDismissJoined, tail = null }: Props = $props();

  const vscode = getVsCodeApi();
  let shut = $state(false);
  let joiningAt = $state(-1);
  let joining = $derived(joiningAt === seq);
  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function join(key: string): void {
    joiningAt = seq;
    vscode.postMessage({ type: 'groupJoin', key });
  }
  function remove(desk: NestDesk): void {
    // Leaving is the × on THIS desk's tile (round 4): the group secret goes.
    vscode.postMessage(desk.self ? { type: 'groupForget' } : { type: 'groupRemoveDevice', id: desk.id });
  }
</script>

<section class="card desks" class:is-shut={shut} data-name="desks">
  <div class="head">
    <button class="chev" aria-expanded={!shut} aria-label="Collapse Desks" onclick={() => (shut = !shut)}>▾</button>
    <span class="caps">Desks</span>
    {#if desks.length}<span class="count">{desks.length}</span>{/if}
    <span class="grow"></span>
    {#if desks.length && !inviteKey}
      <button class="btn primary" onclick={() => vscode.postMessage({ type: 'groupInvite' })}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
        Add a desk
      </button>
    {/if}
  </div>
  {#if !shut}
    <p class="status">{statusLine(desks)}</p>
    {#if joinCheck}
      <NestJoinCheck check={joinCheck} onAnswer={(accept) => vscode.postMessage({ type: 'groupAnswerJoin', accept })}
        onCancel={() => vscode.postMessage({ type: 'groupCancelInvite' })} />
    {:else if joinNotice}
      <p class="note" role="status">{joinNotice}</p>
    {/if}
    {#if desks.length === 0 && joinCheck?.side !== 'joiner'}
      <NestDesksEmpty {error} {joining} onStart={() => vscode.postMessage({ type: 'groupInvite' })} onJoin={join} />
    {:else}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <div class="tiles">
        {#each desks as desk (desk.id)}
          <NestDeskTile {desk} {now} tail={desk.self ? '' : tailLine(tail?.desks[desk.id])}
            onRename={(id, name) => vscode.postMessage({ type: 'groupRenameDevice', id, name })}
            onHome={(id) => vscode.postMessage({ type: 'groupSetMotherBase', id })}
            onRemove={remove} />
        {/each}
      </div>
      {#if inviteKey && !joinCheck}
        <RemoteGroupInvite {inviteKey} {inviteQr} expiresAt={inviteExpiresAt} onCancel={() => vscode.postMessage({ type: 'groupCancelInvite' })} />
      {:else if joined}
        <div class="note ok"><span class="dot"></span><span>{deskLabel(joined)} joined.</span><span class="grow"></span><button class="link" onclick={onDismissJoined}>OK</button></div>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--og-text); font-size: 11.5px; line-height: 1.4;
  }
  .head { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
  .chev {
    width: 16px; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer;
    color: var(--og-text-muted); font-size: 10px; line-height: 16px; transition: transform 160ms ease;
  }
  .card.is-shut .chev { transform: rotate(-90deg); }
  .caps { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--og-text-muted); font-weight: 600; }
  .count {
    min-width: 16px; padding: 0 5px; border: 1px solid var(--og-border); border-radius: 8px; text-align: center;
    color: var(--og-text-muted); font-size: 10px; line-height: 14px; font-variant-numeric: tabular-nums;
  }
  .grow { flex: 1 1 auto; }
  .status { margin: -2px 0 0; font-size: 12px; line-height: 1.45; color: var(--og-text); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px; }
  .btn {
    font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
    background: var(--og-btn-bg); color: var(--og-btn-text); border: 1px solid var(--og-border);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn svg { width: 11px; height: 11px; }
  .btn.primary { background: var(--og-chat); color: var(--og-bg); border-color: var(--og-chat); font-weight: 600; }
  .btn.primary:hover { background: color-mix(in srgb, var(--og-chat) 85%, var(--og-text)); }
  .err { margin: 0; font-size: 10.5px; color: var(--og-error-text); }
  .note {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 11px;
    background: var(--og-surface-alt); border: 1px solid var(--og-border); color: var(--og-text-secondary);
  }
  .note.ok { border-color: color-mix(in srgb, var(--og-success) 45%, var(--og-border)); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--og-success); }
  .link { font: inherit; font-size: 10.5px; background: none; border: 0; padding: 0; cursor: pointer; color: var(--og-text-secondary); }
  .link:hover { color: var(--og-text); text-decoration: underline; }
</style>
