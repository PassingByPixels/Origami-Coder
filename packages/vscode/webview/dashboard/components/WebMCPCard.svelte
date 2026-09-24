<script lang="ts">
  // ONE Web MCP site card, extracted from WebMCPSection.svelte when the inline
  // editor took that file over its architecture cap.
  //
  // WHAT THIS CARD IS FOR: everything the user and the agent know about a site
  // before anyone opens it. `webmcp_list` gives the model the name, the address
  // and the purpose; this card shows the same three, so what is on screen and
  // what the model reads cannot drift. Edit rewrites the name and the purpose —
  // the model's whole description of the site.
  //
  // NOT EDITABLE HERE: the address (it is the entry's identity — a new address
  // is a different site, which is Add plus Remove) and the agent NOTES, which
  // are banked by the engine's webmcp_note and shown read-only with their
  // staleness stated, because a page re-publishes its tools on every join.
  //
  // WHICH STATE LIVES WHERE. The armed-remove and open-editor flags are the
  // SECTION's, one per list, so two cards can never be armed at once and a
  // fresh read of the file closes whatever was open. The draft text is this
  // card's own: it is seeded from the row when its own Edit is clicked, and it
  // is thrown away with the card.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  const vscode = getVsCodeApi();

  interface Site {
    url: string;
    name: string;
    purpose: string;
    addedAt: number;
    notes?: string;
    lastLaunched?: number;
  }

  let {
    site,
    confirming = false,
    editing = false,
    onArm,
    onEdit,
  }: {
    site: Site;
    confirming?: boolean;
    editing?: boolean;
    /** Arm/disarm THIS row's remove confirm; null disarms the list. */
    onArm: (url: string | null) => void;
    /** Open/close the inline editor on THIS row; null closes it. */
    onEdit: (url: string | null) => void;
  } = $props();

  let draftName = $state('');
  let draftPurpose = $state('');

  function begin(): void {
    draftName = site.name;
    draftPurpose = site.purpose;
    onEdit(site.url);
  }

  function save(): void {
    vscode.postMessage({
      type: 'webmcpEdit',
      url: site.url,
      name: draftName.trim(),
      purpose: draftPurpose.trim(),
    });
    // NOT closed here: the host re-reads the file and re-posts it, and the
    // section closes the editor on that. Closing now would show the old text as
    // if it had been saved.
  }

  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 10);
</script>

