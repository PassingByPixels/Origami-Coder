<script lang="ts">
  // SubagentMap.svelte — the LIVE agent map: this chat's hub at the left edge,
  // one node per sub-agent in a vertical column to the right of it.
  //
  // WHY A MAP AT ALL, given the drawer already lists the same rows. The drawer
  // is a 240px strip that answers "is anything still out"; the map answers
  // "what does this chat look like" in one glance, a node a click from its
  // own transcript.
  //
  // LEFT-TO-RIGHT TREE, not the star this replaced (t-di35mj): a ring around a
  // centre hub overlapped past about a dozen agents, spokes crossing with no
  // way to tell which led where — the owner's own report, on a chat that had
  // run 20+. A column has no such ceiling: it grows down, groups Running
  // above Error above Done, and the panel scrolls to it.
  //
  // LIVE SESSION ONLY — Labyrinth draws the history; nothing here persists.
  //
  // Inline SVG, no chart library: subagentMapNodes.ts owns the maths and is
  // tested without any SVG at all. Every colour is an --og-* token.
  import { mapTree, TREE_NODE_HEIGHT, CARD_LABEL_CLAMP } from '../panes/subagentMapNodes';
  import type { SubagentRow } from '../panes/subagentRows';

  interface Props {
    rows: SubagentRow[];
    /** What sits at the hub — this chat's own name. */
    title: string;
    onOpen: (key: string) => void;
    onClose: () => void;
  }
  let { rows, title, onOpen, onClose }: Props = $props();

  const tree = $derived(mapTree(rows));
  const nodes = $derived(tree.nodes);
  const PX_PER_UNIT = 5; // px per viewBox unit for the scrolling canvas's height
  const GROUP_LABEL: Record<'running' | 'error' | 'done', string> = { running: 'Running', error: 'Error', done: 'Done' };
  // The band heading draws above a group's FIRST node, recomputed from the
  // ordered column rather than stored on the node — one source of truth.
  const isGroupStart = (i: number) => i === 0 || nodes[i].group !== nodes[i - 1].group;
  const NODE_HEIGHT_HALF = TREE_NODE_HEIGHT / 2;

  // Provider/model is back on the card face as its own third line (t-f9jxl1):
  // the card widened to fit it, mirroring the drawer row's own three lines.
  // The tooltip keeps naming it too — a card with a long model string still
  // clips visually, and the hover is where the exact value lives.
  type MapNode = (typeof nodes)[number];
  const cardTitle = (node: MapNode) => {
    const state = node.openable ? `Open ${node.title}` : `${node.title} — this spawn never created a sub-agent session`;
    return node.model ? `${state} — ${node.model}` : state;
  };
  // While a child REASONS its thinking count REPLACES the spend figure on this
  // one line (t-gvz8t0): the card has room for one meta line, and "what is it
  // doing right now" beats a total that has not moved since its last step.
  const cardMeta = (node: MapNode) => [node.thinking || node.tokens, node.age].filter((part) => part).join(' ');

  // Escape closes, from anywhere in the window: the overlay covers the chat
  // cell, so the key has nowhere else useful to go while it is up. Registered
  // on `window` rather than the div because the div is not focusable and a
  // click-to-focus requirement would make the shortcut a lie.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="sm-scrim" role="dialog" aria-modal="true" aria-label="Agent map">
  <div class="sm-panel">
    <div class="sm-head">
      <span class="sm-title">Agent map</span>
      <button class="sm-close" title="Close (Esc)" aria-label="Close the agent map" onclick={onClose}>&times;</button>
    </div>
    <!-- SCROLLS vertically once the column outgrows the panel. -->
    <div class="sm-body">
      <div class="sm-canvas" style="height: {tree.height * PX_PER_UNIT}px;">
        <svg class="sm-svg" viewBox="0 0 100 {tree.height}" preserveAspectRatio="none" aria-hidden="true">
          {#each nodes as node (node.key)}
            <line class="sm-spoke" x1={tree.hubX} y1={tree.hubY} x2={node.x} y2={node.y} />
          {/each}
          {#each nodes as node (node.key)}
            <circle class="sm-node sm-{node.state}" cx={node.x} cy={node.y} r="2.6" />
          {/each}
        </svg>
        <!-- The hub and nodes draw as HTML, not SVG <text>: a wrapped, clamped
             caption needs -webkit-line-clamp, which SVG text does not do. -->
        <div class="sm-hub-box" style="left: {tree.hubX}%; top: {(tree.hubY / tree.height) * 100}%;">
          <span class="sm-hub-name" title={title}>{title}</span>
          <span class="sm-hub-kind">this chat</span>
        </div>
        {#each nodes as node, i (node.key)}
          {#if isGroupStart(i)}
            <div class="sm-group-label" style="left: {node.x}%; top: {((node.y - NODE_HEIGHT_HALF) / tree.height) * 100}%;">{GROUP_LABEL[node.group]}</div>
          {/if}
          <button
            class="sm-card"
            class:sm-unopenable={!node.openable}
            style="left: {node.x}%; top: {(node.y / tree.height) * 100}%;"
            disabled={!node.openable}
            title={cardTitle(node)}
            onclick={() => onOpen(node.key)}
          >
            <span class="sm-line">
              <span class="sm-dot sm-{node.state}"></span>
              <span class="sm-name {CARD_LABEL_CLAMP}">{node.label}</span>
            </span>
            <span class="sm-meta" title={node.tokensDetail}>{cardMeta(node)}</span>
            {#if node.model}<span class="sm-model">{node.model}</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sm-scrim {
    position: absolute; inset: 0; z-index: 14;
    display: flex; align-items: center; justify-content: center;
    /* Literal rgba, on BrowserOverlay.svelte's precedent: no --og-* scrim var. */
    background: rgba(0, 0, 0, 0.55);
  }
  .sm-panel {
    display: flex; flex-direction: column; min-height: 0;
    width: min(620px, 94%); height: min(520px, 92%);
    background: var(--og-surface);
    border: 1px solid var(--og-border);
    border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  }
  .sm-head { display: flex; align-items: baseline; gap: 8px; flex: 0 0 auto; padding: 8px 10px; border-bottom: 1px solid var(--og-border); }
  .sm-title { flex: 1 1 auto; font-size: 11.5px; font-weight: 600; color: var(--og-text); }
  .sm-close { flex: 0 0 auto; background: none; border: none; color: var(--og-text-muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 3px; border-radius: 3px; font-family: inherit; }
  .sm-close:hover { color: var(--og-text); background: var(--og-btn-bg); }

  /* `.sm-canvas`'s px height (set inline from `tree.height`) is what scrolls;
     the viewBox width stays the fixed 100 units the ticket bounds nodes to. */
  .sm-body { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
  .sm-canvas { position: relative; width: 100%; }
  .sm-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .sm-spoke { stroke: var(--og-border); stroke-width: 0.35; vector-effect: non-scaling-stroke; }
  .sm-node { fill: var(--og-text-muted); }
  .sm-node.sm-running { fill: var(--og-accent); }
  .sm-node.sm-done { fill: var(--og-success); }
  .sm-node.sm-error, .sm-node.sm-failed { fill: var(--og-error); }

  /* Hub at the LEFT edge: only vertical centring transforms — a horizontal
     -50% would run the label off the panel's left side. A rounded rectangle,
     not the circle this replaced (t-f6uvu5): the caption wraps INSIDE it and
     clamps at 3 lines rather than truncating to one. */
  .sm-hub-box {
    position: absolute; transform: translateY(-50%); margin-left: 14px;
    display: flex; flex-direction: column; gap: 1px; width: 140px;
    padding: 5px 8px;
    background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 8px;
  }
  .sm-hub-name {
    font-size: 11px; font-weight: 600; color: var(--og-text);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-word;
  }
  .sm-hub-kind { font-size: 8.5px; color: var(--og-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }

  /* One heading per band, above its first card, same x as the cards. */
  .sm-group-label { position: absolute; transform: translateX(-50%); font-size: 8.5px; font-weight: 600; color: var(--og-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }

  /* 132px->210px (t-f9jxl1): wide enough that a typical 3-5 word description
     fits `sm-name`'s line 1 without wrapping (measured by character count —
     ~30 chars at this font's ~6px average glyph width need ~180px, and this
     leaves that plus the dot and padding room to spare) — and wide enough for
     the model's own third line, which no longer needs the tooltip alone. */
  .sm-card {
    position: absolute; transform: translate(-50%, -50%);
    display: flex; flex-direction: column; gap: 1px; align-items: flex-start;
    width: 210px; padding: 4px 6px;
    background: var(--og-surface-alt); border: 1px solid var(--og-border); border-radius: 4px;
    cursor: pointer; font-family: inherit; text-align: left;
  }
  .sm-card:hover:not(:disabled) { border-color: var(--og-accent); }
  .sm-unopenable { cursor: default; opacity: 0.7; }
  .sm-line { display: flex; align-items: flex-start; gap: 5px; min-width: 0; width: 100%; }
  .sm-dot { flex: 0 0 auto; width: 6px; height: 6px; margin-top: 4px; border-radius: 50%; background: var(--og-text-muted); }
  .sm-dot.sm-running { background: var(--og-accent); }
  .sm-dot.sm-done { background: var(--og-success); }
  .sm-dot.sm-error, .sm-dot.sm-failed { background: var(--og-error); }
  .sm-name { flex: 1 1 auto; min-width: 0; font-size: 10px; color: var(--og-text-secondary); }
  /* Line 1's clamp — 2 lines, wrapped rather than truncated to one. A widened
     card fits the typical case on one line; this is the fallback for the rest. */
  .sm-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
  .sm-meta { font-size: 9px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Row 3 — the model, back on the card face; mirrors SubagentRow.svelte's
     own `.sa-model`. */
  .sm-model { padding-left: 11px; font-size: 9px; color: var(--og-text-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
