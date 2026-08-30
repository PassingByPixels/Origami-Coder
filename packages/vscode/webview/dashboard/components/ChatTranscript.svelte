<script lang="ts">
  // ChatTranscript.svelte — ONE chat's message rows, and nothing else.
  //
  // EXTRACTED VERBATIM from ChatPane.svelte's `{#each cellSession.messages}`
  // loop (the pane was at 2700/2700) so a SECOND caller can render the same
  // rows — a read-only transcript — through the SAME renderer instead of a
  // lookalike that drifts. This commit adds no second caller and no read-only
  // mode: it is the move only.
  //
  // WHY EVERY RULE CAME WITH IT. Svelte scopes <style> per component, so a
  // selector left behind in the pane simply stops matching the markup that
  // moved — no error, no warning, and no test can see it, because the vitest
  // config never puts a <style> element in the DOM. So every rule that targets
  // a row below moved with it: .turn-verdict*, .compaction-*, .agent-row +
  // .rewind-btn, and .todo-summary-msg with its :global(.todo-strip) partner
  // (that partner needs its scoped ancestor, which is now here).
  // What deliberately STAYED in the pane, because it is not a row:
  // .cell-messages (the scroller these rows sit in), .agent-banner and the
  // pinned-user mirror (once-off headers ABOVE the loop), .rewind-undo (the
  // staged-rewind banner BELOW it), and .arbiter-* (cell chrome).
  //
  // THE PROP BOUNDARY. The loop closed over `cellSession`, but the whole
  // session is the WRONG prop: the read-only caller this exists for has a
  // message list and no session at all, and would have to fabricate thirty
  // fields to borrow the renderer. So each field the markup ACTUALLY read is
  // its own prop, named after the field it came from, and the two things the
  // markup wrote (open the lightbox, rewind a turn) are callbacks the pane
  // wires back to its own state.
  import ToolCard from './ToolCard.svelte';
  import MessageRow from './MessageRow.svelte';
  import TodoStrip from './TodoStrip.svelte';
  import ThoughtPill from './ThoughtPill.svelte';
  import PeerMessageRow from './PeerMessageRow.svelte';
  import FocusGapRow from './FocusGap.svelte';
  import CraneMark from '../../shared/CraneMark.svelte';
  import { isThoughtOpen, withThoughtOpen } from '../panes/thoughtOpenState';
  import { foldForFocus, isFocusGap } from './focusGaps';
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
    /** The thought row currently streaming, and the agent row that is the
     *  in-flight bubble. Both null between turns. */
    currentThoughtMsgId: number | null;
    currentAgentMsgId: number | null;
    /** Which reasoning blocks the user opened by hand (thoughtOpenState.ts). */
    openThoughtIds: number[] | undefined;
    /** The next open-set after a pill toggle. The RULE that computes it stays
     *  here with the markup; the pane owns the session field it lands on. */
    onThoughtOpenIds: (ids: number[]) => void;
    /** An image in a row was clicked. One lightbox serves the whole pane, so
     *  the row only reports the click upward. Omit it and MessageRow leaves the
     *  image inert — a caller with no lightbox of its own, not a safety gate:
     *  enlarging a picture changes nothing on the machine. */
    onImageClick?: (src: string, alt: string) => void;
    /** "Rewind here" on an agent row — the same (sessionId, engineMsgId) shape
     *  the pane's rewindTo already took. Never called in read-only mode. */
    onRewind?: (sessionId: string, engineMsgId?: string) => void;
    /**
     * These rows are HISTORY — a sub-agent's stored session, replayed here so
     * a finished child reads the way the chat that spawned it does.
     *
     * It kills the two controls that act on the user's machine or on the LIVE
     * turn, and it has to reach BOTH levels because they live at both: the
     * rewind button is in this file (it posts revertToMessage, which rolls the
     * working tree back — by far the most dangerous control to leave armed on
     * a transcript from an hour ago), while ToolCard's Kill and Stop are one
     * component down and take their own `readOnly`. Hiding markup here alone
     * would leave those two live.
     *
     * What deliberately KEEPS working: every openAbsoluteFile sender (the path
     * chips, a bash card's full output, a grep hit, a file link in prose).
     * Opening a file the sub-agent touched is the whole point of reading its
     * transcript, and it mutates nothing.
     */
    readOnly?: boolean;
    /** FOCUS VIEW — draw only what was SAID (user, agent and peer prose), each
     *  run of hidden rows folded to ONE counted divider so the work between two
     *  answers survives as a number. Default false, so a caller that does not
     *  ask for it — the live pane, the read-only sub-agent transcript — renders
     *  what it always did. The rule is chatFocus.ts's, the fold focusGaps.ts's. */
    focusMode?: boolean;
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
    readOnly = false,
    focusMode = false,
  }: Props = $props();
  /** A VIEW, never an edit: `messages` is untouched and every kept row passes
   *  through BY IDENTITY, so leaving focus puts every hidden row back. */
  const rows = $derived(focusMode ? foldForFocus(messages) : messages);
