<script lang="ts">
  // t-s9k0q6 (round 7 rules 2-3): the Nest tab. ONE flat list of the other
  // desks' chats: no sections, no folders. A search box on top ("Search the
  // nest") filters both parts; running and open chats, a thin "History"
  // divider, then the closed ones. Order and filtering are nestIndex.ts's;
  // this file draws and holds only the query. A plain click opens the chat
  // read only (t-sc093o): the host pulls its body and opens it.
  import NestRow from './NestRow.svelte';
  import { deskName, deskOf, filterText, nestRows, type NestIndex, type NestIndexRow } from './nestIndex';

  let { index, gone, pending, now, error = '', onOpen, onContinue }: {
    index: NestIndex;
    /** Ids that moved to this desk this session. */
    gone: ReadonlySet<string>;
    pending: ReadonlySet<string>;
    now: number;
    /** The host's last refusal (a pull or a Continue that failed). */
    error?: string;
    onOpen: (row: NestIndexRow) => void;
    onContinue: (row: NestIndexRow) => void;
  } = $props();

  let query = $state('');
  let input: HTMLInputElement | undefined = $state();

  const list = $derived(nestRows(index, query, gone));
  const shown = $derived(list.open.length + list.closed.length);
  const line = $derived(filterText(shown, list.total, query));
  const home = $derived(index.desks.find((d) => d.motherBase));

  function searchKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && query) { e.preventDefault(); query = ''; }
  }
  function clear() { query = ''; input?.focus(); }

</script>

{#snippet rowOf(row: NestIndexRow)}
  <NestRow {row} desk={deskOf(index, row.desk)} name={deskName(index, row)} {home} {now}
    pending={pending.has(row.id)} {onOpen} {onContinue} />
{/snippet}

<div class="nest-view" class:filtered={!!query.trim()}>
  <label class="nest-search">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
    <input type="search" placeholder="Search the nest" aria-label="Search the nest" spellcheck="false"
      bind:this={input} bind:value={query} onkeydown={searchKey} />
  </label>
  {#if line}
    <div class="nest-filter"><span>{line}</span><button class="nest-link" onclick={clear}>Clear</button></div>
  {/if}
  <div class="nest-rows" role="list" aria-label="Chats on the other desks">
    {#each list.open as row (row.id)}{@render rowOf(row)}{/each}
    {#if list.closed.length}
      <div class="nest-divider" role="separator"><span>History</span></div>
      {#each list.closed as row (row.id)}{@render rowOf(row)}{/each}
    {/if}
  </div>
  {#if error}<div class="nest-none nest-err" role="alert">{error}</div>{/if}
  {#if list.total === 0}
    <div class="nest-none">No chats on the other desks</div>
  {/if}
</div>

<style>
  .nest-view { display: flex; flex-direction: column; padding-bottom: 6px; }
  .nest-search {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    margin: 0 12px 4px;
    padding: 0 8px;
    border: 1px solid var(--og-border);
    border-radius: 6px;
    background: var(--og-input-bg);
    color: var(--og-text-muted);
  }
  .nest-search:focus-within { border-color: var(--og-chat); }
  .nest-view.filtered .nest-search { border-color: color-mix(in srgb, var(--og-chat) 70%, var(--og-border)); }
  .nest-search svg { width: 12px; height: 12px; flex: 0 0 auto; }
  .nest-search input {
    flex: 1 1 auto;
    min-width: 0;
    height: 22px;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--og-text);
    font: inherit;
    font-size: 11.5px;
  }
  .nest-search input::placeholder { color: var(--og-text-muted); }
  .nest-search input::-webkit-search-cancel-button { filter: grayscale(1); opacity: 0.6; }
  .nest-filter {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 18px;
    padding: 0 12px 2px 14px;
    font-size: 10.5px;
    color: var(--og-text-muted);
  }
  .nest-filter span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nest-link { padding: 0; border: 0; background: none; color: var(--og-text-secondary); font: inherit; font-size: 10.5px; cursor: pointer; }
  .nest-link:hover { color: var(--og-text); text-decoration: underline; }
  .nest-rows { display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
  .nest-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 14px;
    margin: 6px 4px 2px 6px;
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--og-text-muted);
  }
  .nest-divider::after { content: ''; flex: 1 1 auto; height: 1px; background: color-mix(in srgb, var(--og-border) 75%, transparent); }
  .nest-none { padding: 4px 14px; font-size: 10.5px; color: var(--og-text-muted); }
  .nest-err { color: var(--og-error-text); }
</style>
