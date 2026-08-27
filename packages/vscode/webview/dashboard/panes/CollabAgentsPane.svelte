<script lang="ts">
  // Collabs M2 — the Agents board's agent-definition views. Since t-kgtr6c this
  // pane is a TWO-TAB shell rather than one list:
  //
  //   Collab      — the agent defs a collab can be built from (unchanged)
  //   Vision      — vision profiles: the agent a chat hands an image to when its
  //                 own model cannot see one
  //
  // The tabs are INTERNAL, not two more entries on the board's nav rail. Both
  // are "agent definitions in one directory"; splitting them across the rail
  // would put two sibling views a rail-width apart and make the rail the place
  // you learn that vision profiles exist.
  //
  // A THIRD TAB, SubAgents, shipped in round 2 and was REMOVED in round 3: it
  // MIRRORED the chat model picker's sub-agent override, and wrote to the ACTIVE
  // chat rather than to the board you were looking at — the one surface that
  // felt global was the one that could not be. The chat's picker is the SOLE
  // surface now; visionAgents.test.ts guards that no second sender comes back.
  //
  // THE LIST READS THE FILESYSTEM (collabAgentCrud), not `collab_agents`: the
  // wire only carries slug/displayName/model and the form needs persona,
  // permission and steps too. The engine re-scans defs on every collab-facing
  // call (collab/acp.ts): saved defs are live at once; only DELETES need a restart.
  //
  // The FORM left this file for CollabAgentForm.svelte when the tabs arrived —
  // the pane was at 378 of its 380-line cap, and the ratchet's remedy is
  // extraction. It paid immediately: the Vision tab edits a profile with the
  // SAME form rather than a second copy of it. D7: the Collab roster also
  // carries ARCHETYPE REFS (architect/ask/...) as read-only cards after the
  // collab ones; editing lives in the card itself.
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { onMount } from 'svelte';
  import CollabAgentCard from '../components/CollabAgentCard.svelte';
  import CollabAgentForm from '../components/CollabAgentForm.svelte';
  import ArchetypeAgentCard from '../components/ArchetypeAgentCard.svelte';
  import BotMemoryPanel from '../components/BotMemoryPanel.svelte';
  import { allToolKeys } from '../../../src/dashboard/botTools';
  import type { CollabAgentDef, ArchetypeDefRef } from '../../../src/dashboard/collabAgentCrud';

  const vscode = getVsCodeApi();

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }

  type Tab = 'collab' | 'vision';
  // BOTS is this section's name as of W4 — a def IS a bot, and "collab agent"
  // named it after one of the three places it can run. The tab id stays
  // `collab` and the wire keeps every `collabAgentDef*` message type: the
  // rename is DISPLAY, and renaming either would reset saved state and break a
  // contract the host and three other panes already speak.
  const TABS: { id: Tab; label: string; title: string }[] = [
    { id: 'collab', label: 'Bots', title: 'Bots — the agent definitions a session, a collab or a bot chat can run' },
    { id: 'vision', label: 'Vision Agents', title: 'Vision profiles — the agent a chat hands an image to when its own model cannot see one' },
  ];

  let tab = $state<Tab>('collab');
  let defs = $state<CollabAgentDef[]>([]);
  let visionDefs = $state<CollabAgentDef[]>([]);
  let archetypes = $state<ArchetypeDefRef[]>([]);
  let modelOptions = $state<ModelOpt[]>([]);
  let providerStatus = $state<ProviderStat[]>([]);
  /** Per-slug fact counts from the host — the one card fact that is not in the
   *  def file, because whether a bot has REMEMBERED anything lives in its store. */
  let memoryFacts = $state<Record<string, number>>({});
  /** Live tool ids for the bot's tool checklist, off the Tools pane's own
   *  `list_tools` wire. Empty falls back to this build's shipped mirror. */
  let toolCatalog = $state<string[]>([]);
  /** The open memory viewer, or null. Read-only — a bot's store is written by
   *  the bot, and the only edit this board offers is the whole-store wipe. */
  let memoryView = $state<{ slug: string; facts: number; text: string; dir: string } | null>(null);
  let error = $state('');
  let loaded = $state(false);
  /** Slugs being started now. A bot chat is PROVISIONAL (sessionAnnounce.ts) and
   *  the wait is a ~5s engine boot, so the card is the click's only answer; a
   *  LIST because two may start at once and the reply names which one it is. */
  let starting = $state<string[]>([]);

  /** '' = closed, 'new' = the create form, anything else = editing that slug.
   *  Cleared on every tab switch: an open editor is about ONE list, and leaving
   *  it mounted under another tab is a Save that writes into the wrong one. */
  let editing = $state('');
  let draft = $state<CollabAgentDef>(blank('collab'));
  const creating = $derived(editing === 'new');
  const kind = $derived<'collab' | 'vision'>(tab === 'vision' ? 'vision' : 'collab');
  const list = $derived(tab === 'vision' ? visionDefs : defs);

  // Reference agents render COLLAPSED on every mount (UAT: "make reference
  // agents collapsible and grouped by default, they look cluttered") — six
  // file-backed definitions with no live state of their own, so a header with
  // just the count is the whole story. Local view state only, like `editing`:
  // no getState round-trip, so it resets collapsed next time too.
  let referenceOpen = $state(false);

  function blank(of: 'collab' | 'vision'): CollabAgentDef {
    // EVERY TOOL TICKED (W9 owner ruling, replacing the W6 Worker default): a new
    // bot starts able and the user takes away, because taking away is the edit a
    // checklist can actually show. `toolCatalog` and not the shipped mirror — a
    // bot born on the mirror while the engine offers a newer tool would open with
    // a row already unticked, contradicting the state on screen.
    // A VISION PROFILE is `vision: true` from the start — it is the one def kind
    // where the blind default would be silently useless — and it carries no bot
    // contract and no tick set: it takes no turn, so neither would mean anything.
    return of === 'vision'
      ? { slug: 'vision-', description: '', model: '', glyph: '', persona: '', preset: 'observer', customPermission: '', steps: '', vision: true, visionProfile: true, bot: {} }
      : { slug: 'collab-', description: '', model: '', glyph: '', persona: '', preset: 'worker', customPermission: '', tools: allToolKeys(toolCatalog), steps: '', vision: false, visionProfile: false, bot: {} };
  }

  function pickTab(next: Tab) {
    tab = next;
    editing = '';
    error = '';
  }
  function startNew() {
    editing = 'new';
    error = '';
    draft = blank(kind);
  }
  function startEdit(d: CollabAgentDef) {
    editing = d.slug;
    error = '';
    // A COPY, and `bot`/`tools` copied TOO — a shallow spread would share those
    // objects with the list behind the form, so an abandoned edit would already
    // have changed the card it was opened from.
    draft = { ...d, bot: { ...(d.bot ?? {}) }, ...(d.tools ? { tools: [...d.tools] } : {}) };
  }
  /**
   * `$state.snapshot`, and it is the whole of W6's model-pin bug. `draft` is a
   * `$state` rune, so every nested value read off it is a PROXY; `{ ...draft }`
   * flattened only the top level, which was fine until the def grew objects
   * (`bot`, `tools`). A webview postMessage STRUCTURED-CLONES, and that throws
   * DataCloneError on a Proxy — so the post never left the webview and the card
   * came back still warning about the model that had just been picked. The
   * autopsy, and the test that catches it, are in botsPane.test.ts. */
  function save() {
    if (!draft.slug) return;
    vscode.postMessage({ type: 'saveCollabAgentDef', def: $state.snapshot(draft) });
    editing = '';
  }
  /** A chat running AS one bot — its permissions, its skills, its model, its
   *  own memory. The host owns session creation; this only names the bot, with
   *  BOTH names: the slug the engine knows it by, and the name the card draws,
   *  which is what the chat tab reads. */
  function startSession(slug: string, displayName: string) {
    if (starting.includes(slug)) return; // one engine child per start — a second click is a second engine
    error = ''; starting = [...starting, slug];
    vscode.postMessage({ type: 'startBotSession', slug, displayName });
  }

  onMount(() => {
    const onMsg = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'collabAgentDefs') {
        defs = Array.isArray(msg.defs) ? msg.defs : [];
        // Absent (not empty) leaves the list alone: an older host that does not
        // send `visionDefs` must not blank a list it knows nothing about.
        if (Array.isArray(msg.visionDefs)) visionDefs = msg.visionDefs;
        archetypes = Array.isArray(msg.archetypes) ? msg.archetypes : archetypes;
        // Same absent-leaves-it-alone rule, for the same reason.
        if (msg.memoryFacts && typeof msg.memoryFacts === 'object') memoryFacts = msg.memoryFacts;
        error = typeof msg.error === 'string' ? msg.error : '';
        loaded = true;
      } else if (msg.type === 'modelOptions') {
        modelOptions = Array.isArray(msg.options) ? msg.options : [];
      } else if (msg.type === 'providerStatus') {
        providerStatus = Array.isArray(msg.providers) ? msg.providers : [];
      } else if (msg.type === 'toolsData') {
        // The Tools pane's own wire, reused rather than a second one: this is
        // the ENGINE's list, so a user-file or plugin tool is tickable the
        // moment the engine reports it. An empty answer (no chat open) falls
        // back to the form's shipped mirror.
        toolCatalog = Array.isArray(msg.tools) ? msg.tools.map((t: { id?: string }) => String(t?.id ?? '')).filter(Boolean) : [];
      } else if (msg.type === 'botSessionResult') {
        // A refusal must SAY so: a Start button that silently does nothing is
        // indistinguishable from an engine that is still starting.
        error = typeof msg.error === 'string' ? msg.error : '';
        // BOTH outcomes end the wait (the host posts this on ok too), so the button comes back and a refusal can be retried.
        starting = starting.filter((s) => s !== msg.slug);
      } else if (msg.type === 'botMemoryData') {
        memoryView = { slug: String(msg.slug ?? ''), facts: Number(msg.facts ?? 0), text: String(msg.text ?? ''), dir: String(msg.dir ?? '') };
        // A clear answers with the SAME payload, so the count the cards show is
        // corrected from the store the host actually read back, not optimistically.
        memoryFacts = { ...memoryFacts, [String(msg.slug ?? '')]: Number(msg.facts ?? 0) };
      }
    };
    window.addEventListener('message', onMsg);
    vscode.postMessage({ type: 'listCollabAgentDefs' });
    vscode.postMessage({ type: 'requestModels' });
    vscode.postMessage({ type: 'requestProviderStatus' });
    vscode.postMessage({ type: 'toolsRequest' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<div class="ca-pane">
  <div class="ca-nav">
    {#each TABS as t (t.id)}
      <button class="ca-btn" class:picked={tab === t.id} title={t.title} onclick={() => pickTab(t.id)}>{t.label}</button>
    {/each}
  </div>

  <div class="ca-head">
    <span class="ca-title">{tab === 'vision' ? 'Vision profiles' : 'Bots'}</span>
    <button class="ca-btn primary" onclick={startNew}>＋ New {tab === 'vision' ? 'vision profile' : 'bot'}</button>
    <button class="ca-btn" onclick={() => vscode.postMessage({ type: 'listCollabAgentDefs' })}>Refresh</button>
  </div>

  <div class="ca-notice">
    {#if tab === 'vision'}
      A profile does nothing until a chat turns it on — the eye button beside the composer. It is then used only when
      that chat's own model cannot see and an image is attached.
    {:else}
      A bot runs in three places: its own chat (Start session), a collab room, or as a sub-agent. Deleting one still
      needs an engine restart (reload the window) — new or edited bots are ready right away.
    {/if}
  </div>

  {#if error}<div class="ca-error">{error}</div>{/if}

  <!-- The memory VIEWER: read-only, because a bot's store is written by the bot
       and the only edit this board offers is the whole-store wipe in the form. -->
  {#if memoryView}
    <BotMemoryPanel {...memoryView} onClose={() => (memoryView = null)} />
  {/if}

  <!-- KEYED on which def is open: the form seeds a new agent's persona at
       MOUNT, so switching from the create form straight to an Edit (or back)
       has to be a new mount or the next form opens showing the last one's
       seed state. -->
  {#if editing}
    {#key editing}
      <CollabAgentForm bind:draft {creating} {kind} {modelOptions} {providerStatus} {toolCatalog}
        memoryFacts={memoryFacts[draft.slug] ?? 0}
        onViewMemory={() => vscode.postMessage({ type: 'botMemoryRead', slug: draft.slug })}
        onClearMemory={() => vscode.postMessage({ type: 'botMemoryClear', slug: draft.slug })}
        onSave={save} onCancel={() => (editing = '')} />
    {/key}
  {/if}

  <div class="ca-list">
    {#if !loaded}
      <div class="ca-empty">Reading the agent directory…</div>
    {:else if list.length === 0 && (tab === 'vision' || archetypes.length === 0)}
      <div class="ca-empty">
        {tab === 'vision'
          ? 'No vision profiles yet. Create one and pin it to a model that can see — then a chat on a text-only model can still be shown a screenshot.'
          : 'No bots yet. Create one above — it can then take a chat of its own, or join a collab.'}
      </div>
    {:else}
      <!-- CARDS in a GRID: a def is CHOSEN from this list by comparing it with
           its neighbours, and the single column this replaces turned that
           comparison into a scroll. Each card still labels its own facts. -->
      <!-- `onStart` only on the Bots tab: a vision profile takes no turn, so a
           session running "as" one would have nothing to run. -->
      {#each list as d (d.slug)}
        <CollabAgentCard def={d} memoryFacts={memoryFacts[d.slug] ?? 0} onEdit={startEdit}
          onDelete={(slug) => vscode.postMessage({ type: 'deleteCollabAgentDef', slug })}
          starting={starting.includes(d.slug)} onStart={tab === 'vision' ? undefined : startSession} />
      {/each}
      {#if tab === 'collab' && archetypes.length > 0}
        <!-- Collapsed by default: a single header row (label + count), never
             auto-expanded — see `referenceOpen` above for why. -->
        <button class="ca-section ca-section-toggle" aria-expanded={referenceOpen}
          onclick={() => (referenceOpen = !referenceOpen)}>
          <span class="ca-section-chev" aria-hidden="true">{referenceOpen ? '▾' : '▸'}</span>
          Reference agents ({archetypes.length})
        </button>
        {#if referenceOpen}
          {#each archetypes as a (a.slug)}
            <ArchetypeAgentCard def={a} {modelOptions} {providerStatus} onOpen={(path) => vscode.postMessage({ type: 'openAbsoluteFile', path })}
              onSetModel={(slug, model) => vscode.postMessage({ type: 'collabArchetypeSetModel', slug, model })} />
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .ca-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    background: var(--og-bg);
    color: var(--og-text);
  }
  /* The sub-nav sits ABOVE the view's own head row rather than beside its
     title: which of the three lists you are looking at is the first question,
     and a tab tucked in beside a title reads as another action button. */
  .ca-nav { display: flex; gap: 4px; padding: 10px 12px 0; flex-wrap: wrap; }
  .ca-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 6px;
  }
  .ca-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--og-text-secondary);
    flex: 1 1 auto;
  }
  .ca-btn {
    font-size: 11px;
    padding: 4px 9px;
    background: var(--og-btn-bg);
    color: var(--og-text-secondary);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
  }
  .ca-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .ca-btn.primary { color: var(--og-text); border-color: var(--og-chat); }
  .ca-btn.picked { color: var(--og-text); border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }

  .ca-notice {
    margin: 0 12px 8px;
    padding: 6px 9px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--og-text);
    background: var(--og-warning-soft);
    border-left: 2px solid var(--og-warning);
    border-radius: 4px;
  }
  .ca-error {
    margin: 0 12px 8px;
    padding: 6px 9px;
    font-size: 11px;
    color: var(--og-error-text);
    background: var(--og-error-soft);
    border-radius: 4px;
  }

  /* The memory viewer's own styles live in BotMemoryPanel.svelte — a panel
     above the list rather than inside a card, because a store is prose and a
     210px card cannot hold it. */

  /* CARD GRID: a def is CHOSEN by comparing it against its neighbours, and a
     full-width column of short cards makes that a scroll. 210px min (D7: down
     from 280 — the bigger 32px glyph paid for the width the cards gave up). */
  .ca-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; padding: 0 12px 12px; align-content: start; }
  .ca-section { grid-column: 1 / -1; margin: 4px 0 -2px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  /* Same collapsible-header idiom as the Folds board's Merged section
     (AgentManagerPane.svelte's .am-merged-head/.am-merged-chev): a button
     reset over the existing `.ca-section` label styling, so collapsed and
     expanded read as the same label with only a chevron and a count added. */
  .ca-section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: transparent;
    color: inherit;
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 2px 3px;
    font-family: inherit;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }
  .ca-section-toggle:hover { color: var(--og-text); border-color: var(--og-border); }
  .ca-section-chev { width: 9px; flex: none; }
  .ca-empty {
    /* A message is not a card: it spans the whole grid rather than being
       squeezed into one 280px column beside empty space. */
    grid-column: 1 / -1;
    padding: 14px 12px;
    font-size: 12px;
    font-style: italic;
    line-height: 1.6;
    color: var(--og-text-muted);
  }
</style>