<div class="wmcp-card">
  {#if editing}
    <input class="wmcp-edit-input" bind:value={draftName} placeholder="short name" aria-label="Edit site name" />
    <textarea
      class="wmcp-edit-input wmcp-edit-text"
      rows="3"
      bind:value={draftPurpose}
      placeholder="what it is for — the reason an agent would open it"
      aria-label="Edit site description"
    ></textarea>
    <div class="wmcp-detail"><code>{site.url}</code></div>
    <div class="wmcp-edit-hint">
      This is what an agent reads about the site in <code>webmcp_list</code>. The address names the site, so it is
      not editable, and the agent's own notes are left alone.
    </div>
    <div class="wmcp-actions">
      <button class="wmcp-btn" onclick={save}>Save</button>
      <button class="wmcp-btn" onclick={() => onEdit(null)}>Cancel edit</button>
    </div>
  {:else}
    <div class="wmcp-head">
      <span class="wmcp-name" title={site.name}>{site.name}</span>
      {#if site.lastLaunched}<span class="wmcp-seen">opened {stamp(site.lastLaunched)}</span>{/if}
    </div>
    {#if site.purpose}<div class="wmcp-purpose" title={site.purpose}>{site.purpose}</div>{/if}
    <div class="wmcp-detail"><code>{site.url}</code></div>
    {#if site.notes}
      <div class="wmcp-notes">
        <span class="wmcp-notes-label">agent notes (advisory — re-checked on every join)</span>
        {site.notes}
      </div>
    {/if}
    <div class="wmcp-actions">
      <button class="wmcp-btn" onclick={() => vscode.postMessage({ type: 'webmcpOpen', url: site.url })}>Open</button>
      <button class="wmcp-btn" onclick={begin}>Edit</button>
      {#if confirming}
        <button
          class="wmcp-btn wmcp-danger"
          onclick={() => { vscode.postMessage({ type: 'webmcpRemove', url: site.url }); onArm(null); }}
        >
          Confirm remove
        </button>
        <button class="wmcp-btn" onclick={() => onArm(null)}>Cancel</button>
      {:else}
        <button class="wmcp-btn" onclick={() => onArm(site.url)}>Remove</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* FIXED CARD SIZE — the Origami Folio entry (short one-line purpose, no
     notes) is the reference: 10px padding top/bottom, 3 gaps of 6px between
     head/purpose/detail/actions, a 1-line name (12px / line-height 1.3 =~
     16px), a 2-line clamped purpose (11px / line-height 1.4 x2 =~ 31px), the
     url line (10px / line-height 1.4 =~ 14px) and the action row (~20px with
     its own margin-top). 20 + 18 + 16 + 31 + 14 + 20 = 119px; min-height
     below rounds that up for headroom. A card with agent notes can still grow
     past this floor — the notes box has its own 8-line scroll ceiling
     (below), which is a separate, already-solved problem from a description
     that never stopped growing the whole card. */
  .wmcp-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; min-height: 130px; box-sizing: border-box; }
  .wmcp-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .wmcp-name { font-weight: 600; font-size: 12px; line-height: 1.3; color: var(--og-text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
  /* Same pill weight as the server cards' .mcp-type/.mcp-source next door — one
     badge rhythm across both halves of the pane. */
  .wmcp-seen { margin-left: auto; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 8px; font-weight: 600; background: var(--og-btn-bg); color: var(--og-text-muted); }
  /* Clamped at 2 lines, matching the Folio reference's own one-line purpose
     with room to spare — a 600-character purpose stops at the same 2 lines
     instead of stretching the card; the full text still reaches the user (and
     the model, unaffected) through the title tooltip above. */
  .wmcp-purpose { font-size: 11px; line-height: 1.4; color: var(--og-text-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .wmcp-detail code { font-size: 10px; line-height: 1.4; color: var(--og-text-muted); word-break: break-all; }
  /* Capped at 8 lines of its own line-height, or one site with a long note
     stretches the whole card down the page and every other card's top with
     it (the grid's align-items: start below stops that spreading, but the
     card itself still needs a ceiling). calc() off the real line-height, not
     a guessed px figure, so the two stay in lockstep if either changes. */
  .wmcp-notes { font-size: 10px; line-height: 1.45; color: var(--og-text-secondary); border-left: 2px solid var(--og-border); padding-left: 7px; word-break: break-word; max-height: calc(1.45em * 8); overflow-y: auto; }
  .wmcp-notes-label { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--og-text-muted); margin-bottom: 2px; }

  .wmcp-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
  .wmcp-btn { background: var(--og-btn-bg); border: 1px solid var(--og-border); color: var(--og-text); border-radius: 4px; cursor: pointer; padding: 2px 7px; font-size: 10px; white-space: nowrap; font-family: inherit; }
  .wmcp-btn:hover { background: var(--og-btn-hover); }
  .wmcp-danger { border-color: var(--og-error); color: var(--og-error-text); background: var(--og-error-soft); }

  /* The inline editor wears the add box's input skin: one pane, one product. */
  .wmcp-edit-input { background: var(--og-input-bg); border: 1px solid var(--og-input-border); color: var(--og-text); border-radius: 4px; padding: 3px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; width: 100%; box-sizing: border-box; }
  .wmcp-edit-text { resize: vertical; line-height: 1.45; }
  .wmcp-edit-hint { font-size: 10px; line-height: 1.5; color: var(--og-text-muted); }

  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; }
</style>
