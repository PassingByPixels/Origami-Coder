<script lang="ts">
  // One bot definition, as a card. Extracted from CollabAgentsPane.svelte.
  // Why a card, not a row: choosing a def needs its purpose, its
  // worker/observer capability, and its pinned model — too much for one line.
  //
  // Themed (architecture.test.ts's THEMED_FILES): the preset chip codes
  // worker-vs-observer partly in colour, so a literal colour here would
  // clash in some of the five themes.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import BotContractFacts from './BotContractFacts.svelte';
  import { modelWarning, personaLine, toolsSummary } from './botContractView';
  import { seedName } from './collabPersonaSeed';
  import { presetOfTools } from '../../../src/dashboard/botTools';
  import type { CollabAgentDef } from '../../../src/dashboard/collabAgentCrud';

  interface Props {
    def: CollabAgentDef;
    /** Facts this bot has kept in its own store — 0 when it has kept none. */
    memoryFacts?: number;
    onEdit: (d: CollabAgentDef) => void;
    onDelete: (slug: string) => void;
    /** Start a chat as this bot. Absent on the Vision tab (a profile has no turn to take). */
    onStart?: (slug: string, displayName: string) => void;
    /** Being created now: a bot chat is provisional; this button is the
     *  click's only feedback during the engine boot. */
    starting?: boolean;
  }
  let { def, memoryFacts = 0, onEdit, onDelete, onStart, starting = false }: Props = $props();

  // The words this card prints live in botContractView.ts: rules about
  // fields read together earn a test without a render. This file lays them out.
  const persona = $derived(personaLine(def));
  const warning = $derived(modelWarning(def));

  // Local, not pane state: nothing outside this card ever read "which slug is
  // confirming", so a stale confirm cannot outlive the row it was armed on.
  let confirming = $state(false);

  // The handle row restates the name; it earns ink only when slug and name differ.
  const name = $derived(seedName(def.slug));
  const handle = $derived(def.slug === name.toLowerCase() ? '' : def.slug);

  // Read off the ticks: the tick set is the permission block, so a stored
  // `preset` that disagreed would claim one thing while the file said another.
  const preset = $derived(def.tools ? presetOfTools(def.tools) : def.preset ?? 'worker');
  const toolsHint = $derived(toolsSummary(def, preset).title ?? '');
</script>

