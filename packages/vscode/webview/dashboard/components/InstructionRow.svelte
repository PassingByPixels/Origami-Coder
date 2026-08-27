<script lang="ts">
  // ONE instruction row, extracted from InstructionsPane.svelte (158 of its
  // 160-line cap) so the pane could grow the "+ New file" affordance without a
  // raise — the ratchet's own remedy.
  //
  // The extraction stands; the CARD GRID it briefly wore does not. This list is
  // read as a RANKING — biggest contributor first, each row carrying a share
  // bar — and a share bar is only comparable to the one above it when both are
  // drawn to the same width. A grid reflowed the rows into columns and broke
  // exactly that reading, so the pane is a stack of full-width rows again and
  // this file is named for what it draws. The markup and styles below are the
  // pane's PRE-GRID ones, unchanged.
  //
  // It carries the pane's THEME obligation with it (architecture.test.ts's
  // THEMED_FILES): five themes ship with this board, two of them dark, and a
  // literal colour here is a badge that vanishes in at least one of them. Every
  // colour below is an --og-* var.
  //
  // The two honesty rules it inherits, both visible in the markup:
  //  - a URL has NO size. Measuring one means fetching it, which this read-only
  //    inventory does not do, so it says "not measured" rather than a 0 that
  //    reads as an empty file.
  //  - a pinned row is not a file. When it is NOT overridden, its path is where
  //    an override WOULD be written, and the row says so instead of presenting
  //    a path that does not exist yet as something already on disk.
  import InstructionRowActions, { restoreKindFor } from './InstructionRowActions.svelte';
  import { badge, displayName, isPinned } from './instructionRows';

  interface Entry {
    path: string;
    source: string;
    chars: number;
    tokensApprox: number;
    overridden?: boolean;
  }

  interface Props {
    entry: Entry;
    /** This entry's percentage of the whole prompt — drawn as the bar. */
    share: number;
    onOpen: (e: Entry) => void;
  }
  let { entry, share, onOpen }: Props = $props();
</script>

<div
  class="ins-row"
  class:is-url={entry.source === 'url'}
  class:is-base={isPinned(entry)}
  role="button"
  tabindex="0"
  onclick={() => onOpen(entry)}
  onkeydown={(ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); onOpen(entry); } }}
  title={entry.source === 'url' ? entry.path : `Open ${entry.path}`}
>
  <span class="ins-bar" style="width: {share.toFixed(1)}%"></span>
  <span class="ins-row-main">
    <span class="ins-name">{displayName(entry)}</span>
    <span class="ins-badge badge-{entry.source}">{badge(entry)}</span>
    <span class="ins-size">
      {#if entry.source === 'url'}
        not measured
      {:else}
        {entry.chars.toLocaleString()} chars · ~{entry.tokensApprox.toLocaleString()} tok · {share.toFixed(1)}%
      {/if}
    </span>
  </span>
  <span class="ins-path">{isPinned(entry) && !entry.overridden ? `Built in — click to override at ${entry.path}` : entry.path}</span>
  {#if restoreKindFor(entry)}<InstructionRowActions kind={restoreKindFor(entry)!} />{/if}
</div>

<style>
  /* The pane's pre-grid rules, carried back with the markup — Svelte scopes
     styles per component, so the row's rules live here now. No `height: 100%`
     and no `margin-top: auto`: both existed only to hold cards in a grid row to
     one height, and in a stack they merely stretch a one-line row. */
  .ins-row { position: relative; display: flex; flex-direction: column; gap: 2px; text-align: left; background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 5px; padding: 7px 9px; cursor: pointer; color: var(--og-text); font-family: inherit; overflow: hidden; }
  .ins-row:hover { border-color: var(--og-chat); }
  .ins-row.is-url { cursor: default; }
  /* The share bar is why this row is full width: its LENGTH is the comparison. */
  .ins-bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--og-accent); opacity: 0.16; pointer-events: none; }
  .ins-row-main { position: relative; display: flex; align-items: center; gap: 8px; }
  .ins-name { font-size: 12px; font-weight: 600; }
  .ins-badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 8px; background: var(--og-btn-bg); color: var(--og-text-muted); }
  .badge-project { background: var(--og-success-soft); color: var(--og-success); }
  .badge-global { background: var(--og-warning-soft); color: var(--og-warning); }
  .badge-memory { color: var(--og-crane); }
  .badge-url { color: var(--og-chat); }
  .badge-base-prompt, .badge-collab-agent-base { background: var(--og-accent); color: var(--og-surface); }
  .ins-row.is-base { border-color: var(--og-accent); }
  /* A right-aligned TAIL on the name line, not a line of its own: the width a
     stack gives back is exactly what makes that fit. */
  .ins-size { margin-left: auto; font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ins-path { position: relative; font-family: var(--vscode-editor-font-family, monospace); font-size: 9px; color: var(--og-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
