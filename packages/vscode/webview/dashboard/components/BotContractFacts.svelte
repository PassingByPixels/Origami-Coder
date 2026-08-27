<script lang="ts">
  // The FACTS GRID of a bot card, extracted from CollabAgentCard.svelte — which
  // stood at 149 of its 150-line cap when the bot contract arrived, and the
  // ratchet's remedy is extraction.
  //
  // It carries the two facts the card always had (Model, Steps) and the ones
  // the contract added — Tools, Memory, and a Tier row only when the file
  // states one. One component rather than five, because they are read together:
  // the question a card answers is "is this bot ready to work", and that is the
  // whole row. (Skills and Model preference were here until W6 stripped both.)
  //
  // WHAT THIS OWNS AND WHAT IT DOES NOT. Every word below comes from
  // botContractView.ts, which is where the three-state rule lives (chosen,
  // chosen-as-the-default, never stated). This file decides only how the three
  // states LOOK — a stated value in the reading colour, an unstated one muted,
  // an unreadable one in the warning tone.
  //
  // THEMED (architecture.test.ts's THEMED_FILES): the muted-vs-stated
  // distinction and the bad-tier warning are carried in colour, so a literal
  // here is a def that reads as configured — or a typo that reads as fine — in
  // whichever of the five themes it clashes with.
  import { memorySummary, tierSummary, toolsSummary } from './botContractView';
  import type { CollabAgentDef } from '../../../src/dashboard/collabAgentCrud';

  interface Props {
    def: CollabAgentDef;
    /** Which preset the def's tick set IS — computed by the card, since the
     *  rule for naming a set lives host-side with the sets (botTools.ts). */
    preset: string;
    /** Facts this bot has kept in its own store — 0 when it has kept none. */
    memoryFacts?: number;
  }
  let { def, preset, memoryFacts = 0 }: Props = $props();

  const bot = $derived(def.bot ?? {});
  const tier = $derived(tierSummary(bot));
  const tools = $derived(toolsSummary(def, preset));
  const memory = $derived(memorySummary(bot, memoryFacts));
</script>

<div class="ca-facts">
  <div class="ca-fact">
    <span class="cf-k">Model</span>
    <!-- '' is "the file pins none", NOT a model called nothing: the collab's own session model runs. -->
    <span class="cf-v mono" class:unset={!def.model}>{def.model || 'no pinned model'}</span>
  </div>
  <!-- WHICH TOOLS this bot has — since W6 the only permission statement the
       editor writes, so it is the row that answers "what may it do". The whole
       ticked list is on the title attribute; a card cannot hold thirty names. -->
  <div class="ca-fact">
    <span class="cf-k">Tools</span>
    <span class="cf-v" class:unset={!tools.chosen} title={tools.title}>{tools.text}</span>
  </div>
  <!-- The TIER only when the file states one. It is not a control any more (the
       checklist replaced it), so drawing "engine default" on every card would
       spend a label on a decision nobody can make from here — but a hand-written
       `permissions:` line still changes what the bot may do, and an UNREADABLE
       one means the file claims a level it is not running under. -->
  {#if tier.chosen}
    <div class="ca-fact">
      <span class="cf-k">Tier</span>
      <span class="cf-v" class:bad={tier.bad} title={tier.title}>{tier.text}</span>
    </div>
  {/if}
  <div class="ca-fact">
    <span class="cf-k">Memory</span>
    <span class="cf-v" class:unset={!memory.chosen && memoryFacts === 0} title={memory.title}>{memory.text}</span>
  </div>
  <!-- Only when the FILE pins one. `steps: ''` means the preset's budget
       applies; those numbers live engine-side, so the row that used to say
       "preset default" spent a label on the absence of a fact. -->
  {#if def.steps}
    <div class="ca-fact">
      <span class="cf-k">Steps</span>
      <span class="cf-v">{def.steps}</span>
    </div>
  {/if}
</div>

<style>
  /* Auto-fit: this board is docked as often as full width. Mirrors LoopCard. */
  .ca-facts { margin-top: 7px; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 4px 10px; }
  .ca-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .cf-k { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .cf-v { font-size: 11px; color: var(--og-text); overflow-wrap: anywhere; }
  /* The THIRD state, and the reason this component exists: a value the def
     never stated is the engine's default being described, not a choice. It is
     drawn in the muted tone the labels use, so a scan down a column of cards
     separates "decided" from "left alone" without reading a word. */
  .cf-v.unset { color: var(--og-text-muted); font-style: italic; }
  /* A tier the engine cannot read adds NO rules — the def claims a permission
     level it is not running under. That is a warning, not a value. */
  .cf-v.bad { color: var(--og-warning-text); font-style: normal; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
</style>
