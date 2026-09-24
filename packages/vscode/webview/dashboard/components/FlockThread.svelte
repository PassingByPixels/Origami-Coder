<script lang="ts">
  // ONE CONTACT, ONE THREAD, ONE PLACE TO WRITE — the middle of the messenger.
  //
  // The whole exchange with this contact, oldest at the top, with a day
  // divider where the date changes: history reads in ORDER instead of as three
  // trays. The owner's questions sit on the right in the accent, the contact's
  // questions and answers on the left, which is the convention every messenger
  // uses and the one the tray rows could not express.
  //
  // THE CONTACT CARD'S CONTROLS ARE IN THIS HEAD. Edit and Revoke used to live
  // on a row in a Contacts tile; with the rail carrying only a name, a line and
  // a dot, the head of the thread is the only place left that is unambiguously
  // ABOUT this contact. Revoke still asks first — it drops a key, and their
  // invite is already spent.
  //
  // EDIT OPENS A POPOVER, FlockContactScope.svelte: the owner's own label for
  // them AND what this one contact may read. The permissions half used to be a
  // fold in the Permissions chip, one row per contact; it is here because this
  // is where the owner is looking when they decide it. Everything that popover
  // needs arrives as ONE `edit` prop, which this file only forwards.
  //
  // The BUTTONS under the last turn of each exchange are FlockRowActions.svelte,
  // the same leaf the Mail trays use, so a message name cannot be renamed in
  // one place and left behind in the other.
  //
  // The COMPOSER posts the same `flockFollowUp` (ACP `flock_post`) that Follow
  // up does, minus the thread it follows: asking and following up are one act
  // with one wire, and a second door would be a second thing to keep working.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import FlockContactScope from './FlockContactScope.svelte';
  import FlockMailBubbles from './FlockMailBubbles.svelte';
  import FlockRowActions from './FlockRowActions.svelte';
  import { stateLabel, type MailRow } from '../panes/flockMail';
  import { shouldPin, threadDays, timeOf, type ContactThread } from '../panes/flockThread';
  import type { ContactEdit } from '../panes/contactScope';
  import type { DeliverTarget, MailSession } from '../panes/flockDeliverTargets';

  interface Props {
    thread: ContactThread;
    sessions: MailSession[];
    /** Injected so "TODAY" is assertable rather than true for one day only. */
    now?: Date;
    ondecide: (thread: string, action: 'answer' | 'decline', extra?: { guidance?: string; reason?: string }) => void;
    onsend: (thread: string, text?: string) => void;
    ondeliver: (row: MailRow, target: DeliverTarget) => void;
    onmark: (thread: string) => void;
    onfollowup: (row: MailRow, question: string) => void;
    onask: (handle: string, question: string) => void;
    onrevoke: (handle: string) => void;
    /** Everything the Edit popover reads and writes; contactScope.ts says why
     *  it is one bag rather than four props. */
    edit: ContactEdit;
    oncopy: (text: string) => void;
  }
  let {
    thread, sessions, now = new Date(), ondecide, onsend, ondeliver, onmark, onfollowup,
    onask, onrevoke, oncopy, edit,
  }: Props = $props();

  let openRow = $state('');
  let editing = $state(false);
  let confirming = $state(false);
  let question = $state('');

  // PIN TO THE BOTTOM. FlockPane.svelte keys this component on the contact's
  // handle, so a SWITCH remounts it fresh (pinned, from the top of this file)
  // rather than reusing a scroll position that belonged to a different
  // conversation; what is left here is staying pinned across an update to the
  // SAME thread — a reply landing while the owner reads history must not yank
  // the view back down.
  let listEl: HTMLDivElement | undefined = $state();
  let pinned = $state(true);

  let days = $derived(threadDays(thread.rows, now));

  function onScroll(e: Event): void {
    const el = e.currentTarget as HTMLDivElement;
    pinned = shouldPin(el.scrollTop, el.clientHeight, el.scrollHeight);
  }

  function toBottom(): void {
    pinned = true;
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  // Re-runs on mount AND whenever a row is added; scrolls only while pinned.
  $effect(() => {
    void thread.rows.length;
    if (pinned && listEl) listEl.scrollTop = listEl.scrollHeight;
  });

  function ask(): void {
    const text = question.trim();
    if (!text) return;
    onask(thread.handle, text);
    question = '';
  }
</script>

<section class="thread">
  <div class="thread-head">
    <span class="fk-avatar"><ArchetypeGlyph id={thread.icon} size={16} /></span>
    <span class="fk-grow">
      <span class="fk-name">{thread.name}</span>
      <button
        class="fk-chip"
        title={thread.handle}
        aria-label={`Copy the full handle ${thread.handle}`}
        onclick={() => oncopy(thread.handle)}
      >{thread.handleShort}…</button>
    </span>
    {#if thread.waiting > 0}
      <span class="fk-pill wait"><span class="fk-dot"></span>{thread.waiting} waiting</span>
    {/if}
    {#if confirming}
      <button class="fk-btn danger" onclick={() => { confirming = false; onrevoke(thread.handle); }}>Confirm revoke</button>
      <button class="fk-btn" onclick={() => (confirming = false)}>Cancel</button>
    {:else}
      <button class="fk-btn" aria-expanded={editing} onclick={() => { confirming = false; editing = !editing; }}>Edit</button>
      <button class="fk-btn" onclick={() => (confirming = true)}>Revoke</button>
    {/if}
    {#if editing}
      <FlockContactScope {...edit} handle={thread.handle} name={thread.name} onclose={() => (editing = false)} />
    {/if}
  </div>

  <div class="thread-body" bind:this={listEl} onscroll={onScroll}>
    {#if thread.rows.length === 0}
      <p class="fk-empty">Nothing yet. Ask {thread.name} something below.</p>
    {/if}
    {#each days as day (day.label)}
      <span class="day">{day.label}</span>
      {#each day.rows as row (row.id)}
        <div class="turn" class:right={row.direction === 'out' && !row.reply}>
          <FlockMailBubbles {row} dir={false} />
          <div class="foot">
            <span class="fk-chip static">{stateLabel(row)}</span>
            {#if row.followUpOf}<span class="fk-chip static">follow-up</span>{/if}
            <span class="fk-meta">{timeOf(row.question.sentAt)}</span>
          </div>
          <FlockRowActions {row} {sessions} {openRow} onopen={(id) => (openRow = id)} {ondecide} {onsend} {ondeliver} {onmark} {onfollowup} />
        </div>
      {/each}
    {/each}
    {#if !pinned}
      <button class="jump-bottom" onclick={toBottom} aria-label="Scroll to the newest message">↓ newest</button>
    {/if}
  </div>

  <div class="composer">
    <textarea
      class="fk-inp"
      placeholder={`Ask ${thread.name}…`}
      aria-label={`Ask ${thread.name}`}
      bind:value={question}
    ></textarea>
    <button class="fk-btn primary" disabled={!question.trim()} onclick={ask}>Ask</button>
  </div>
</section>

<style>
  .thread {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px;
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
  }
  /* `position: relative` is the popover's anchor — FlockContactScope.svelte is
     absolute inside this head so opening it cannot push the thread down. */
  .thread-head { position: relative; display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--og-border); flex-wrap: wrap; }
  .thread-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .day { align-self: center; color: var(--og-text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .turn { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .turn .foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .turn.right .foot { justify-content: flex-end; }
  /* STICKY inside `.thread-body`, as its LAST child: glued to the bottom edge once scrolled up, in its own natural place once already there. */
  .jump-bottom {
    position: sticky; bottom: 8px; align-self: center; border-radius: 999px; border: 1px solid var(--og-border);
    background: var(--og-surface); color: var(--og-text); padding: 4px 12px; font-size: 11px; cursor: pointer;
  }
  .composer { border-top: 1px solid var(--og-border); padding: 12px 16px; display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; resize: none; height: 52px; font: inherit; }
</style>
