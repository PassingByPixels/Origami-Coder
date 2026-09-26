<script lang="ts">
  import { tip } from '../../shared/warmTip';
  // TodoSummaryRow — t-yyz5yk (Round 8 I): the todo snapshot left in the
  // transcript, drawn as a tool row. One segment per item (done = green, the
  // next one = blue), "2/5 done · now: <next item>", and a click opens the
  // list with state dots. The turn is over when this row exists, so nothing
  // here moves at rest: the next item's dot is static (the specimen's 8g fix).
  //
  // Not built (see the lane report): one row PER todowrite call. The host
  // routes todowrite to the Todo panel and never makes it a transcript row
  // (src/acpClient.ts tryHandleTodoWrite), so the per-call row needs a host
  // change. This row is the one snapshot the transcript already holds.
  import ToolIcon from './ToolIcon.svelte';
  import type { TodoInfo } from '../panes/chatMessage';
  interface Props { todos: TodoInfo[]; }
  let { todos }: Props = $props();
  let open = $state(false);
  const done = $derived(todos.filter((t) => t.status === 'completed').length);
  // "Next" is the item in progress, else the first one not done.
  const nextIdx = $derived.by(() => {
    const i = todos.findIndex((t) => t.status === 'in_progress');
    return i >= 0 ? i : todos.findIndex((t) => t.status !== 'completed');
  });
  const next = $derived(nextIdx >= 0 ? todos[nextIdx] : undefined);
</script>

<div class="todo-row" class:open>
  <button class="todo-row-head" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="todo-row-icon"><ToolIcon name="todo" /></span>
    <span class="todo-row-verb">Todo</span>
    <span class="todo-segs" aria-hidden="true">
      {#each todos as t, i (t.id)}
        <i class="todo-seg" class:d={t.status === 'completed'} class:cur={i === nextIdx} style="--i: {i}"></i>
      {/each}
    </span>
    <span class="todo-row-meta">{done}/{todos.length} done{#if next}{' · '}<span class="q">now:</span> {next.content}{/if}</span>
    <span class="todo-row-chev" aria-hidden="true">▶</span>
  </button>
  {#if open}
    <ul class="todo-row-list">
      {#each todos as t, i (t.id)}
        <li style="--i: {i}; padding-left: {(t.depth ?? 0) * 14}px">
          <span class="sd" class:done={t.status === 'completed'} class:cur={i === nextIdx}
            use:tip={t.status === 'completed' ? 'Done' : i === nextIdx ? 'Next' : 'To do'}></span>
          <span class:muted={t.status === 'completed'}>{t.content}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .todo-row-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: color-mix(in srgb, var(--og-surface) 60%, transparent);
    color: var(--og-text);
    font: inherit;
    font-size: 11px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 160ms ease;
  }
  .todo-row-head:hover { background: var(--og-surface); }
  .todo-row-icon { display: inline-flex; color: var(--og-text-secondary); }
  .todo-row-verb { color: var(--og-text-secondary); font-weight: 500; }
  .todo-segs { display: inline-flex; gap: 2px; flex: none; }
  .todo-seg {
    width: 10px;
    height: 4px;
    border-radius: 2px;
    background: var(--og-border);
    animation: todo-seg-in 240ms cubic-bezier(0.23, 1, 0.32, 1) both;
    animation-delay: calc(var(--i) * 50ms);
  }
  .todo-seg.d { background: var(--og-success); }
  .todo-seg.cur { background: var(--og-chat); }
  @keyframes todo-seg-in { from { transform: scaleX(0.3); opacity: 0; } }
  .todo-row-meta {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--og-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .todo-row-meta .q { opacity: 0.8; }
  .todo-row-chev { margin-left: auto; font-size: 8px; color: var(--og-text-muted); opacity: 0.6; transition: transform 240ms cubic-bezier(0.23, 1, 0.32, 1); }
  .todo-row.open .todo-row-chev { transform: rotate(90deg); opacity: 1; }
  .todo-row-list {
    margin: 4px 0 6px 26px;
    padding: 6px 10px;
    list-style: none;
    border: 1px solid var(--og-border);
    border-radius: 8px;
    background: var(--og-bg);
    font-size: 11.5px;
  }
  .todo-row-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    line-height: 20px;
    color: var(--og-text-secondary);
    animation: todo-line-in 240ms cubic-bezier(0.23, 1, 0.32, 1) backwards;
    animation-delay: calc(var(--i) * 16ms);
  }
  @keyframes todo-line-in { from { opacity: 0; transform: translateY(3px); } }
  .todo-row-list .muted { color: var(--og-text-muted); }
  .sd { width: 7px; height: 7px; flex: none; border-radius: 50%; border: 1px solid var(--og-text-muted); }
  .sd.done { background: var(--og-success); border-color: var(--og-success); }
  .sd.cur { background: var(--og-chat); border-color: var(--og-chat); }
  @media (prefers-reduced-motion: reduce) {
    .todo-seg, .todo-row-list li { animation: none; }
    .todo-row-chev, .todo-row-head { transition: none; }
  }
</style>
