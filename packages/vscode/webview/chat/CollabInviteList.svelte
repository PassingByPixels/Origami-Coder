<script lang="ts">
  // The invite candidates as a MULTI-SELECT list. Extracted from
  // CollabRosterPicker.svelte (132 of its 135-line cap) so report 1.3's
  // multi-select and 1.4's model/health columns could both land, and so the
  // SETUP CARD can mount the same control rather than growing a second one.
  //
  // WHY A PICK NO LONGER COMMITS. The old popover invited on the click and then
  // shut itself, so a three-agent room cost six clicks. Selection is held here
  // and sent once, by `commit` — which the setup card's Next calls through
  // `bind:this` (W8), so both surfaces share ONE send. `picked` clears on that
  // send: the parent re-polls, the invited leave the list, a stale tick resends.
  //
  // WHAT A ROW ANSWERS (report 1.4 / S6). Each row carries the pin and the
  // verdict on it, so a user no longer finds out at the agent's first turn that
  // its provider is down. The verdict's WORDING lives in collabHealth.ts with
  // the rule, so the two surfaces that draw it cannot drift. A candidate that
  // needs a model is still PICKABLE — unpinned is the shipped seeds' ordinary
  // state, not a fault; only an unloadable def is disabled.
  //
  // S9 — THE DEAD END, closed. This list is where you find out a room has no
  // bot worth inviting, and that was the end of the road. The link below opens
  // the board's Bots section; it is NOT an inline editor, because a room is
  // where bots work and a second editing surface would be a second writer.
  import { getVsCodeApi } from './../shared/vscodeApi';
  import { collabShortName } from './collabNames';
  import { healthLabel } from './collabHealth';
  import type { InviteCandidate } from './collabInvite';

  interface Props {
    candidates: InviteCandidate[];
    /** Called ONCE per commit, with every slug picked. */
    onInvite: (slugs: string[]) => void;
    showInvite?: boolean; // OFF where the mounting surface commits — see above.
  }
  let { candidates, onInvite, showInvite = true }: Props = $props();

  // Posted from the LEAF, the way ToolCard.svelte and InstructionRowActions
  // already do: both mounting parents (CollabRosterPicker 132/135,
  // CollabSetupCard) and CollabPane (437/440) are at or near their caps, and a
  // prop chained through three of them to carry a static "open that view"
  // request would spend their room on nothing the room's state can affect.
  const vscode = getVsCodeApi();
  function manageBots() {
    // TWO messages, both needed: the first opens or reveals the board tab, the
    // second asks it for the Bots section. botsManager.ts holds the request
    // until a board reports itself ready, so the order does not matter and a
    // board opening for the first time still lands on Bots.
    vscode.postMessage({ type: 'openAgentManager' });
    vscode.postMessage({ type: 'openBotsSection' });
  }

  let picked = $state<string[]>([]);

  const pickable = $derived(candidates.filter((c) => !c.disabled).map((c) => c.slug));
  /** The commit order is the LIST's order, not the click order, and dropped
   *  candidates are filtered out — a slug that left the list between a tick and
   *  the Invite click must not be sent. */
  const chosen = $derived(pickable.filter((s) => picked.includes(s)));

  function toggle(c: InviteCandidate) {
    if (c.disabled) return;
    picked = picked.includes(c.slug) ? picked.filter((s) => s !== c.slug) : [...picked, c.slug];
  }
  export function commit(): void {
    if (chosen.length === 0) return;
    onInvite(chosen);
    picked = [];
  }
</script>

