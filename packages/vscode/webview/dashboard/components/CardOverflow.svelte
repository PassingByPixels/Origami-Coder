<script lang="ts">
  // The card's ⋯ menu (contract §6). The rail keeps the two actions you reach for
  // on a card in THIS state; everything rarer moves in here, WORDED — an icon
  // rail could say "✕" for prune, a menu has to say what it destroys.
  //
  // A destructive entry carries `confirm`: the first click swaps its wording to
  // the confirm line and nothing is sent, the second click runs it. That is the
  // whole guard — no modal, no dialog, and it cannot be clicked through by
  // accident because the label changes under the pointer.
  //
  // The armed entry is remembered by its LABEL, never by its position. The menu
  // is open while amState broadcasts keep arriving, and a row that changes state
  // changes its entries — with a positional memory, "arm Prune, poll tick, click"
  // would fire whatever action had moved into that slot.
  interface Item {
    label: string;
    title?: string;
    danger?: boolean;
    /** Wording shown after the first click; absent = the entry runs immediately. */
    confirm?: string;
    run: () => void;
  }
  interface Props { items: Item[] }
  let { items }: Props = $props();

  let open = $state(false);
  let armed = $state('');

  function close(): void { open = false; armed = ''; }
  function toggle(): void { if (open) close(); else open = true; }
  function choose(item: Item): void {
    if (item.confirm && armed !== item.label) { armed = item.label; return; }
    close();
    item.run();
  }
</script>

<div class="am-of">
  <button class="am-of-btn" title="More actions" aria-label="More actions" aria-expanded={open}
    onclick={toggle}>⋯</button>
  {#if open}
    <div class="am-of-back" role="presentation" onclick={close}></div>
    <div class="am-of-menu" role="menu">
      {#each items as item (item.label)}
        <button class="am-of-item" class:danger={item.danger} class:confirming={armed === item.label}
          role="menuitem" title={item.title} onclick={() => choose(item)}>
          {armed === item.label ? (item.confirm ?? item.label) : item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .am-of { position: relative; }
  .am-of-btn {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--og-surface, rgba(255, 255, 255, 0.06));
    color: var(--og-text);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.12));
    border-radius: 4px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }
  .am-of-btn:hover { filter: brightness(1.25); }
  .am-of-back { position: fixed; inset: 0; z-index: 20; }
  .am-of-menu {
    position: absolute;
    z-index: 21;
    top: 24px;
    right: 0;
    min-width: 200px;
    display: flex;
    flex-direction: column;
    background: var(--og-bg, #1e1e1e);
    border: 1px solid var(--og-border, rgba(255, 255, 255, 0.18));
    border-radius: 6px;
    padding: 3px;
  }
  .am-of-item {
    text-align: left;
    background: transparent;
    color: var(--og-text);
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .am-of-item:hover { background: var(--og-surface, rgba(255, 255, 255, 0.08)); }
  .am-of-item.danger { color: #ff9d9d; }
  .am-of-item.confirming { background: rgba(192, 80, 80, 0.18); font-weight: 600; }
</style>
