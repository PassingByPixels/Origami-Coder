<script lang="ts">
  // Side quests this workspace has waiting, as a left-edge slide-out drawer
  // (t-f89g49). A side quest is follow-up work the MAIN agent noticed and wrote
  // down with one tool call before moving on; this is where the owner reads them,
  // when he wants to, and never before.
  //
  // THE SAME RAIL AS THE SUB-AGENT DRAWER, deliberately: SubagentDrawer.svelte's
  // aside/pull-tab idiom, its collapse transform, its panel chrome. Two different
  // shapes for two drawers eight pixels apart would read as two features.
  //
  // WHY IT IS ANCHORED NEAR THE TOP AND NOT "just above" the other one:
  // SubagentDrawer.svelte is vertically CENTRED at a height its roster decides,
  // so no fixed gap is reliably "above" it. Anchoring to the rail's head is,
  // for every roster size, and this list caps at 180px. The exact offset — and
  // the pinned band it has to clear (t-fh4tbx) — is in the CSS below.
  //
  // NOTHING IS DERIVED HERE. The rows are the host's list of the open files in
  // `.origami/sidequests`, passed straight in: that is what makes a webview reload
  // and a chat close cost nothing, and it is why this file has no state but its
  // own fold.
  import type { SideQuest } from '../panes/sideQuestProps';
  import SideQuestsTab from './SideQuestsTab.svelte';
  import RailFoldHead from './RailFoldHead.svelte';
  import SideQuestRow from './SideQuestRow.svelte';

  interface Props {
    quests: SideQuest[];
    open: boolean;
    onToggle: () => void;
    /** Open the popup for this quest id. */
    onOpen: (id: string) => void;
    /** The quest open beside the drawer, or '' (t-yyz5je: its row is marked). */
    selectedId?: string;
  }
  let { quests, open, onToggle, onOpen, selectedId = '' }: Props = $props();

  // Collapsed by default, on SubagentDrawer.svelte's own reasoning: a list of
  // work nobody asked for is something to consult, not something that should
  // cover the reply being read.
  let listOpen = $state(false);
</script>

<!-- No quests, no drawer — not even the tab. A handle onto an empty list is a
     permanent piece of furniture advertising an empty room. -->
{#if quests.length > 0}
  <aside class="sq-drawer" class:collapsed={!open}>
    <div class="sq-panel">
      <!-- t-yyz5je: the rail's folding header; folded, it keeps the newest title. -->
      <div class="sq-head-row">
        <RailFoldHead open={listOpen} onToggle={() => (listOpen = !listOpen)}>
          <span class="sq-title">Side quests</span>
          <span class="sq-count">{quests.length} open</span>
          {#snippet peek()}<span class="rail-peek sq-peek">{quests[0].title}</span>{/snippet}
        </RailFoldHead>
      </div>
      {#if listOpen}
        <div class="sq-rows">
          {#each quests as quest (quest.id)}
            <SideQuestRow {quest} selected={quest.id === selectedId} onOpen={() => onOpen(quest.id)} />
          {/each}
        </div>
      {/if}
    </div>
    <SideQuestsTab {open} count={quests.length} {onToggle} />
  </aside>
{/if}

<style>
  /* SubagentDrawer.svelte's geometry on the same rail, plus t-fh4tbx's numbers.
     TOP: `.pinned-user` (PinnedUserMessage.svelte) is border 1 + pad 5 + line
     box 16 (11.5px, line-height normal) + pad 5 + border 1 = 28, + its 8px
     margin = 36px of band. Single mode: scroller pad 8, band ends at 44.
     Multi-up: cell-header 24 + pad 6, ends at 66. One offset clears both:
     66 + a 6px gap = 72. (An `.arbiter-chip`, ~29px, pushes the band lower
     still; the z-index is what makes that overlap merely cosmetic.)
     MAX-HEIGHT: the top came down 64px, so the cap does too — this foot comes
     no nearer SubagentDrawer's centred 60% band than before; the 96px floor
     keeps the panel usable in the smallest (260px) cell.
     Z-INDEX: one context, `.chat-cell` (relative) — .agent-row rows auto ·
     .pinned-user 6 · .right-rail and .sa-drawer 6 · .sq-drawer (tab with it)
     7 · .cf-bar (ChatFind) 8. At 6 it TIED with the band and lost on DOM
     order (a later sibling): the owner's "behind text". */
  .sq-drawer {
    position: absolute;
    top: 72px;
    left: 8px;
    display: flex;
    align-items: stretch;
    width: min(240px, 80%);
    max-height: max(96px, calc(40% - 64px));
    z-index: 7;
    transition: transform 0.22s ease;
  }
  /* Slide LEFT by the panel's width, leaving the tab on screen. No vertical
     transform to restate here: this drawer is top-anchored, not centred. */
  .sq-drawer.collapsed {
    transform: translateX(calc(-100% + 18px));
  }

  .sq-panel {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding: 7px 9px;
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-right: 4px solid var(--og-accent);
    border-radius: 6px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  }

  .sq-head-row { display: flex; align-items: baseline; gap: 4px; flex: 0 0 auto; margin-bottom: 5px; min-width: 0; }
  .sq-title { flex: 0 0 auto; font-size: 10.5px; font-weight: 600; color: var(--og-text); }
  .sq-count { flex: 0 0 auto; font-size: 9px; color: var(--og-text-muted); }
  .sq-peek { flex: 1 1 auto; min-width: 0; font-size: 9.5px; color: var(--og-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* An explicit px cap with its own scroll, INDEPENDENT of the 40% above: a
     workspace that has collected fifteen quests must not grow this panel down
     into the sub-agent drawer's half of the rail. */
  .sq-rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1 1 auto;
    min-height: 0;
    max-height: 180px;
    overflow-y: auto;
  }
</style>
