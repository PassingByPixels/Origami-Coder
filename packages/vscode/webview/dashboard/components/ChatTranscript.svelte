<script lang="ts">
  // ChatTranscript.svelte — ONE chat's message rows, and nothing else, so a second
  // caller (a read-only transcript) renders them through the SAME renderer instead
  // of a lookalike that drifts.
  //
  // Every <style> rule that targets a row lives HERE, not in ChatPane.svelte:
  // Svelte scopes <style> per component, so a selector left behind simply stops
  // matching the markup that moved — no error, no warning, and no test can see it,
  // because the vitest config never puts a <style> element in the DOM. What stays
  // in the pane is what is not a row: the scroller, the once-off headers above the
  // loop, the staged-rewind banner below it, and the cell chrome.
  //
  // Each field the markup reads is its OWN prop rather than the whole session: the
  // read-only caller has a message list and no session at all, and the two things
  // the markup writes are callbacks the pane wires back to its own state.
  import ToolRunGroup from './ToolRunGroup.svelte';
  import MessageRow from './MessageRow.svelte';
  import { tip } from '../../shared/warmTip';
  import TodoStrip from './TodoStrip.svelte';
  import ThoughtPill from './ThoughtPill.svelte';
  import PeerMessageRow from './PeerMessageRow.svelte';
  import SystemAlertRow from './SystemAlertRow.svelte';
  import { engineAlert } from '../panes/engineNotice';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import VerdictRow from './VerdictRow.svelte';
  import SecondOpinionCard from './SecondOpinionCard.svelte';
  import FocusGapRow from './FocusGap.svelte';
  import CraneMark from '../../shared/CraneMark.svelte';
  import { isThoughtOpen, withThoughtOpen } from '../panes/thoughtOpenState';
  import { foldForFocus, isFocusGap } from './focusGaps';
  import { groupToolRuns } from './toolRuns';
  import { isEmptyAgentTurn } from './chatFocus';
  import { subagentIdentity, subagentKey, subagentLabel, subagentOrdinals } from '../panes/subagentLabel';
  import type { Message } from '../panes/chatMessage';

  interface Props {
    /** This chat's rows, keyed by `msg.id` — the loop source. */
    messages: Message[];
    /** The session these rows belong to. ToolCard needs it to cancel the turn
     *  or kill a background shell from a stuck card. */
    sessionId: string;
    /** Live-turn flag. Pulses the streaming thought pill, and HIDES the rewind
     *  affordance mid-turn (you cannot rewind a turn that is still running). */
    inFlight: boolean;
    /** The streaming thought row and the in-flight agent bubble; null between turns. */
    currentThoughtMsgId: number | null;
    currentAgentMsgId: number | null;
    /** Which reasoning blocks the user opened by hand (thoughtOpenState.ts). */
    openThoughtIds: number[] | undefined;
    /** The next open-set after a pill toggle. The RULE that computes it stays here
     *  with the markup; the pane owns the session field it lands on. */
    onThoughtOpenIds: (ids: number[]) => void;
    /** An image in a row was clicked. One lightbox serves the whole pane, so the row
     *  only reports the click upward. Omit it and MessageRow leaves the image inert
     *  — a caller with no lightbox of its own, not a safety gate. */
    onImageClick?: (src: string, alt: string) => void;
    /** "Rewind here" on an agent row, the same shape the pane's rewindTo took.
     *  Never called in read-only mode. */
    onRewind?: (sessionId: string, engineMsgId?: string) => void;
    /** Retry on a STOPPED stream-drop card: send the turn again. Omitted by a
     *  read-only transcript, which then draws the card with no action. */
    onRetryTurn?: (sessionId: string) => void;
    /**
     * These rows are HISTORY — a sub-agent's stored session, replayed here so a
     * finished child reads the way the chat that spawned it does.
     *
     * It has to reach BOTH levels: the rewind button is in this file (it posts
     * revertToMessage, which rolls the working tree back) while ToolCard's Kill and
     * Stop are one component down and take their own `readOnly`, so hiding markup
     * here alone would leave those two live. Every openAbsoluteFile sender KEEPS
     * working: opening a file the sub-agent touched mutates nothing.
     */
    readOnly?: boolean;
    /** A Claude Code passthrough cell: kills REWIND only. This is a live chat, so
     *  ToolCard's Kill/Stop stay armed, but there is no transcript to revert to. */
    passthrough?: boolean;
    /** FOCUS VIEW — draw only what was SAID, each run of hidden rows folded to ONE
     *  counted divider. Default false, so a caller that does not ask for it renders
     *  what it always did. The rule is chatFocus.ts's, the fold focusGaps.ts's. */
    focusMode?: boolean;
    /** t-ucnp7t: what the T-numbers are counted over when it is more than `messages` — the
     *  roster's stand-ins for sub-agents whose card is above the loaded page (chatHistory.ts). */
    ordinalSource?: Message[];
  }
  let {
    messages,
    sessionId,
    inFlight,
    currentThoughtMsgId,
    currentAgentMsgId,
    openThoughtIds,
    onThoughtOpenIds,
    onImageClick,
    onRewind,
    onRetryTurn,
    readOnly = false, passthrough = false,
    focusMode = false, ordinalSource,
  }: Props = $props();
  /** A VIEW, never an edit: `messages` is untouched and every kept row passes
   *  through BY IDENTITY, so leaving focus puts every hidden row back. */
  const rows = $derived(focusMode ? foldForFocus(messages) : messages);
  /** The loop key: a focus gap carries its own, a message is keyed by id. */
  const keyOf = (msg: Message) => (isFocusGap(msg) ? msg.key : String(msg.id));
  /** CHANGES.md change 21 — adjacent tool calls draw as ONE stepped strip.
   *  Grouped AFTER the focus fold, so folding decides what is on screen and the
   *  strip only groups what survived; the fold's own behaviour is untouched. */
  const blocks = $derived(groupToolRuns(rows, keyOf));
  // The chat's T-numbers, off the FULL transcript rather than `rows`: a folded
  // focus view must not renumber the agents it happens to be hiding.
  const ordinals = $derived(subagentOrdinals(ordinalSource ?? messages));
  // A `task` card's own header is the word `task` (the engine titles the pending
  // call with the tool name), so the card is named the way the drawer names it.
  const taskName = (msg: Message) => subagentLabel(subagentIdentity(msg, ordinals.get(subagentKey(msg) ?? '') ?? 0));
  /** A card's header text. Passed DOWN to the run group because the T-number it
   *  reads is derived from the whole transcript, not from the run. */
  const nameOf = (msg: Message) => (msg.toolName === 'task' ? taskName(msg) : msg.label);

  // isEmptyAgentTurn is chatFocus.ts's (t-di3a0w): `foldForFocus` now swallows
  // these rows before they ever reach `rows` in focus mode, so the guard below
  // only fires in FULL view, where the row still passes through unfolded and
  // must keep showing — it is a real turn boundary there, and the rewind
  // control stays reachable. One definition, so the two views cannot disagree
  // about what "nothing to show" means.
