<script lang="ts">
  // The reasoning block, EXTRACTED from ChatPane.svelte (2659 of its 2665-line
  // cap) so the collab stream could draw the same object instead of a second,
  // slightly-different one. A model thinking is a model thinking, whether it is
  // answering you in a chat or answering another agent in a room.
  //
  // A native <details>, COLLAPSED even while streaming (no `open` binding — the
  // sibling .compaction-block is the precedent): a live thought takes the brand
  // contrast tint via `live` and nothing else, so the answer stays front and
  // centre and the transcript does not jump as the text grows.
  //
  // The MARK is a slot-shaped choice, not a branch: the chat's thought carries a
  // static brain (the rotating crane already lives on its stream indicator, and a
  // second out-of-phase one would fight it), while the collab's pill has no such
  // indicator and carries the rotating ThinkingGlyph itself. Passing a `mark`
  // snippet keeps both without this leaf knowing which surface it is on.
  import type { Snippet } from 'svelte';
  import ThoughtLine from './ThoughtLine.svelte';

  interface Props {
    /** The body. Empty renders an empty block, never a fabricated line. */
    text: string;
    /** The summary line — 'Thought process', 'thinking…', a tool name. */
    label: string;
    /** Brand contrast tint: this thought is streaming RIGHT NOW. */
    live?: boolean;
    /** The label is a TOOL LINE, not prose — monospace, never italicised. The
     *  body is monospace either way; this is the only place the two differ. */
    mono?: boolean;
    /** The summary's leading mark. Omitted = the static brain. */
    mark?: Snippet;
    /**
     * Real, per-message truth from the CALLER — never a raw "is streaming"
     * flag. Every stream delta re-renders this row (the caller replaces the
     * message object), which re-fires the `<details>` node's attribute effect
     * on the SAME element. That reassertion writes whatever `open` currently
     * evaluates to — so if the caller doesn't track what the user actually
     * did, a hand-opened block gets silently re-closed on the next delta.
     * Omitted/false renders closed, the chat's default; ChatPane
     * derives this from `openThoughtIds` (thoughtOpenState.ts) so the value
     * stays true once the user opens it, and the reassertion is a no-op.
     */
    open?: boolean;
    /** Fires on every native toggle (open AND close) so the caller can persist
     *  what the user actually did — see `open` above. */
    onToggle?: (open: boolean) => void;
  }
  let { text, label, live = false, mono = false, mark, open, onToggle }: Props = $props();
</script>

<details class="thought-block" class:live {open}
  ontoggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
  <summary class="thought-summary">
    {#if mark}{@render mark()}{:else}<span class="thought-brain" aria-hidden="true">🧠</span>{/if}
    <!-- INSIDE the summary: a closed <details> hides every sibling after it. -->
    <ThoughtLine {label} {mono} working={live} />
  </summary>
  <pre class="thought-text">{text}</pre>
</details>

<style>
  /* Carried across from ChatPane.svelte with the markup — Svelte scopes styles
     per component, so the rules the block needs live here now. A dim, collapsed
     block inline in the transcript; the user expands it to read the reasoning. */
  .thought-block {
    margin: 4px 0;
    border-left: 3px solid var(--og-text-muted);
    border-radius: 4px;
    background: var(--og-surface);
    opacity: 0.75;
    font-size: 11px;
  }
  /* A flex row so the travelling line takes the slack after the label without
     the summary changing height. The label's own rules left WITH
     ThoughtLine.svelte: a rule kept here would silently stop matching. */
  .thought-summary {
    display: flex;
    align-items: center;
    cursor: pointer;
    padding: 4px 8px;
    color: var(--og-text-muted);
    font-style: italic;
    user-select: none;
    list-style: none;
  }
  .thought-summary::-webkit-details-marker { display: none; }
  /* NO CHEVRON (t-ocnxue): a triangle AND a brain were two marks for one
     control. The brain says what the row is, so the brain is the affordance —
     open reads as the brain at full strength, not a second glyph rotating. */
  .thought-brain {
    display: inline-block;
    margin-right: 6px;
    opacity: 0.7;
    transition: opacity 0.12s ease, transform 0.12s ease;
  }
  .thought-summary:hover .thought-brain { opacity: 1; transform: scale(1.1); }
  .thought-block[open] .thought-brain { opacity: 1; }
  .thought-block[open] { opacity: 0.9; }
  @media (prefers-reduced-motion: reduce) { .thought-brain { transition: none; transform: none; } }
  .thought-text {
    margin: 0;
    padding: 2px 12px 8px 20px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
    line-height: 1.5;
  }
  /* The still-streaming thought reads as LIVE: full opacity, a brand contrast
     rail + summary, and slightly larger contrast-tinted reasoning text. Reverts
     to the dim block above the moment the turn settles (live → false). */
  .thought-block.live {
    opacity: 1;
    border-left-color: var(--og-chat);
  }
  .thought-block.live .thought-summary {
    color: var(--og-chat);
    font-style: normal;
  }
  .thought-block.live .thought-text {
    color: var(--og-chat);
    font-size: 12.5px;
  }
</style>
