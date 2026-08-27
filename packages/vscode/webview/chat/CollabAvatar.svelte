<script lang="ts">
  // ONE speaker's mark: a brand animal where one resolves, a tinted letter disc
  // where none does.
  //
  // EXTRACTED from CollabStream.svelte, which went 9 lines past its architecture
  // cap once the follow rule (1.11) and the flow rail (2.3) landed in it. The
  // ratchet's remedy is a component, and this is the one subject in that file
  // that was already self-contained: everything about it — the glyph lookup, the
  // per-slug tone, the initial — answers "how is this speaker drawn", and
  // nothing about it answers "what does the transcript look like".
  //
  // The stream hands it down as a SNIPPET to CollabLivePill.svelte, so an agent
  // that is a brand animal in the transcript cannot become a letter disc in its
  // own live pill. That contract is unchanged by the move.
  import ArchetypeGlyph from '../dashboard/components/ArchetypeGlyph.svelte';
  import { archetypeGlyph } from '../dashboard/components/archetypeGlyphs';
  import { initialOf, toneOf } from './collabStreamMarks';

  interface Props {
    /** The slug (an agent) or `'user'`. */
    id: string;
    kind: 'human' | 'agent';
    /** Already resolved by the caller — 'You' for a human, the short name for
     *  an agent. This file does not know the roster. */
    name: string;
    /** The glyph KEY: the def's declared one where the host merged it in, else
     *  the slug (archetypeGlyph strips `collab-` and resolves the bird names). */
    glyphKey: string;
  }
  let { id, kind, name, glyphKey }: Props = $props();

  const hasGlyph = $derived(kind === 'agent' && archetypeGlyph(glyphKey) !== null);
</script>

{#if hasGlyph}
  <!-- A real brand animal where one resolves; the disc is the fallback, never a
       second decoration on top of the glyph. -->
  <span class="cs-glyph"><ArchetypeGlyph id={glyphKey} size={20} /></span>
{:else}
  <span
    class="cs-disc"
    class:you={kind === 'human'}
    style={kind === 'human' ? undefined : `--cs-tone: var(${toneOf(id)})`}
  >{initialOf(name)}</span>
{/if}

<style>
  .cs-glyph { display: flex; color: var(--og-crane); }
  /* The fallback identity mark: an initial on a tinted disc. The tone is set
     per-slug through --cs-tone (a var, never a literal), so an agent with no
     brand animal is still the same colour everywhere it speaks. */
  .cs-disc {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    color: var(--cs-tone, var(--og-text));
    background: color-mix(in srgb, var(--cs-tone, var(--og-accent)) 22%, transparent);
    border: 1px solid color-mix(in srgb, var(--cs-tone, var(--og-accent)) 55%, transparent);
  }
  /* 'You' gets no brand animal and no per-slug hash — one fixed accent mark, so
     your own messages read the same in every collab. */
  .cs-disc.you {
    color: var(--og-accent);
    background: color-mix(in srgb, var(--og-accent) 22%, transparent);
    border-color: var(--og-accent);
  }
</style>
