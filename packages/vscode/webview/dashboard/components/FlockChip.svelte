<script lang="ts">
  // A RIGHT-RAIL CHIP: one line you can read without opening, and the whole
  // form underneath when you do.
  //
  // The three things an owner sets ONCE — who they are, an invite, what may be
  // shared — do not deserve a permanent third of the pane, and the messenger
  // layout has none to give them. Collapsed, each is a line that STATES its
  // value ("Nothing shared", "48 h · single use"), so the rail still answers
  // "what is set" without a click; open, each is exactly the component it
  // always was.
  //
  // WHICH ONE STARTS OPEN IS NOT A PREFERENCE. A chip whose thing is not set
  // yet opens itself, because an unset identity or an empty scope is work the
  // owner has not done and a closed chip would hide it; a chip that IS set
  // starts closed. The pane decides that (it is the one holding the state) and
  // remembers the owner's later clicks per chip in the webview state, so a
  // reload does not re-open what they shut.
  //
  // A `<button>` head, not a `<details>`, and the head's own control sits
  // BESIDE that button rather than inside it: the permissions switch is the one
  // case, and a checkbox nested in a button is both invalid markup and a
  // control whose every click would also toggle the chip.
  import ArchetypeGlyph from './ArchetypeGlyph.svelte';

  interface Props {
    /** Which chip this is. On the element as `data-chip`, so a test names the
     *  chip rather than the words in its title — the title is the owner's own
     *  display name on one of the three. */
    id: string;
    /** A symbol id from FlockChrome.svelte, without the `#`. */
    icon: string;
    /** An archetype glyph drawn INSTEAD of the sprite icon, when this chip is
     *  about somebody (the owner's own identity) rather than about a subject. */
    glyph?: string;
    title: string;
    /** The value, in one line, while the chip is shut. */
    summary: string;
    open: boolean;
    ontoggle: () => void;
    /** A control that belongs in the head, on screen whether open or shut. */
    head?: import('svelte').Snippet;
    children: import('svelte').Snippet;
  }
  let { id, icon, glyph, title, summary, open, ontoggle, head, children }: Props = $props();
</script>

<section class="fold" class:open data-chip={id}>
  <div class="fold-head">
    <button class="fold-open" aria-expanded={open} onclick={ontoggle}>
      {#if glyph}
        <span class="fk-avatar"><ArchetypeGlyph id={glyph} size={16} /></span>
      {:else}
        <svg class="fk-ico head-ico" aria-hidden="true"><use href={`#${icon}`} /></svg>
      {/if}
      <span class="fold-title">{title}</span>
      <span class="fold-sum">{summary}</span>
      <svg class="fk-ico sm chev" aria-hidden="true"><use href="#fk-chev" /></svg>
    </button>
    {#if head}{@render head()}{/if}
  </div>
  {#if open}<div class="fold-body">{@render children()}</div>{/if}
</section>

<style>
  .fold { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; flex: 0 0 auto; min-width: 0; }
  .fold-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; flex-wrap: wrap; min-width: 0; }
  .fold-open {
    display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 0; background: none;
    border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .fold-open:hover .fold-title { color: var(--og-chat); }
  .head-ico { color: var(--og-text-muted); }
  .fold-title { font-weight: 600; white-space: nowrap; }
  .fold-sum { color: var(--og-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .chev { color: var(--og-text-muted); margin-left: auto; transition: transform 0.15s; }
  .fold.open .chev { transform: rotate(90deg); }
  .fold-body { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; min-width: 0; }
  .fk-avatar { background: var(--og-crane); }
</style>
