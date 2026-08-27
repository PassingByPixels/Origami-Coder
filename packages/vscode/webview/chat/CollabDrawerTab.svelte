<script lang="ts">
  // The task drawer's PULL-TAB, extracted from CollabTaskDrawer.svelte when
  // naming the handle took that file 13 lines past its architecture cap. The
  // ratchet's remedy is a component, not a raise.
  //
  // WHY THE HANDLE IS ITS OWN SUBJECT. It is the only part of the drawer that is
  // on screen while the drawer is shut, so it is the whole of what the feature
  // says about itself most of the time — and the bug it exists to fix was
  // exactly that it said nothing. A collapsed drawer used to be one chevron
  // floating over the room (owner screenshot): a control you had to open before
  // you could identify it.
  //
  // The count is WORK OWED, not tasks that exist — accepted ones are closed and
  // are counted out by the drawer. Zero prints no number: a handle claiming "0"
  // is noise, and on an engine with no board at all it would be a lie.

  interface Props {
    open: boolean;
    /** Tasks still in play. 0 prints no number — see above. */
    count: number;
    onToggle: () => void;
  }
  let { open, count, onToggle }: Props = $props();
</script>

<!-- A real <button>, so it is focusable and toggles with Enter/Space. It rides
     WITH the panel on collapse, so it lands flush at the docked edge, and it is
     ALWAYS present — a drawer with no handle is a feature nobody can find. -->
<button
  class="ctd-tab"
  aria-expanded={open}
  aria-label={open ? 'Hide the task board' : 'Show the task board'}
  title={open ? 'Hide tasks' : 'Show tasks'}
  onclick={onToggle}
>
  <span class="ctd-tab-glyph" aria-hidden="true">{open ? '⟩' : '⟨'}</span>
  <span class="ctd-tab-name">Tasks{count > 0 ? ` ${count}` : ''}</span>
</button>

<style>
  /* The WIDTH is load-bearing and belongs to the drawer's geometry: `.ctd`'s
     16px left gutter and its collapsed `translateX(calc(100% - 16px))` are the
     same 16px, so this tab is exactly what stays on screen. Change one and all
     three move. Height is free, which is why the name is set DOWN the tab and
     costs no horizontal room at all. */
  .ctd-tab {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 15px;
    height: 78px;
    padding: 0;
    color: var(--og-text);
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 5px 0 0 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .ctd-tab:hover {
    color: var(--og-accent);
    border-color: var(--og-accent);
  }
  .ctd-tab-glyph {
    font-size: 11px;
    line-height: 1;
  }
  .ctd-tab-name {
    writing-mode: vertical-rl;
    font-size: 9px;
    letter-spacing: 0.06em;
    line-height: 1;
    white-space: nowrap;
  }
</style>