</script>
{#each rows as msg (isFocusGap(msg) ? msg.key : msg.id)}
  {#if isFocusGap(msg)}
    <FocusGapRow label={msg.label} />
  {:else if msg.kind === 'tool'}
    <ToolCard
      title={msg.label}
      kind={msg.toolKind || 'other'}
      toolName={msg.toolName || ''}
      status={msg.toolStatus || 'completed'}
      result={msg.toolResult}
      diff={msg.toolDiff}
      path={msg.toolPath}
      stream={msg.taskStream}
      resumed={msg.taskResumed}
      shell={msg.toolShell}
      toolLines={msg.toolLines}
      images={msg.toolImages} browser={msg.toolBrowser}
      sessionId={sessionId} startedAt={msg.timestamp} {readOnly}
    />
  {:else if msg.kind === 'verdict' && msg.verdict}
    <!-- Honest per-turn TERMINAL verdict, anchored inline at
         the end of the turn it resolved. `incomplete` is red:
         a budget-walled / no-progress / errored / parked-infra
         turn must NOT read as benign progress. -->
    <div class="turn-verdict verdict-{msg.verdict.kind}" title={msg.verdict.reason}>
      <span class="verdict-dot" aria-hidden="true"></span>
      <span class="verdict-text">{msg.text}</span>
    </div>
  {:else if msg.kind === 'todoSummary' && msg.summaryTodos}
    <!-- The collapsed task-list snapshot left in the transcript
         after the overlay closes. `interactive` makes its header a
         toggle so the finished one-liner can be re-opened to show
         the items the agent tracked. -->
    <div class="todo-summary-msg">
      <TodoStrip todos={msg.summaryTodos} source="" interactive />
    </div>
  {:else if msg.kind === 'thought'}
    <!-- Reasoning-model thoughts (ThoughtPill.svelte). Open state is
         user-owned so a manual expand survives further deltas. -->
    <ThoughtPill
      text={msg.text}
      label="Thought process"
      live={inFlight && currentThoughtMsgId === msg.id}
      open={isThoughtOpen(openThoughtIds, msg.id)}
      onToggle={(v: boolean) => onThoughtOpenIds(withThoughtOpen(openThoughtIds, msg.id, v))}
    />
  {:else if msg.kind === 'compacted'}
    <!-- /compact result. A collapsed native <details> keeps the
         carried-forward summary out of the transcript but available on
         demand: "Compaction Completed" reads as a status divider;
         expand to see exactly what survived the compaction. Reuses the
         thought-block styling (collapsed, dim, mono). -->
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
  {:else if msg.kind === 'peer'}
    <!-- NOT a MessageRow: the badge + provenance are the whole point. -->
    <PeerMessageRow from={msg.label} replyTo={msg.peerReplyTo || ''} text={msg.text} timestamp={msg.timestamp} />
  {:else if msg.kind === 'agent'}
    <!-- Agent turn. Hover reveals a "Rewind here" affordance that
         deterministically rolls the working tree + transcript back to
         before this exchange. Hidden on the in-flight bubble and while
         a turn is composing (can't rewind mid-turn). -->
    <div class="agent-row">
      <MessageRow kind={msg.kind} label={msg.label} text={msg.text} images={msg.images} timestamp={msg.timestamp} tokensAtTurn={msg.tokensAtTurn} tokensThisTurn={msg.tokensThisTurn} ctxPctAtTurn={msg.ctxPctAtTurn} onImageClick={onImageClick} />
      {#if msg.engineMsgId && !inFlight && !readOnly && currentAgentMsgId !== msg.id}
        <button class="rewind-btn"
          title="Rewind to here — restores your files to before this exchange and drops this turn and everything after it (undoable until your next message)"
          onclick={() => onRewind?.(sessionId, msg.engineMsgId)}>&#8630; Rewind here</button>
      {/if}
    </div>
  {:else}
    <MessageRow kind={msg.kind} label={msg.label} text={msg.text} images={msg.images} timestamp={msg.timestamp} tokensAtTurn={msg.tokensAtTurn} tokensThisTurn={msg.tokensThisTurn} ctxPctAtTurn={msg.ctxPctAtTurn} onImageClick={onImageClick} />
  {/if}
{/each}

<style>
  /* Inline per-turn terminal verdict row — sits at the end of the turn
     it resolved, so the scrollback shows what each turn actually came
     to (not a single replaced-in-place chip). */
  .turn-verdict {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 6px 0 10px 0;
    padding: 4px 10px;
    font-size: 11px;
    border-radius: 6px;
    border: 1px solid var(--og-border);
    background: var(--og-surface-alt);
  }
  .turn-verdict .verdict-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    background: var(--og-text-muted);
  }
  .turn-verdict .verdict-text {
    color: var(--og-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn-verdict.verdict-done .verdict-dot { background: var(--og-success); }
  .turn-verdict.verdict-done .verdict-text { color: var(--og-text); }
  .turn-verdict.verdict-parked .verdict-dot { background: var(--og-warning); }
  /* Incomplete/failed terminal — red. The thesis headline: this can
     never collapse to a benign "Continue". */
  .turn-verdict.verdict-incomplete {
    border-color: color-mix(in srgb, var(--og-error) 45%, var(--og-border));
    background: color-mix(in srgb, var(--og-error) 10%, var(--og-surface-alt));
  }
  .turn-verdict.verdict-incomplete .verdict-dot { background: var(--og-error); }
  .turn-verdict.verdict-incomplete .verdict-text { color: var(--og-error); font-weight: 600; }
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
