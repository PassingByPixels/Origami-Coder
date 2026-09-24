<script lang="ts">
  // THE CONTACTS RAIL — one row per contact, and the row above them all.
  //
  // "ALL MAIL" IS THE ONE ADDITION TO THE MOCK, and it is there because of what
  // the mock costs: with contacts as a rail and the middle as one thread, a
  // question waiting from a contact the owner has not clicked is only a dot.
  // "What waits on me, across everybody" then has no answer at all — so the
  // first row is that answer, and it opens the three trays the mail tile has
  // always drawn. It carries the whole flock's waiting count, so the number is
  // on screen before anything is selected.
  //
  // The FILTER is the tile's own, beside the list it filters, for the reason
  // the contacts tile it replaces gave: a draft held by the pane would be pane
  // state only one child could ever read. `filterFriends` is the shared rule —
  // label and name as substrings, the handle as a PREFIX — and `flockRows.ts`
  // says why those two differ.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import { avatarTint } from '../panes/flockRows';
  import { filterFriends } from '../panes/flockRows';
  import { ALL_MAIL, type ContactThread } from '../panes/flockThread';

  interface Props {
    threads: ContactThread[];
    /** A full handle, or ALL_MAIL. */
    selected: string;
    onselect: (key: string) => void;
  }
  let { threads, selected, onselect }: Props = $props();

  let search = $state('');
  let shown = $derived(filterFriends(threads, search));
  let waiting = $derived(threads.reduce((n, t) => n + t.waiting, 0));
  let unread = $derived(threads.reduce((n, t) => n + t.unread, 0));
</script>

<section class="rail">
  <div class="rail-head">
    <svg class="fk-ico head-ico" aria-hidden="true"><use href="#fk-users" /></svg>
    <span class="fk-caps">Contacts</span>
    <span class="fk-pill"><b>{threads.length}</b></span>
  </div>
  <div class="rail-search">
    <svg class="fk-ico sm" aria-hidden="true"><use href="#fk-search" /></svg>
    <input class="fk-inp" placeholder="Filter by name or handle" aria-label="Filter contacts" bind:value={search} />
  </div>
  <div class="rail-list">
    <button
      class="crow"
      class:sel={selected === ALL_MAIL}
      aria-pressed={selected === ALL_MAIL}
      onclick={() => onselect(ALL_MAIL)}
    >
      <span class="fk-avatar all"><svg class="fk-ico sm" aria-hidden="true"><use href="#fk-inbox" /></svg></span>
      <span class="lines">
        <span class="fk-name">All mail</span>
        <span class="last">Inbox, Sent and Archive, across every contact</span>
      </span>
      {#if waiting + unread > 0}
        <span class="unread-dot" title={`${waiting + unread} waiting on you`}></span>
      {/if}
    </button>

    {#each shown as thread (thread.handle)}
      <button
        class="crow"
        class:sel={selected === thread.handle}
        aria-pressed={selected === thread.handle}
        title={thread.handle}
        onclick={() => onselect(thread.handle)}
      >
        <span class="fk-avatar" style={`background: ${avatarTint(thread.handle)}`}>
          <ArchetypeGlyph id={thread.icon} size={16} />
        </span>
        <span class="lines">
          <span class="fk-name">{thread.name}</span>
          <span class="last">{thread.last || 'Nothing said yet.'}</span>
        </span>
        {#if thread.waiting + thread.unread > 0}
          <span class="unread-dot" title={`${thread.waiting + thread.unread} waiting on you`}></span>
        {/if}
      </button>
    {/each}

    {#if threads.length > 0 && shown.length === 0}
      <p class="fk-empty">No contact matches that search.</p>
    {/if}

    <p class="fk-muted hint">
      Send someone your invite, and accept theirs. A contact link is two invites, one each way.
    </p>
  </div>
</section>

<style>
  .rail {
    background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px;
    display: flex; flex-direction: column; min-height: 0; min-width: 0;
  }
  .rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; flex-wrap: wrap; }
  .head-ico { color: var(--og-text-muted); }
  .rail-search { padding: 0 12px 8px; display: flex; align-items: center; gap: 4px; color: var(--og-text-muted); }
  .rail-search .fk-inp { flex: 1; }
  .rail-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 12px; display: flex; flex-direction: column; gap: 4px; }
  .crow {
    display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 5px;
    border: 1px solid transparent; cursor: pointer; background: none; color: inherit; font: inherit;
    text-align: left; width: 100%; min-width: 0;
  }
  .crow:hover { background: var(--og-surface-alt); }
  .crow.sel { background: var(--og-surface-alt); border-color: var(--og-border); }
  .crow .lines { min-width: 0; flex: 1; }
  .crow .last { color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .crow .unread-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--og-status-waiting); flex: 0 0 auto; }
  .fk-avatar.all { background: var(--og-surface-alt); color: var(--og-text-secondary); }
  .hint { padding: 8px; margin-top: auto; }
</style>
