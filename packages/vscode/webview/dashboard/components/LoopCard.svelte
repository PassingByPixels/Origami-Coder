<script lang="ts">
  // LoopCard — ONE loop, as a card that earns its width.
  //
  // Serves both row kinds: a LIVE loop (has a chat identity, or is running
  // headless after its chat closed) and a NEEDS-ATTENTION one (persisted, but
  // its engine session did not come back, so there is nothing to show but what
  // was persisted). The distinction is `live`, and it changes what the card is
  // allowed to claim — never what it hides.
  //
  // NEXT RUN is read off the armed timer (loopSchedules.ts's nextRunAt), never
  // recomputed from createdAt + interval * runs, which drifts by the duration
  // of every run so far. When no timer is armed the card says WHY instead of
  // printing a time: a live loop between ticks is mid-run, a needs-attention
  // loop has nothing scheduled at all.
  import LoopCardHead from './LoopCardHead.svelte';
  import { lastRunText, loopStateText, nextRunText, type LoopOutcome } from '../panes/loopFormat';
  import { canReopenChat } from '../panes/loopRows';

  interface LoopRow {
    intervalLabel: string;
    prompt: string;
    runs: number;
    persistent: boolean;
    /** Live rows only: running with no chat of its own, pulled back up. */
    headless?: boolean;
    nextRunAt?: number | null; lastRunAt?: number | null; lastOutcome?: LoopOutcome | null;
  }
  interface Props {
    live: boolean;
    /** Live rows only: the chat this loop belongs to. */
    label?: string;
    loop: LoopRow;
    /** Ticked by the pane so the countdown moves without each card owning a timer. */
    now: number;
    ontoggle: () => void;
    onreopen: () => void;
    oncancel: () => void;
  }
  const { live, label = '', loop, now, ontoggle, onreopen, oncancel }: Props = $props();

  const stateText = $derived(loopStateText(live, loop.persistent, loop.headless === true));
  const canReopen = $derived(canReopenChat(live, loop.headless === true));

  // '' from nextRunText means NO ARMED TIMER, which is a different sentence for
  // each row kind — and neither of them is a time.
  const nextText = $derived(!live ? 'not scheduled' : nextRunText(loop.nextRunAt, now) || 'after this run');
  const lastText = $derived(lastRunText(loop.lastRunAt, loop.lastOutcome, now));
</script>

<div class="loop-card" class:attention={!live} class:persistent={loop.persistent}>
  <LoopCardHead label={live ? label : ''} intervalLabel={loop.intervalLabel}
    persistent={loop.persistent} {canReopen} {ontoggle} {onreopen} {oncancel} />

  <!-- The prompt IS the loop. Arbitrary user text, so it wraps and breaks
       rather than stretching the card, and scrolls once it is long. -->
  <div class="loop-prompt">{loop.prompt}</div>

  <div class="loop-facts">
    <div class="loop-fact"><span class="lf-k">Runs</span><span class="lf-v">{loop.runs}</span></div>
    <div class="loop-fact"><span class="lf-k">Next run</span><span class="lf-v">{nextText}</span></div>
    <!-- Omitted entirely rather than shown empty: a loop that has not completed
         a run in THIS window has no last run to report, and "—" would read as
         one that failed to record. -->
    {#if lastText}<div class="loop-fact"><span class="lf-k">Last run</span><span class="lf-v">{lastText}</span></div>{/if}
  </div>

  <div class="loop-state" class:warn={!live}>{stateText}</div>
</div>

<style>
  .loop-card { background: var(--og-surface); border: 1px solid var(--og-border); border-radius: 6px; padding: 10px 11px; }
  .loop-card.attention { border-left: 3px solid var(--og-warning); }
  .loop-card.persistent { border-left: 3px solid var(--og-accent); }
  .loop-card.attention.persistent { border-left-color: var(--og-warning); }
  .loop-prompt {
    margin-top: 7px; font-size: 11px; color: var(--og-text-secondary); line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere; max-height: 96px; overflow-y: auto;
    background: var(--og-bg); border: 1px solid var(--og-border); border-radius: 4px; padding: 5px 7px;
  }
  /* Auto-fit rather than a fixed column count: the board is docked in a side
     panel as often as it is full width, and three columns there would wrap
     into a worse mess than one. */
  .loop-facts { margin-top: 7px; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 4px 10px; }
  .loop-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .lf-k { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--og-text-muted); }
  .lf-v { font-size: 11px; color: var(--og-text); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .loop-state { margin-top: 7px; font-size: 10px; font-style: italic; color: var(--og-text-muted); line-height: 1.4; }
  .loop-state.warn { color: var(--og-warning-text); }
</style>
