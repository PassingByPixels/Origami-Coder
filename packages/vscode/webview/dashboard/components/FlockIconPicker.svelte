<script lang="ts">
  // THE OWNER'S ICON, PICKED FROM THE BRAND MENAGERIE AND FROM NOWHERE ELSE.
  //
  // Every contact sees this mark beside the name, so it is a thing other people
  // render — which is the whole reason it is a CHOICE FROM A DRAWN SET and not
  // an upload. There is no file to send, nothing to fetch and nothing to scale:
  // what crosses the wire is a short id, and the drawing is already in the
  // client that has to show it. The engine refuses anything that is not a short
  // id (`FlockIdentity.normaliseIcon`), so the same rule holds for an id that
  // arrived from somebody else's machine.
  //
  // The set is `glyphKeys()` — the same origami family the crane sigil belongs
  // to, offered under the creatures' names — DERIVED from the glyph table rather
  // than listed here. glyphNames.ts records what a hand-kept copy of that list
  // cost last time: it fell a glyph behind, and a drawing nobody can choose is
  // not shipped.
  //
  // There is NO "no icon" option, unlike CollabGlyphPicker's letter disc: every
  // Origami shows some mark to every contact, and the crane is the default.
  //
  // THEMED (architecture.test.ts's THEMED_FILES): the picked state is carried by
  // border and fill alone, so a literal colour here is a selection that goes
  // invisible in whichever of the five themes it clashes with.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';
  import { glyphKeys } from './archetypeGlyphs';

  interface Props {
    /** The icon id in force. Always one of `keys` in practice; an unknown one
     *  simply matches nothing and leaves the row unpicked. */
    value: string;
    onchange: (icon: string) => void;
  }
  let { value, onchange }: Props = $props();

  const KEYS = glyphKeys();
</script>

<div class="fi-row" role="radiogroup" aria-label="Your icon">
  {#each KEYS as key (key)}
    <button
      class="fi-btn"
      class:picked={value === key}
      role="radio"
      aria-checked={value === key}
      aria-label={key}
      title={key}
      onclick={() => onchange(key)}
    >
      <ArchetypeGlyph id={key} size={18} />
    </button>
  {/each}
</div>

<style>
  /* Three rows of buttons before it scrolls. The menagerie only grows, and this
     tile sits in a grid cell that must not grow with it. */
  .fi-row { display: flex; flex-wrap: wrap; gap: 4px; max-height: 104px; overflow-y: auto; }
  .fi-btn {
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
  .fi-btn.picked { border-color: var(--og-accent); background: color-mix(in srgb, var(--og-accent) 18%, transparent); }
</style>
