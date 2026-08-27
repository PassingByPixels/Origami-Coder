<script lang="ts">
  // The last few things one agent DID, beside its prompt capture.
  //
  // Wave 1 shipped this retention engine-side (`collab/activity.ts`, 20 signals
  // kept ACROSS turns) because a surface showing only the newest line makes a
  // room look like it is thinking rather than working (report F3). Nothing
  // extension-side mirrored the field, so it arrived on every poll and was
  // dropped. This is where it lands.
  //
  // Its own component so CollabContextDrawer.svelte stays inside its cap once
  // the F14 re-poll landed there too.
  //
  // NEWEST FIRST, and only a handful. The engine's order is oldest-first (it is
  // a log); a reader opening a drawer wants the most recent thing at the top,
  // and twenty rows would bury the prompt capture under them.
  //
  // ABSENT and EMPTY are DIFFERENT facts and are not folded: an older engine
  // sends no log at all, an agent that has done nothing has an empty one. The
  // caller distinguishes them; this file renders whichever it was given and
  // never invents a row.
  import type { CollabActivityEntry } from '../../src/acpExtTypes';

  interface Props {
    /** ABSENT on an older engine — see the header. */
    entries?: CollabActivityEntry[];
  }
  let { entries }: Props = $props();

  /** How many rows a glance is worth. */
  const SHOWN = 5;
  const rows = $derived([...(entries ?? [])].slice(-SHOWN).reverse());
</script>

<div class="ctx-act" aria-label="Recent activity">
  {#if rows.length === 0}
    <!-- Says nothing was recorded, which is a fact. It deliberately does NOT
         say the agent has been idle — that is a different claim, and one this
         component has no evidence for. -->
    <span class="ctx-act-none">No activity recorded for this agent yet.</span>
  {:else}
    <ul class="ctx-act-list">
      {#each rows as e, i (`${e.messageId}:${i}`)}
        <li class="ctx-act-row">
          <!-- The kind is carried in the WORD, not in colour alone — the same
               rule TaskBoard's state chips follow. -->
          <span class="ctx-act-kind" data-kind={e.kind}>{e.kind}</span>
          <span class="ctx-act-text">{e.text}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ctx-act { padding: 6px 12px 0; }
  .ctx-act-none { font-size: 10px; font-style: italic; color: var(--og-text-muted); }
  .ctx-act-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ctx-act-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 10px;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .ctx-act-kind {
    flex: 0 0 auto;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 9px;
    color: var(--og-text-secondary);
  }
  .ctx-act-kind[data-kind='thought'] { color: var(--og-chat); }
  .ctx-act-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
</style>
