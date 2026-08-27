<script lang="ts">
  // ONE roster chip. EXTRACTED from CollabRoster.svelte (271 of its 290-line
  // cap) so the lead star could become a real control (report 1.5 / S8) and
  // the empty roster could coach (report 1.6) without raising the cap.
  //
  // A chip answers four questions: who is in the room (name + brand glyph),
  // what it is doing right now (the shared pill-sweep ring, identical to the
  // sidebar's chat rows), whether it LEADS — and, now, lets you change that.
  //
  // WHY THE STAR IS TWO DIFFERENT THINGS. On the lead's own chip it is a
  // MARKER: there is nothing to set, and a disabled button there would be a
  // control that refuses every click. On every other active chip it is a
  // BUTTON that makes that agent the lead. So the star is interactive exactly
  // where it does something.
  //
  // It is a SIBLING of the chip button, never a child: a button inside a
  // button is invalid markup, and clicking the star must not also open the
  // context drawer the chip owns.
  //
  // W3 wave 3: the ring gained a fourth state (`error`, report F13 — a failed
  // agent used to fall back to a blank ring plus this 14px `!`), and the chip
  // gained the two PER-AGENT controls. Both arrive already decided:
  // collabSupervision.ts owns which ring a status draws and whether a stop has
  // anything to end, and CollabChipControls.svelte owns their markup.
  import ArchetypeGlyph from '../dashboard/components/ArchetypeGlyph.svelte';
  import CollabChipControls from './CollabChipControls.svelte';
  import CollabChipError from './CollabChipError.svelte';
  import type { RingState } from './collabSupervision';

  interface Props {
    name: string;
    /** The chip's hover text — full description, pinned model, context state. */
    title: string;
    /** NOT named `state`: a local of that name makes the compiler read the
     *  `$state` rune below as a store subscription (`$` + `state`). */
    agentState: RingState;
    removed: boolean;
    /** True while THIS agent's context drawer is the open one. */
    open: boolean;
    isLead: boolean;
    /** The glyph key, or null when the def names no drawable glyph. */
    glyphId: string | null;
    lastError?: string;
    onOpen: () => void;
    /** null when this agent must not be offered the lead — it already leads,
     *  or it has left the roster. */
    onSetLead: (() => void) | null;
    /** W3 (report 2.4): the per-agent Stop/Redirect pair, or null where the
     *  surface offers none — an archived room, a removed member, or a caller
     *  that has not wired supervision at all. ONE object rather than four
     *  props: they are never individually useful and never individually absent. */
    supervise: {
      canStop: boolean;
      outcome: string;
      onStop: () => void;
      onRedirect: (text: string) => void;
    } | null;
    /** Whether THIS chip owns the one open correction box. The roster holds it,
     *  which is what keeps it to one at a time. */
    redirecting?: boolean;
    onRedirectingChange?: (open: boolean) => void;
  }
  let { name, title, agentState, removed, open, isLead, glyphId, lastError, onOpen, onSetLead, supervise, redirecting = false, onRedirectingChange }: Props = $props();
</script>

<span class="chip-wrap" role="listitem">
  {#if isLead}
    <!-- The lead takes every human message that names nobody (C17 rule 3),
         which is the one roster fact a reader must see without opening
         anything. -->
    <span class="chip-lead" title="lead">&#9733;</span>
  {:else if onSetLead}
    <button class="chip-lead set" title={`Make ${name} the lead`} aria-label={`Make ${name} the lead`} onclick={onSetLead}>&#9734;</button>
  {/if}
  <button class="chip" class:removed class:open {title} onclick={onOpen}>
    <span class="chip-ring" data-state={agentState} aria-hidden="true"></span>
    {#if glyphId}
      <span class="chip-glyph" aria-hidden="true"><ArchetypeGlyph id={glyphId} size={12} /></span>
    {/if}
    <span class="chip-name">{name}</span>
  </button>
  {#if lastError}
    <CollabChipError {name} text={lastError} />
  {/if}
  {#if supervise}
    <CollabChipControls
      {name}
      canStop={supervise.canStop}
      outcome={supervise.outcome}
      onStop={supervise.onStop}
      onRedirect={supervise.onRedirect}
      open={redirecting}
      onToggle={(on) => onRedirectingChange?.(on)}
    />
  {/if}
</span>

<style>
  .chip-wrap { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 3px; }

  /* Agent chip: the SAME pill-sweep language the sidebar's chat rows use, so
     "this one is working" reads identically on both surfaces. The ring is an
     absolutely-positioned overlay (inset:0), so a state change never resizes
     the chip and cannot shift the roster row. */
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--og-btn-bg);
    border: none;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .chip:hover { background: var(--og-btn-hover); }
  .chip.open { background: color-mix(in srgb, var(--og-accent) 22%, transparent); }
  .chip.removed { opacity: 0.45; text-decoration: line-through; }
  .chip-glyph { display: flex; color: var(--og-crane); }
  .chip-name { color: var(--og-text); }
  .chip-lead { color: var(--og-warning); font-size: 10px; line-height: 1; }
  /* The settable star is quiet until hovered — it is an offer, not a state. */
  .chip-lead.set {
    background: none;
    border: none;
    padding: 0 1px;
    cursor: pointer;
    font-family: inherit;
    color: var(--og-text-muted);
  }
  .chip-lead.set:hover { color: var(--og-warning); }
  /* The error badge's own rules moved to CollabChipError.svelte with its
     markup; the supervision controls' to CollabChipControls.svelte. */

  @property --cp-ring-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  .chip-ring {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    padding: 2px;
    pointer-events: none;
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
  }
  /* idle draws nothing at all — an agent with nothing to do must not look busy. */
  .chip-ring[data-state='queued'] { background: var(--og-border); }
  /* F13: a solid error ring, not a sweep — a failed turn is a settled state,
     and animating it would read as work still in progress. The `!` badge stays:
     the ring says THAT it failed, the badge carries WHY. */
  .chip-ring[data-state='error'] { background: var(--og-error); }
  .chip-ring[data-state='running'] {
    background: conic-gradient(from var(--cp-ring-angle), var(--og-warning) 0deg 90deg, var(--og-border) 90deg 360deg);
    animation: cp-ring-spin 0.9s linear infinite;
  }
  @keyframes cp-ring-spin { to { --cp-ring-angle: 360deg; } }
  @media (prefers-reduced-motion: reduce) {
    .chip-ring[data-state='running'] { animation: none; }
  }
</style>