<div class="ca-card">
  <div class="ca-card-head">
    <span class="ca-card-glyph"><ArchetypeGlyph id={def.glyph || def.slug} size={32} /></span>
    <span class="ca-card-name" title={handle ? `${name} @${handle}` : name}>{name}{#if handle}<span class="ca-handle mono">@{handle}</span>{/if}</span>
    <!-- A chip only where it means something: a vision profile never takes a turn. -->
    {#if !def.visionProfile}<span class="ca-chip {preset}" title={toolsHint}>{preset}</span>{/if}
    {#if def.vision}
      <span class="ca-chip vision" title="Vision: images posted to the room reach this agent as real picture data.">vision</span>
    {/if}
  </div>

  <div class="ca-card-desc">{def.description || 'No description.'}</div>

  <!-- Write-if-absent + install-once marker: an old file is never upgraded, and deleting it does not reseed. -->
  {#if def.legacySeed}
    <div class="ca-card-stale">Old shipped template — still the read-only version. Edit it here; deleting will not reseed until the install marker is bumped.</div>
  {/if}
  {#if warning}
    <div class="ca-card-stale">{warning}</div>
  {/if}

  {#if persona}
    <div class="ca-card-persona" title={def.persona}>{persona}</div>
  {/if}

  <BotContractFacts {def} {preset} {memoryFacts} />

  <!-- Buttons stay out of the head; primary sits left, destructive (push) rightmost. -->
  <div class="ca-card-footer">
    <!-- The bot's own session: primary action on a card, running as this
         definition with its permissions, skills, model and memory. Both
         names are sent: slug is the engine agent, `name` is the chat tab. -->
    {#if onStart}
      <button class="ca-btn primary" disabled={starting} title={starting ? `Starting ${name} — the engine is coming up` : `Open a chat running as ${name}, with its own memory`} onclick={() => onStart(def.slug, name)}>{starting ? 'Starting…' : 'Start session'}</button>
    {/if}
    <button class="ca-btn" onclick={() => onEdit(def)}>Edit</button>
    {#if confirming}
      <button class="ca-btn push" onclick={() => (confirming = false)}>Keep</button>
      <button class="ca-btn danger" onclick={() => { confirming = false; onDelete(def.slug); }}>Delete it</button>
    {:else}
      <button class="ca-btn push" onclick={() => (confirming = true)}>Delete</button>
    {/if}
  </div>
</div>

<style>
  /* D7: padding 9px 11px -> 7px 9px, since the glyph doubled (18 -> 32). UAT
     round 2 item 3: FLEX COLUMN - a grid item already stretches to its row's
     height, and the column plus the footer's `margin-top: auto` is what makes
     that height do something: buttons on ONE line across the row. */
  .ca-card { display: flex; flex-direction: column; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 7px 9px; }
  .ca-card-head { display: flex; align-items: center; gap: 7px; }
  .ca-card-glyph { display: flex; color: var(--og-crane); flex: 0 0 auto; }
  /* flex:1 1 auto + min-width:0 so the NAME is what shrinks in a crowded head
     row - the chips keep their size, and the ellipsis triggers past the card's
     real width rather than the name reading as "Ar…". */
  .ca-card-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
  /* Inside the name span, so the pair ellipsises as one string. */
  .ca-handle { margin-left: 5px; font-size: 11px; font-weight: 400; color: var(--og-text-muted); }
  /* The chip is the permission level. Worker (can act) takes the accent,
     observer stays quiet, custom takes the warning tone a hand-edited block
     takes everywhere else on this view. */
  .ca-chip { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-muted); border: 1px solid transparent; flex: 0 0 auto; }
  .ca-chip.worker { background: color-mix(in srgb, var(--og-accent) 20%, transparent); color: var(--og-text); border-color: var(--og-accent); }
  .ca-chip.custom { background: var(--og-warning-soft); color: var(--og-warning-text); border-color: var(--og-warning); }
  /* A capability, not a permission level - the glyphs' own crane tone. */
  .ca-chip.vision { color: var(--og-crane); border-color: var(--og-crane); background: transparent; }
  .ca-card-desc { margin-top: 6px; font-size: 11px; line-height: 1.45; color: var(--og-text-secondary); overflow-wrap: anywhere; }
  .ca-card-stale { margin-top: 6px; font-size: 10px; line-height: 1.4; color: var(--og-warning-text); }
  /* The persona's opening paragraph, clamped to two lines: the card's job is to
     make one bot recognisable beside its neighbours, not to reproduce a prompt.
     The whole text is on the title attribute. */
  .ca-card-persona { margin-top: 5px; font-size: 10px; line-height: 1.4; font-style: italic; color: var(--og-text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* The facts grid left for BotContractFacts.svelte when the contract landed -
     this file was at 149 of its 150 cap. Its styles went with it. */
  /* `margin-top: auto` pins the footer to the card's bottom edge; `padding-top`
     keeps the old 7px gap when there is no slack for the margin to absorb. */
  .ca-card-footer { margin-top: auto; padding-top: 7px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  /* Byte-identical to ArchetypeAgentCard's `.ar-btn`: two card kinds in ONE
     grid, so one button size. `.push` holds the destructive control right. */
  .ca-btn { font-size: 11px; padding: 3px 8px; background: var(--og-btn-bg); color: var(--og-text-secondary); border: 1px solid var(--og-border); border-radius: 5px; cursor: pointer; font-family: inherit; flex: 0 0 auto; }
  .ca-btn:hover { border-color: var(--og-chat); color: var(--og-text); }
  .ca-btn:disabled { opacity: 0.6; cursor: default; } /* a start in flight — the card stays put and says so */
  /* Start session is the bot card's PRIMARY action - same treatment the pane's
     own primary button takes, so "the main thing to do here" reads the same. */
  .ca-btn.primary { color: var(--og-text); border-color: var(--og-chat); }
  .ca-btn.danger { color: var(--og-error-text); border-color: var(--og-error); }
  .ca-btn.push { margin-left: auto; }
</style>