</script>
{#each blocks as block (block.key)}
  {#if block.run}
    <!-- Two or more adjacent calls in one turn: ONE stepped strip. -->
    <ToolRunGroup rows={block.rows} {sessionId} {readOnly} {onImageClick} {nameOf} />
  {:else}
    {@const msg = block.row}
  {#if isFocusGap(msg)}
    <FocusGapRow label={msg.label} />
  {:else if msg.kind === 'tool'}
    <!-- A lone call. The same component, which draws it with no strip at all. -->
    <ToolRunGroup rows={[msg]} {sessionId} {readOnly} {onImageClick} {nameOf} />
  {:else if msg.kind === 'verdict' && msg.verdict}
    <VerdictRow verdict={msg.verdict} text={msg.text} />
  {:else if msg.kind === 'secondOpinion' && msg.secondOpinion}
    <!-- A DIFFERENT model's review of the turn above: hand the chat over, or dismiss. -->
    <SecondOpinionCard info={msg.secondOpinion} text={msg.text} {sessionId} {readOnly} />
  {:else if msg.kind === 'todoSummary' && msg.summaryTodos}
    <!-- The collapsed task-list snapshot left after the overlay closes. `interactive`
         makes its header a toggle, so the finished one-liner can be re-opened. -->
    <div class="todo-summary-msg">
      <TodoStrip todos={msg.summaryTodos} source="" interactive />
    </div>
  {:else if msg.kind === 'thought'}
    <!-- Reasoning-model thoughts. Open state is user-owned, so a manual expand survives. -->
    <ThoughtPill
      text={msg.text}
      label="Thought process"
      live={inFlight && currentThoughtMsgId === msg.id}
      open={isThoughtOpen(openThoughtIds, msg.id)}
      onToggle={(v: boolean) => onThoughtOpenIds(withThoughtOpen(openThoughtIds, msg.id, v))}
    />
  {:else if msg.kind === 'compacted'}
    <!-- /compact result. A collapsed native <details> keeps the carried-forward summary
         out of the transcript but available on demand. Reuses the thought-block styling. -->
    <details class="compaction-block" class:live={msg.compacting}>
      <summary class="compaction-summary">
        <span class="compaction-crane" aria-hidden="true"><CraneMark size={13} /></span>
        {#if msg.compacting}
          <span class="compaction-title">Compacting context…</span>
        {:else}
          <span class="compaction-title">Compaction Completed</span>
          <span class="compaction-sub">— frees space on your next message</span>
        {/if}
      </summary>
      <pre class="compaction-text">{msg.text || (msg.compacting ? '' : '(nothing beyond the recent turns needed carrying forward)')}</pre>
    </details>
  {:else if msg.kind === 'streamDrop' && msg.streamDrop}
    <!-- The ENGINE dropped a stream. NOT a MessageRow: this is the system
         speaking, so the agent's name stays off it (t-q90gj9). -->
    <SystemAlertRow
      row={msg.streamDrop}
      onRetry={readOnly || !onRetryTurn ? undefined : () => onRetryTurn(sessionId)}
    />
  {:else if msg.kind === 'engine' && msg.engine}
    <!-- This chat's OWN engine is starting, failed or stopped: the same card (engineNotice.ts). -->
    {@const alert = engineAlert(msg.engine)}
    <SystemAlertRow {alert} onRetry={readOnly || !alert.retry ? undefined : () => getVsCodeApi().postMessage({ type: 'engineRetry', sessionId })} />
  {:else if msg.kind === 'peer'}
    <!-- NOT a MessageRow: the badge + provenance are the whole point. -->
    <PeerMessageRow from={msg.label} replyTo={msg.peerReplyTo || ''} text={msg.text} timestamp={msg.timestamp} flock={msg.peerFlock} subagent={msg.peerSubagent} />
  {:else if msg.kind === 'agent'}
    <!-- Agent turn. Hover reveals a "Rewind here" affordance that rolls the working tree
         and transcript back to before this exchange. Hidden while a turn is in flight.
         Focus view additionally skips a turn with nothing to show — see isEmptyAgentTurn. -->
    {#if !(focusMode && isEmptyAgentTurn(msg))}
      <div class="agent-row" data-engine-msg={msg.engineMsgId}>
        <!-- `streaming`: this row is the OPEN agent message, so its prose is
             still arriving (MessageRow settles the colour itself). -->
        <MessageRow kind={msg.kind} label={msg.label} text={msg.text} images={msg.images} timestamp={msg.timestamp} tokensAtTurn={msg.tokensAtTurn} tokensThisTurn={msg.tokensThisTurn} ctxPctAtTurn={msg.ctxPctAtTurn} onImageClick={onImageClick} streaming={inFlight && currentAgentMsgId === msg.id} />
        {#if msg.engineMsgId && !inFlight && !readOnly && !passthrough && currentAgentMsgId !== msg.id}
          <button class="rewind-btn"
            use:tip={"Rewind to here — restores your files to before this exchange and drops this turn and everything after it (undoable until your next message)"}
            onclick={() => onRewind?.(sessionId, msg.engineMsgId)}>&#8630; Rewind here</button>
        {/if}
      </div>
    {/if}
  {:else}
    <MessageRow kind={msg.kind} label={msg.label} text={msg.text} images={msg.images} timestamp={msg.timestamp} tokensAtTurn={msg.tokensAtTurn} tokensThisTurn={msg.tokensThisTurn} ctxPctAtTurn={msg.ctxPctAtTurn} onImageClick={onImageClick} />
  {/if}
  {/if}
{/each}

<style>
  /* The per-turn verdict row's rules left WITH its markup (VerdictRow.svelte) —
     Svelte scopes <style> per component, so a rule kept here would have stopped
     matching silently. The same is true of the second-opinion card. */
  /* /compact status row. Flitters into the transcript as a compaction event;
     the Origami crane pulses while the turn is live, then settles. Its collapsed
     body used to borrow .thought-text; that rule left with the pill, so the
     block carries its own copy rather than reaching into another component. */
  .compaction-text {
    margin: 0;
    padding: 2px 12px 8px 20px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--og-text-muted);
    line-height: 1.5;
  }
  /* Rewind affordance — a hover-reveal control under each agent turn. Kept
     unobtrusive (transparent, dim) so it never competes with the transcript;
     warms to a warning tint on hover because it's a destructive-ish action. */
  .agent-row { position: relative; }
  .rewind-btn {
    display: block;
    margin: 1px 0 6px auto;
    font-size: 10px;
    font-family: inherit;
    padding: 1px 7px;
    background: transparent;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }
  .agent-row:hover .rewind-btn { opacity: 0.65; }
  .rewind-btn:hover { opacity: 1; color: var(--og-warning); border-color: var(--og-warning); }
  .rewind-btn:focus-visible { opacity: 1; outline: 1px solid var(--og-chat); outline-offset: 1px; }
  .compaction-block {
    margin: 6px 0;
    border-left: 3px solid var(--og-crane);
    border-radius: 4px;
    background: var(--og-surface);
    font-size: 11px;
    opacity: 0.92;
    animation: compaction-flitter 0.34s ease both;
  }
  @keyframes compaction-flitter {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 0.92; transform: translateY(0); }
  }
  .compaction-summary {
    cursor: pointer;
    padding: 5px 8px;
    color: var(--og-text-muted);
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .compaction-summary::-webkit-details-marker { display: none; }
  .compaction-summary::before {
    content: '\25B8'; /* chevron, rotates when open */
    display: inline-block;
    transition: transform 0.12s ease;
    color: var(--og-text-muted);
  }
  .compaction-block[open] .compaction-summary::before { transform: rotate(90deg); }
  .compaction-crane {
    display: inline-flex;
    color: var(--og-crane);
  }
  .compaction-block.live .compaction-crane { animation: compaction-pulse 1s ease-in-out infinite; }
  @keyframes compaction-pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .compaction-title { color: var(--og-text); font-weight: 500; }
  .compaction-block.live .compaction-title { color: var(--og-crane); }
  .compaction-sub { color: var(--og-text-muted); font-style: italic; }
  /* The collapsed snapshot left inline in the transcript after the overlay
     closes — TodoStrip self-collapses to a one-liner when all done. Drop
     its sticky so it scrolls with the history. */
  .todo-summary-msg {
    margin: 4px 0 8px 0;
  }
  .todo-summary-msg :global(.todo-strip) {
    position: static;
    margin: 0;
  }
</style>
