<script lang="ts">
  // Folds Board D7 — ONE archetype reference card (architect/ask/debug/
  // orchestrator/scout/cartographer). A REFERENCE, not an editable def: no
  // persona box, no delete, no CollabAgentCard-style Edit form. The only
  // thing a user changes here is the pinned MODEL — a targeted single-line
  // frontmatter edit (archetypeRefs.ts::setArchetypeModel) — plus opening the
  // real .md file for anything deeper than that.
  //
  // UAT round 2 item 3: scout is NOT an exception any more. What makes it
  // security-load-bearing is its PERMISSION block (ask/architect delegate to
  // it by NAME for the S12 task-laundering fix), and a `model:` line cannot
  // re-grant a tool — so it gets Set model like every other archetype. What
  // stays true — and is SCOUT-ONLY — is that ensureArchetypes RECONCILES a
  // modified scout.md back to the shipped read-only agent (the other five keep
  // user edits forever): the managed hint on the mode badge discloses exactly
  // that, and its tooltip now says so in full.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import AgentModelSelect from './AgentModelSelect.svelte';
  import { seedName } from './collabPersonaSeed';
  import type { ArchetypeDefRef } from '../../../src/dashboard/collabAgentCrud';

  interface ModelOpt { value: string; name: string }
  interface ProviderStat { id: string; name: string; live: boolean; flavor?: 'lmstudio' | 'ollama' | 'other' }
  interface Props {
    def: ArchetypeDefRef;
    modelOptions: ModelOpt[];
    providerStatus: ProviderStat[];
    onSetModel: (slug: string, model: string) => void;
    onOpen: (path: string) => void;
  }
  let { def, modelOptions, providerStatus, onSetModel, onOpen }: Props = $props();

  // Local, not pane state — mirrors CollabAgentCard's own `confirming`: no
  // view outside this card ever needs to know which one has its picker open.
  let picking = $state(false);

  // Same rule as CollabAgentCard: an @handle that only restates the name is a
  // labelled row spent on nothing. Every shipped archetype's slug IS its name
  // (Architect/@architect), so this is normally blank — it earns ink only for
  // a hand-added file whose two differ, and then inline, where a mention reads.
  const name = $derived(seedName(def.slug));
  const handle = $derived(def.slug === name.toLowerCase() ? '' : def.slug);
</script>

<div class="ar-card">
  <div class="ar-card-head">
    <span class="ar-card-glyph"><ArchetypeGlyph id={def.slug} size={32} /></span>
    <span class="ar-card-name" title={handle ? `${name} @${handle}` : name}>{name}{#if handle}<span class="ar-handle mono">@{handle}</span>{/if}</span>
    <!-- The managed hint rides the MODE badge instead of standing beside it as
         a second chip: it is a caveat about this file, not a third thing the
         agent is, and as its own badge it shouted louder than the mode. -->
    <span class="ar-chip" class:managed={def.managed} title={def.managed ? 'security anchor: ask/architect delegate to scout by NAME, so an upgrade restores this file even if hand-edited — a model pin lasts until then' : ''}
      >{def.mode}{#if def.managed}<span class="ar-managed">· managed</span>{/if}</span>
  </div>

  <div class="ar-card-desc">{def.description || 'No description.'}</div>

  <div class="ar-facts">
    <div class="ar-fact">
      <span class="af-k">Model</span>
      <span class="af-v mono" class:hint={!def.model}>{def.model || 'engine default — set one'}</span>
    </div>
  </div>

  <!-- UAT round 1 item 7: Set model + Open file live here, out of the head.
       The picker opens IN the "Set model" button's own spot, so it reads as
       anchored, and stays normal-flow inside the card rather than an overlay
       that could clip against the board grid. Round 2 item 3: same button
       metrics and the same primary-left order as CollabAgentCard's footer —
       there is no destructive action here, so nothing is pushed right. -->
  <div class="ar-card-footer">
    {#if picking}
      <AgentModelSelect
        options={modelOptions}
        providerStatus={providerStatus}
        value={def.model ?? ''}
        onchange={(v) => { onSetModel(def.slug, v); picking = false; }}
        placeholder="Engine default"
        compact={true}
      />
      <button class="ar-btn" onclick={() => (picking = false)}>Close</button>
    {:else}
      <button class="ar-btn" onclick={() => (picking = true)}>Set model</button>
    {/if}
    <button class="ar-btn" onclick={() => onOpen(def.path)}>Open file</button>
  </div>
</div>

<style>
  /* UAT round 2 item 3: FLEX COLUMN, and the same 7px 9px padding the collab
     card took when the glyph doubled (18 -> 32). Both kinds sit in ONE grid, so
     a grid item already stretches to its row's height - the column plus the
     footer's `margin-top: auto` is what makes that height do something: the
     buttons land on ONE line across the row, however long each description. */
  .ar-card { display: flex; flex-direction: column; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 7px 9px; }
  .ar-card-head { display: flex; align-items: center; gap: 7px; }
  .ar-card-glyph { display: flex; color: var(--og-crane); flex: 0 0 auto; }
  /* flex:1 1 auto + min-width:0: the name is the item that shrinks when the
     card is narrow, not the mode chip beside it — ellipsis past the card's
     real width, never a fixed character cut. */
  .ar-card-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  /* Inside the name span, so the pair ellipsises as one string. */
  .ar-handle { margin-left: 5px; font-size: 11px; font-weight: 400; text-transform: none; color: var(--og-text-muted); }
  .ar-chip { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-muted); border: 1px solid transparent; flex: 0 0 auto; }
  /* NOT the warning-soft fill the standalone badge had: this is a caveat about
     the FILE, so it tints the mode badge's edge and adds a short suffix; the
     sentence that explains it is one hover away, on the badge's title. */
  .ar-chip.managed { color: var(--og-warning-text); border-color: var(--og-warning); }
  .ar-managed { margin-left: 4px; }
  .ar-card-desc { margin-top: 6px; font-size: 11px; line-height: 1.45; color: var(--og-text-secondary); overflow-wrap: anywhere; }
  .ar-facts { margin-top: 7px; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 4px 10px; }
  .ar-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .af-k { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .af-v { font-size: 11px; color: var(--og-text); overflow-wrap: anywhere; }
  .af-v.hint { color: var(--og-text-muted); font-style: italic; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  /* `margin-top: auto` pins the footer to the card's bottom edge; `padding-top`
     keeps the old 7px gap when there is no slack for the margin to absorb.
     wrap: the picker (AgentModelSelect + Close) can outgrow a 210px card
     alongside Open file, and wrapping keeps it inside the grid column. */
  .ar-card-footer { margin-top: auto; padding-top: 7px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  /* Byte-identical to CollabAgentCard's `.ca-btn`, which is the point: two card
     kinds sit in ONE grid, so one button size, not two. */
  .ar-btn { font-size: 11px; padding: 3px 8px; background: var(--og-btn-bg); color: var(--og-text-secondary); border: 1px solid var(--og-border); border-radius: 5px; cursor: pointer; font-family: inherit; flex: 0 0 auto; }
  .ar-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
</style>