<div class="il">
  {#if candidates.length === 0}
    <div class="il-empty">No bots available to invite.</div>
  {:else}
    <div class="il-rows" role="group" aria-label="Invitable agents">
      {#each candidates as c (c.slug)}
        {@const warn = healthLabel(c.health)}
        <button
          class="il-row"
          class:disabled={c.disabled}
          role="checkbox"
          aria-checked={picked.includes(c.slug)}
          disabled={c.disabled}
          title={c.reason ? `${c.displayName} — ${c.reason}` : c.displayName}
          onclick={() => toggle(c)}
        >
          <span class="il-box" class:on={picked.includes(c.slug)} aria-hidden="true"></span>
          <span class="il-main">
            <span class="il-name">{collabShortName(c.slug, c.displayName)}</span>
            <span class="il-slug">{c.slug}</span>
          </span>
          <span class="il-meta">
            {#if c.model}<span class="il-model">{c.model}</span>{/if}
            {#if warn}<span class="il-warn" class:dead={c.health.kind === 'dead'}>{warn}</span>{/if}
            {#if c.disabled && c.reason}<span class="il-reason">{c.reason}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
  <!-- OUTSIDE the {#if}, deliberately: an EMPTY list is the sharpest form of
       the dead end this closes, and that is exactly the branch where a link
       tucked in beside the Invite button would not render. -->
  <div class="il-actions">
    <button class="il-manage" title="Open the Bots section — create a bot, or change what an existing one may do" onclick={manageBots}>Manage bots…</button>
    {#if showInvite && candidates.length > 0}
      <button
        class="il-commit"
        disabled={chosen.length === 0}
        title={chosen.length === 0 ? 'Pick at least one bot above' : `Invite ${chosen.length} bot${chosen.length === 1 ? '' : 's'}`}
        onclick={commit}
      >Invite{chosen.length ? ` (${chosen.length})` : ''}</button>
    {/if}
  </div>
</div>

<style>
  .il { display: flex; flex-direction: column; min-width: 0; }
  .il-empty {
    padding: 6px 8px;
    font-size: 10px;
    font-style: italic;
    color: var(--og-text-muted);
  }
  .il-rows { display: flex; flex-direction: column; max-height: 200px; overflow-y: auto; }
  .il-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    background: none;
    border: none;
    border-radius: 4px;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }
  .il-row:hover:not(.disabled) { background: var(--og-btn-bg); }
  .il-row.disabled { opacity: 0.5; cursor: default; }
  /* The tick is a square, not a ring: a ring in this product means "an agent is
     working" and must not be borrowed for a selection. */
  .il-box { flex: 0 0 auto; width: 11px; height: 11px; border: 1px solid var(--og-border); border-radius: 3px; align-self: center; }
  .il-box.on { background: var(--og-accent); border-color: var(--og-accent); }
  .il-main { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .il-name { font-size: 11px; color: var(--og-text); }
  .il-slug { font-size: 9px; font-family: var(--vscode-editor-font-family, monospace); color: var(--og-text-muted); }
  .il-meta { display: flex; align-items: baseline; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
  .il-model {
    font-size: 9px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-secondary);
  }
  /* "needs a model" is a prompt, "provider unreachable" is a warning — the same
     split CollabBanners draws between its notice and its error. */
  .il-warn { font-size: 9px; color: var(--og-text-muted); }
  .il-warn.dead { color: var(--og-error-text); }
  .il-reason { flex: 1 1 100%; font-size: 9px; font-style: italic; color: var(--og-text-muted); text-align: right; }
  /* `space-between`, so the escape hatch sits left and the commit stays right —
     the destructive-rightmost / primary-elsewhere order this board uses. */
  .il-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 0; }
  /* A LINK, not a button: it leaves this surface rather than doing something to
     it, so it must not compete with Invite for the eye. */
  .il-manage { font-size: 10px; padding: 3px 4px; background: none; border: none; color: var(--og-text-muted); text-decoration: underline; cursor: pointer; font-family: inherit; }
  .il-manage:hover { color: var(--og-text); }
  .il-commit {
    font-size: 10px;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid var(--og-accent);
    background: transparent;
    color: var(--og-accent);
    cursor: pointer;
    font-family: inherit;
  }
  .il-commit:hover:not(:disabled) { background: color-mix(in srgb, var(--og-accent) 16%, transparent); }
  .il-commit:disabled { opacity: 0.45; cursor: default; border-color: var(--og-border); color: var(--og-text-muted); }
</style>
