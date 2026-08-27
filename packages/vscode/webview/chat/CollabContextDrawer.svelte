<script lang="ts">
  // The per-agent CONTEXT drawer, EXTRACTED from CollabRoster.svelte (288 of
  // its 290-line cap) so flock M4's lead badge could land on the chips without
  // raising it — the ratchet's own remedy.
  //
  // It keeps the two honest empty states the roster established: "this agent
  // has never taken a turn" and "the engine no longer holds its capture" are
  // DIFFERENT facts and are not folded into one message.
  //
  // NEW in M4: the collab's per-agent SPEND, as chips. They live here rather
  // than on the roster strip because a cost is a detail you go looking for,
  // not something a room needs to shout — and they follow labyrinthUsage's
  // discipline to the letter: `formatCost`/`formatTokenCount` are the SAME
  // printers the Labyrinth uses, an absent figure prints nothing, and an
  // engine that sent no ledger at all says "no data yet" rather than "$0".
  import CollabActivityList from './CollabActivityList.svelte';
  import PromptCaptureSection from '../dashboard/components/PromptCaptureSection.svelte';
  import { formatCost, formatTokenCount } from '../dashboard/components/labyrinthUsage';
  import type { CollabActivityEntry, CollabCostTotal, PromptCapture } from '../../src/acpExtTypes';

  /** How often an OPEN drawer re-asks — the pane's IDLE cadence, not its busy
   *  one: a prompt capture is a far heavier round trip than a state poll. */
  const REFRESH_MS = 4000;

  interface Props {
    /** The slug whose drawer this is — the fallback title when the roster has
     *  no participant row to name (an agent that spoke and then left). */
    slug: string;
    name: string;
    /** False when the participant has no engine session yet. */
    hasSession: boolean;
    capture: PromptCapture | null;
    captureError: string | null;
    captureLoaded: boolean;
    /** ABSENT on an older engine — which is "no data yet", never zero. */
    costTotals?: CollabCostTotal[];
    /** Retained activity, oldest first. ABSENT on an engine that predates the
     *  retention — "no log", never "nothing happened". */
    activity?: CollabActivityEntry[];
    /** Ask the host for this agent's capture AGAIN (report F14). Optional so a
     *  caller that has not wired it keeps today's one-shot behaviour. */
    onRefresh?: () => void;
    onClose: () => void;
  }
  let { slug, name, hasSession, capture, captureError, captureLoaded, costTotals, activity, onRefresh, onClose }: Props = $props();

  // THE DRAWER STOPS GOING STALE (F14). The open was a single fetch, so a drawer
  // left beside a working agent showed the prompt it had four tool calls ago.
  // Open == being read, so it re-asks while it is; the drawer is mounted only
  // while open, so its teardown IS the stop.
  $effect(() => {
    if (!onRefresh) return;
    const t = setInterval(() => onRefresh(), REFRESH_MS);
    return () => clearInterval(t);
  });

  /** One chip's line. A row the engine sent with 0 cost is a MEASUREMENT (a
   *  local model is free) and prints "$0"; nothing is ever synthesised. */
  function spendText(t: CollabCostTotal): string {
    const parts: string[] = [];
    const cost = formatCost(t.cost);
    const inTok = formatTokenCount(t.tokensInput);
    const outTok = formatTokenCount(t.tokensOutput);
    if (cost) parts.push(cost);
    if (inTok) parts.push(`${inTok} in`);
    if (outTok) parts.push(`${outTok} out`);
    return parts.join(' · ');
  }
</script>

<div class="ctx-drawer">
  <div class="ctx-head">
    <span class="ctx-title">Context — {name || slug}</span>
    <button class="ctx-close" onclick={onClose} aria-label="Close the context drawer">&times;</button>
  </div>

  <div class="ctx-cost" aria-label="Per-agent spend in this collab">
    {#if costTotals && costTotals.length > 0}
      {#each costTotals as t (t.agentSlug)}
        <span class="cost-chip" class:is-open={t.agentSlug === slug} title={`${t.agentSlug} — ${spendText(t)}`}>
          <span class="cost-slug">{t.agentSlug}</span>
          <span class="cost-value">{spendText(t)}</span>
        </span>
      {/each}
    {:else}
      <span class="cost-none">Spend: no data yet.</span>
    {/if}
  </div>

  <!-- What it has BEEN doing, above the one prompt it was last given: the log
       spans turns, the capture is a single moment. -->
  <CollabActivityList entries={activity} />

  {#if !hasSession}
    <!-- Not an error: an agent that has not been reached yet has no engine
         session at all, so there is nothing to have captured. -->
    <div class="ctx-empty">No context yet — this agent has not taken a turn in the collab.</div>
  {:else if captureLoaded && !capture && !captureError}
    <!-- It DID take a turn and the store still returned nothing: the engine
         keeps only the last handful of captures process-wide. Say which of
         the two happened rather than showing one empty state for both. -->
    <div class="ctx-empty">No capture available — the agent has not taken a turn recently.</div>
  {:else}
    <PromptCaptureSection source={{ capture, error: captureError, loaded: captureLoaded }} />
  {/if}
</div>

<style>
  /* --- carried across from CollabRoster.svelte with the markup --- */
  .ctx-drawer {
    flex-shrink: 0;
    max-height: 42%;
    overflow-y: auto;
    border-bottom: 1px solid var(--og-border);
    background: var(--og-surface-alt);
  }
  .ctx-head { display: flex; align-items: center; gap: 8px; padding: 6px 12px 0; }
  .ctx-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--og-text-secondary);
  }
  .ctx-close {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--og-text-muted);
    font-size: 14px;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
  .ctx-close:hover { color: var(--og-text); }
  .ctx-empty {
    padding: 10px 12px 12px;
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
  }

  /* --- the ledger's per-agent chips --- */
  .ctx-cost { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 12px 0; }
  .cost-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--og-border);
    font-size: 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
  }
  /* The agent whose drawer is open reads as the one you asked about. */
  .cost-chip.is-open { border-color: var(--og-accent); color: var(--og-text-secondary); }
  .cost-slug { color: var(--og-text-secondary); }
  .cost-none { font-size: 10px; font-style: italic; color: var(--og-text-muted); }
</style>
