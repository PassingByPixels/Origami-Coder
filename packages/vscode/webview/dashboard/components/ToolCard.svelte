<script lang="ts">
  // Pillar 2 dashboard upgrade (2026-05-22) — refactored from a
  // monolithic renderer to a thin dispatcher. The frame (header,
  // status spinner, expand-arrow, expanded body container) stays
  // here; the expanded body is rendered by a per-tool specialised
  // card from `./toolcards/`. Unknown tool names fall back to
  // GenericCard which keeps the old `<pre>` behaviour.
  //
  // Pre-Pillar-2 behaviour preserved for every kind: the EditCard
  // is byte-for-byte identical to the old diff branch; everything
  // else hits GenericCard which renders identically to the old
  // fallback. The visible improvement is that subsequent slices
  // can drop in GrepCard / BashCard / etc. without touching this
  // file.

  import { untrack } from 'svelte';
  import EditCard from './toolcards/EditCard.svelte';
  import GenericCard from './toolcards/GenericCard.svelte';
  import GrepCard from './toolcards/GrepCard.svelte';
  import ReadFileCard from './toolcards/ReadFileCard.svelte';
  import BashCard from './toolcards/BashCard.svelte';
  import BrowserCard from './toolcards/BrowserCard.svelte';
  import ChartCard from './toolcards/ChartCard.svelte';
  import WriteFileCard from './toolcards/WriteFileCard.svelte';
  import MultiEditCard from './toolcards/MultiEditCard.svelte';
  import FileListCard from './toolcards/FileListCard.svelte';
  import TaskCard from './toolcards/TaskCard.svelte';
  import TaskParallelCard from './toolcards/TaskParallelCard.svelte';
  import { getVsCodeApi } from '../../shared/vscodeApi';
  import { parseSpec } from '../../shared/chartBlock';
  import { stuckState } from './toolcards/stuckCall';
  import type { ToolShell, ToolLines, ToolBrowser } from '../panes/chatToolMsg';

  const vscode = getVsCodeApi();
  // Open the tool's file in the editor. The header path is the actionable
  // "where" for every tool kind (read/write/edit/glob), so opening from here
  // fixes them all at once — the per-card body buttons only cover some cards
  // and only when the card is expanded. No `preview` field → the host opens the
  // real editor (see openAbsoluteFile), which is what "pull up the file" means.
  // `line` (1-based) jumps to a read card's actual clamped range start —
  // mirrors GrepCard's per-hit line-jump; absent for every other card, which
  // opens as before.
  function openPath(p: string, line?: number) {
    if (!p) return;
    vscode.postMessage(
      line ? { type: 'openAbsoluteFile', path: p, line } : { type: 'openAbsoluteFile', path: p },
    );
  }

  interface Props {
    title: string;
    kind: string;
    /**
     * Actual tool name from `_meta.origami_tool_name` — the engine stamps it
     * on every tool_call/update (acp/tool.ts) and acpClient extracts it.
     * Empty only for non-Origami ACP servers, where dispatch falls through
     * to the ACP `kind` below.
     */
    toolName?: string;
    status: string;
    result?: string;
    /**
     * Structured before/after diff for edit tools, from the ACP
     * `{type:'diff'}` content block. EditCard renders a real line diff
     * from it; ignored by the other cards.
     */
    diff?: { path: string; oldText: string; newText: string };
    /** File path the tool acted on (read/write/edit), from ACP locations.
     *  Shown in the header so "write" tells you WHERE it wrote. */
    path?: string;
    /**
     * `task` only: the sub-agent's live output, streamed from the engine while it
     * works. Makes the card have a body (and so an expand arrow) BEFORE the
     * sub-agent returns anything — the whole point being that a running sub-agent
     * stops being a spinner with nothing behind it.
     */
    stream?: string;
    /**
     * `task` only: this card CONTINUES a sub-agent this chat already showed
     * (same task session id) rather than spawning a new one. Presentation only —
     * without it a resumed agent and a fresh one are indistinguishable, which is
     * how a "multi-turn" delegation quietly becomes two separate agents.
     */
    resumed?: boolean;
    /** Bash only: command/cwd/timeout in, exit/truncation out — shaped off the
     *  wire by chatToolMsg.ts. Drives BashCard's IN/OUT blocks and the honest
     *  exit icon below (a non-zero exit must never read as a green ✓). */
    shell?: ToolShell;
    /** Read only: the actual clamped line range returned, shaped off the wire
     *  by chatToolMsg.ts. Renders as a muted suffix after the path; absent for
     *  every other tool. */
    toolLines?: ToolLines;
    /** `browser` only: screenshots the tool returned, as data: URIs. BrowserCard
     *  renders them inline; every other card ignores them. */
    images?: string[];
    /** `browser` only: the tool's own ok/action/url verdict off its metadata,
     *  shaped by chatToolMeta.ts. Drives the honest icon below — the engine
     *  COMPLETES a failed browser call, exactly as it completes a failing bash
     *  command, so status alone would paint it green. */
    browser?: ToolBrowser;
    /** Bash only: the chat session, so a stuck command can be stopped from its
     *  own card instead of from the chat bar at the bottom of the transcript. */
    sessionId?: string;
    /** Bash only: when the call started, so the card can show its age. */
    startedAt?: number;
    /**
     * This card is HISTORY, not a live turn — a sub-agent transcript replayed
     * from the store. Kill and Stop are dead: both act on whatever is running
     * NOW, so on a card from an hour ago they would cancel an unrelated turn
     * or kill an unrelated job. An EXPLICIT flag rather than leaning on an
     * empty `sessionId`: the guards below are a defence against a missing id,
     * not a contract about liveness, and someone tidying them away would
     * silently bring both controls back to life on a historical card.
     */
    readOnly?: boolean;
  }

  // The age + Kill controls live in the HEADER, not in the card body, because
  // the body is only mounted once the user expands the card — and a card starts
  // collapsed. Shipped in the body first, they were unreachable on exactly the
  // card that needed them: a live bash call nobody had clicked on.

  let { title, kind, toolName = '', status, result, diff, path, stream, resumed = false, shell, toolLines, images, browser, sessionId, startedAt, readOnly = false }: Props = $props();
  // Every other card opens on click: its body is detail behind a one-line
  // summary. A chart's body IS the answer — the tool exists to put a picture in
  // the chat — so a chart the user must find and expand is the silent failure
  // again, wearing a green check. Set once at construction; a card's tool name
  // never changes under it, so the one-shot read is untracked deliberately —
  // re-deriving it would re-open a card the user had closed.
  let expanded = $state(untrack(() => toolName === 'chart'));

  const kindIcons: Record<string, string> = {
    filesystem: '\u{1F4C1}',
    bash: '\u{1F4BB}',
    network: '\u{1F310}',
    edit: '✏️',
    other: '⚙️',
    read: '\u{1F4C4}',
    search: '\u{1F50D}',
    execute: '\u{1F4BB}',
    move: '\u{1F4E4}',
    fetch: '\u{1F310}',
    think: '\u{1F9E0}',
  };

  // A `task` / `task_parallel` call is the model delegating to a sub-agent.
  // It otherwise renders like a generic "think" tool — make the delegation
  // unmistakable with a distinct icon + a "sub-agent" badge in the header.
  let isTask = $derived(toolName === 'task' || toolName === 'task_parallel');
  let icon = $derived(isTask ? '\u{1F91D}' : (kindIcons[kind] || kindIcons.other));
  // Honest status mapping: `completed` is the ONLY green; `failed` is
  // red; pending/in_progress is the in-flight spinner. The donor folded
  // "has any result text" into done (`status === 'completed' || !!result`),
  // so a FAILED tool — whose error text lands in `result` — rendered as a
  // green ✓. That is the v1 "UI claims progress the engine didn't make"
  // sin. Status alone decides now.
  let done = $derived(status === 'completed');
  let failed = $derived(status === 'failed');
  // A bash call is "execute" kind (or named bash/shell over the wire). It
  // always has a body — the IN block (the command) exists before any output.
  let isShell = $derived(toolName === 'bash' || toolName === 'shell' || kind === 'execute');
  // Honest exit: the engine COMPLETES a bash call whatever its exit code (the
  // output goes back to the model either way), so status alone painted a
  // failing command green. A known non-zero exit gets the red ✗.
  let exitFail = $derived(isShell && typeof shell?.exit === 'number' && shell.exit !== 0);
  // The browser card, like the bash one, always has a body: the IN rail (the
  // action and its target) exists before the page answers.
  let isBrowser = $derived(toolName === 'browser');
  // `chart` dispatches by NAME for the same reason `browser` does: its ACP kind
  // is the catch-all `other` (acp/tool.ts names no case for it), which is the
  // GenericCard bucket — and a <pre> of JSON is not a chart.
  let isChart = $derived(toolName === 'chart');
  // The browser's exitFail. A refusal, an unreachable client and a capture that
  // returned no image all come back COMPLETED, so the metadata flag is the only
  // thing that separates them from a page that loaded. Read the flag, never the
  // title prose — the title is wording, not a status.
  let browserFail = $derived(isBrowser && browser?.ok === false);
  // A chart that ACTUALLY DREW, which is not the same fact as "this tool is
  // called chart". The tool name is known before the result is, so keying
  // anything on it treats a refusal and a half-streamed frame as pictures. Only
  // the renderer's own parse of the returned spec says a picture exists — never
  // the title prose, which reads "chart bar: refused" and is only wording.
  let chartDrawn = $derived(isChart && done && !!parseSpec(result ?? ''));
  // The chart's exitFail. The engine COMPLETES a chart call it refused, so
  // status paints it green; and a spec the shared renderer cannot draw is a
  // chart the user never sees, whatever the engine thought.
  let chartFail = $derived(isChart && done && !chartDrawn);
  let hasBody = $derived(!!result || !!diff || !!stream || isShell || isBrowser);

  // A wedged command is invisible from here: the card says "running…" at second
  // 2 and at second 900 in exactly the same words, and the user's only recourse
  // — the chat's Stop control — is nowhere near the thing that is stuck.
  let shellRunning = $derived(isShell && status !== 'completed' && status !== 'failed');
  let shellState = $derived(shell?.state ?? (shell?.background ? 'background' : 'foreground'));
  let shellStartedAt = $derived(shell?.startedAt ?? startedAt);
  let now = $state(Date.now());
  $effect(() => {
    if (!shellRunning || !shellStartedAt) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Read off `now`, seeded at construction, so a card mounted onto an
  // already-old call is correct on its first frame rather than a tick later.
  let elapsed = $derived(shellStartedAt ? Math.max(0, Math.floor((now - shellStartedAt) / 1000)) : undefined);
  let outputAge = $derived(shell?.lastOutputAt ? Math.max(0, Math.floor((now - shell.lastOutputAt) / 1000)) : undefined);
  let age = $derived(stuckState({ running: shellRunning && shellState === 'foreground', startedAt: shellStartedAt, now }));
  // The extension's existing turn-stop, the same message the chat's own Stop
  // sends — no new endpoint. The chain that makes it reach THIS command:
  // DashboardPanel case 'cancel' -> AcpClient.cancel -> ACP.cancel ->
  // sdk.session.abort -> the http api's session abort -> SessionPrompt.cancel,
  // which interrupts the turn, fires the shell tool's ctx.abort arm and
  // tree-kills the process.
  function kill() {
    if (readOnly || !sessionId) return;
    vscode.postMessage({ type: 'cancel', sessionId });
  }
  function stopBackground() {
    if (readOnly || !sessionId || !shell?.jobId) return;
    vscode.postMessage({ type: 'stopBackgroundShell', sessionId, jobId: shell.jobId });
  }

  // Dispatch: an explicit tool name wins (forward-compat / tests);
  // otherwise the ACP `kind` selects the renderer. We only specialise
  // where the card renders the engine's REAL output without a false signal:
  //   edit   → EditCard   (structured diff)
  //   read   → ReadFileCard (graceful — header optional, adds highlight)
  //   search → GrepCard   (graceful — non-`path:line:` lines → preamble)
  //   execute → BashCard  (IN/OUT blocks off the TS engine's real contract:
  //             title = the command, exit/truncation via `shell`)
  // fetch/think/other → GenericCard.
  type CardComponent =
    | typeof EditCard
    | typeof GenericCard
    | typeof GrepCard
    | typeof ReadFileCard
    | typeof BashCard
    | typeof BrowserCard
    | typeof ChartCard
    | typeof WriteFileCard
    | typeof MultiEditCard
    | typeof FileListCard
    | typeof TaskCard
    | typeof TaskParallelCard;
  const TOOLCARD_REGISTRY: Record<string, CardComponent> = {
    edit: EditCard,
    multi_edit: MultiEditCard,
    grep: GrepCard,
    read_file: ReadFileCard,
    read: ReadFileCard,
    bash: BashCard,
    run: BashCard,
    write_file: WriteFileCard,
    write: WriteFileCard,
    glob: FileListCard,
    list_dir: FileListCard,
    task: TaskCard,
    task_parallel: TaskParallelCard,
  };
  const KIND_REGISTRY: Record<string, CardComponent> = {
    edit: EditCard,
    read: ReadFileCard,
    search: GrepCard,
    execute: BashCard,
  };
  // `task`/`task_parallel` dispatch by tool NAME; bash/shell (isShell folds in
  // kind 'execute') land on BashCard, rewritten against the TS engine's real
  // output contract; `browser` also dispatches by NAME, because its ACP kind is
  // `fetch` — the same bucket the plain webfetch tool lands in, which has no
  // page to screenshot; `chart` by NAME too, its kind being the `other`
  // catch-all; the rest dispatch by ACP kind.
  let CardComponent = $derived(
    isTask ? (TOOLCARD_REGISTRY[toolName] ?? GenericCard)
    : isShell ? BashCard
    : isBrowser ? BrowserCard
    : isChart ? ChartCard
    : (KIND_REGISTRY[kind] || GenericCard),
  );
</script>

<div class="tool-card" class:done class:failed class:task={isTask}>
  <button class="tool-header" onclick={() => expanded = !expanded}>
    <span class="tool-icon">{icon}</span>
    <span class="tool-title">{title}</span>
    {#if isTask}<span class="tool-badge" title="Delegated to a sub-agent">sub-agent</span>{/if}
    {#if isTask && resumed}<span class="tool-resumed" title="Continues a sub-agent session already used in this chat — not a fresh agent">resumed</span>{/if}
    <!-- Keyed on `result`, not `hasBody`: a live stream now counts as a body, but
         a sub-agent that streamed work and RETURNED nothing must still say so. -->
    {#if isTask && done && !result}<span class="tool-empty" title="The sub-agent finished without returning any text">no output</span>{/if}
    {#if path}
      <!-- The path OPENS the file (stopPropagation so it doesn't also toggle the
           card's expand). Click the icon/title/status to expand instead. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="tool-path"
        role="link"
        title={`Open ${path}`}
        onclick={(e) => { e.stopPropagation(); openPath(path, toolLines?.start); }}
      >{path}</span>
      {#if toolLines}
        <!-- The actual clamped range a read tool returned — not clickable
             itself; the path span above already jumps to toolLines.start.
             No leading space: svelte trims it at compile time, so it never
             reached the DOM. The header's flex `gap` does the separating. -->
        <span class="tool-lines">(lines {toolLines.start}-{toolLines.end})</span>
      {/if}
    {/if}
    <span class="tool-status">
      {#if failed}
        <span class="cross" title="failed">{'✗'}</span>
      {:else if exitFail}
        <span class="cross" title={`exit ${shell?.exit}`}>{'✗'}</span>
      {:else if browserFail}
        <span class="cross" title={`browser ${browser?.action ?? 'call'} failed`}>{'✗'}</span>
      {:else if chartFail}
        <span class="cross" title="no chart was drawn">{'✗'}</span>
      {:else if done}
        <span class="check">{'✓'}</span>
      {:else}
        <span class="spinner"></span>
      {/if}
    </span>
    {#if hasBody}
      <span class="expand-arrow" class:open={expanded}>{'▶'}</span>
    {/if}
  </button>
  {#if isShell && shellStartedAt}
    <div class="tool-shell-live">
      <span>{shellState}</span>
      <!-- `elapsed` is now MINUS the start stamp: a LIVENESS reading, not a
           duration. In a read-only historical transcript there is no live
           progress to report and no honest start stamp to measure from (the
           replayed card is stamped when it is rebuilt), so this would print
           "0s elapsed" under every settled command in a sub-agent's log. A
           real per-command duration would need the engine to carry start AND
           end; until it does, saying nothing beats saying zero. -->
      {#if !age.stuck && elapsed !== undefined && !readOnly}<span>{elapsed}s elapsed</span>{/if}
      {#if outputAge !== undefined}<span>output {outputAge}s ago</span>{/if}
      {#if shellRunning && shellState !== 'foreground' && shell?.jobId && !readOnly}
        <button class="tool-stuck-kill" title="Stop this background command" onclick={stopBackground}>Stop</button>
      {/if}
    </div>
  {/if}
  <!-- Its own strip UNDER the header, not inside it: the header is the expand
       button, and a button inside a button is neither valid nor operable. Being
       a sibling of the body rather than part of it is the whole fix — it shows
       on a collapsed card, which is every card the user has not clicked. -->
  <!-- Not in read-only: "has been running for a while" is a claim about NOW,
       and a card in a finished sub-agent's transcript is not running at all. -->
  {#if age.stuck && !readOnly}
    <div class="tool-stuck">
      <span class="tool-stuck-age" title="This command has been running for a while">{age.elapsed}s elapsed</span>
      {#if sessionId && !readOnly}
        <button class="tool-stuck-kill" title="Stop the turn and kill this command" onclick={kill}>Kill</button>
      {/if}
    </div>
  {/if}
  {#if expanded && hasBody}
    <div class="tool-result" class:chart={chartDrawn}>
      <CardComponent result={result ?? ''} {diff} {path} {title} {stream} {status} {shell} {images} {browser} />
    </div>
  {/if}
</div>

<style>
  .tool-card {
    margin: 2px 0;
    border-radius: 4px;
    border: 1px solid var(--og-border);
    background: var(--og-surface);
    overflow: hidden;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    background: none;
    border: none;
    color: var(--og-text);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    text-align: left;
  }
  .tool-header:hover {
    background: var(--og-btn-bg);
  }
  .tool-shell-live {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 8px 4px 26px;
    color: var(--og-text-muted);
    font-size: 10px;
  }

  .tool-icon {
    font-size: 12px;
    flex-shrink: 0;
  }

  .tool-title {
    flex: 0 1 auto;
    color: var(--og-text-secondary);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The file path the tool touched — the actionable "where". Gets the
     remaining width and ellipsises from the LEFT so the filename stays
     visible on long paths. */
  .tool-path {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
    cursor: pointer;
  }
  .tool-path:hover {
    color: var(--og-accent, #89b4fa);
    text-decoration: underline;
  }

  /* The clamped range a read tool returned — same muted scale as .tool-path,
     but never clickable and never shrinks (the range itself must stay legible). */
  .tool-lines {
    flex-shrink: 0;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  /* Honest "no output" marker — a sub-agent that finished without returning
     any text must not read as a silent success. */
  .tool-empty {
    flex-shrink: 0;
    font-size: 9px;
    font-style: italic;
    color: var(--og-warning);
  }

  /* A sub-agent (task) delegation must be unmistakable vs the main agent's
     own tool calls — an accent spine + a faint tint on the WHOLE card, not
     just a chip that blends into a wall of tool cards. */
  .tool-card.task {
    border-left: 3px solid var(--og-chat);
    background: color-mix(in srgb, var(--og-chat) 8%, var(--og-surface));
  }

  /* "sub-agent" badge — a solid accent chip so the delegation reads at a glance. */
  .tool-badge {
    flex-shrink: 0;
    padding: 1px 7px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    border-radius: 8px;
    color: var(--og-bg);
    background: var(--og-chat);
  }

  /* "resumed" — deliberately an OUTLINE chip beside the solid sub-agent badge:
     it qualifies the delegation, it isn't a second one. */
  .tool-resumed {
    flex-shrink: 0;
    padding: 1px 6px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    border-radius: 8px;
    color: var(--og-chat);
    border: 1px solid color-mix(in srgb, var(--og-chat) 55%, transparent);
  }

  .tool-status {
    flex-shrink: 0;
  }

  .check {
    color: var(--og-success);
    font-weight: 700;
  }

  /* Honest failure — a red ✗, distinct from the green ✓. A failed tool
     must never read as completed. */
  .cross {
    color: var(--og-error);
    font-weight: 700;
  }
  .tool-card.failed {
    border-color: color-mix(in srgb, var(--og-error) 45%, var(--og-border));
  }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--og-border);
    border-top-color: var(--og-warning);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .expand-arrow {
    font-size: 8px;
    color: var(--og-text-muted);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .expand-arrow.open {
    transform: rotate(90deg);
  }

  /* The long-running strip. Deliberately quiet: an old command may still be
     perfectly fine, so this is a warning about AGE, not a verdict on the call. */
  .tool-stuck {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-top: 1px solid var(--og-border);
    font-size: 9px;
    font-weight: 600;
  }
  .tool-stuck-age {
    color: var(--og-warning);
  }
  /* Kill is destructive, so it reads as the error colour and is outlined. */
  .tool-stuck-kill {
    padding: 1px 7px;
    border-radius: 8px;
    font-size: 9px;
    font-weight: 600;
    font-family: inherit;
    background: var(--og-btn-bg);
    color: var(--og-error);
    border: 1px solid color-mix(in srgb, var(--og-error) 55%, transparent);
    cursor: pointer;
  }
  .tool-stuck-kill:hover {
    color: var(--og-text);
    background: color-mix(in srgb, var(--og-error) 25%, transparent);
  }

  .tool-result {
    border-top: 1px solid var(--og-border);
    padding: 6px 8px;
    max-height: 200px;
    overflow: auto;
  }
  /* A DRAWN chart alone opts out of the 200px window — see chartDrawn above,
     not the tool name: a refused call's body is prose, and prose set loose from
     both the clamp and the scroll box is the one card that never needed either.
     Every other body is detail behind a summary, where a scroll box is right; a
     drawn chart's body IS the answer, and it does not fit — the renderer's svg
     is width:100% up to 520px over a 480-wide viewBox, so an ordinary titled bar
     (viewBox height 192) draws 208px tall at full width, a titled 2-series or a
     5-slice pie more. Clamped, every real chart arrived cropped inside a scroll
     box: the same silent failure that opening the card by default exists to
     end. */
  .tool-result.chart {
    max-height: none;
    overflow: visible;
  }
</style>
