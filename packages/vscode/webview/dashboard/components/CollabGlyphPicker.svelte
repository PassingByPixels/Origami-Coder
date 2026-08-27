<script lang="ts">
  // The collab-agent form's GLYPH picker, extracted from CollabAgentsPane.svelte.
  //
  // The pane stood at 377 of its 380-line cap when the vision checkbox and the
  // card grid landed, so the ratchet's remedy applied before a line was written:
  // this came out first, and the pane SHRANK.
  //
  // The letter disc is offered as a real choice rather than as "no glyph": a def
  // with no `glyph:` renders the initial-letter disc everywhere it appears, so
  // the picker shows the thing that will actually be drawn.
  //
  // THEMED (architecture.test.ts's THEMED_FILES): the picked state is carried by
  // border + fill colour alone, so a literal here is a selection that goes
  // invisible in whichever of the five themes it clashes with.
  //
  // W9: the row SCROLLS on its own. The menagerie went from nine marks to
  // thirty-five, which wraps to six rows of buttons — enough to push the persona
  // box off the pane, the same failure the tool checklist hit one field above
  // (BotContractFields' `.bc-picks-scroll`). Same remedy, for the same reason.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';

  interface Props {
    /** The current `glyph:` value; `''` = the initial-letter disc. */
    value: string;
    /** The keys ArchetypeGlyph can actually draw, in the order they are offered. */
    keys: readonly string[];
    /** The letter the disc shows — the slug's first character, minus filing prefix. */
    letter: string;
    onchange: (glyph: string) => void;
  }
  let { value, keys, letter, onchange }: Props = $props();
</script>

<div class="cg-row">
  <button class="cg-btn" class:picked={value === ''} onclick={() => onchange('')} title="Initial-letter disc">
    <span class="cg-disc">{letter}</span>
  </button>
  {#each keys as key (key)}
    <button class="cg-btn" class:picked={value === key} onclick={() => onchange(key)} title={key}>
      <ArchetypeGlyph id={key} size={18} />
    </button>
  {/each}
</div>

<style>
  /* Roughly three rows of 28px buttons before the bar earns its keep; the
     menagerie only grows, so the box is what stops the form growing with it. */
  .cg-row { display: flex; flex-wrap: wrap; gap: 4px; max-height: 104px; overflow-y: auto; }
  .cg-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: var(--og-btn-bg);
    color: var(--og-crane);
    border: 1px solid var(--og-border);
    border-radius: 5px;
    cursor: pointer;
  }
  .cg-btn.picked { border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
  .cg-disc { font-size: 11px; font-weight: 700; color: var(--og-text-secondary); }
</style>
