<script lang="ts">
  import { spotlight } from '../../shared/spotlight';
  import { tip } from '../../shared/warmTip';
  // A thin dispatcher: the frame (header, status spinner, expand-arrow,
  // expanded body container) stays here; the expanded body is rendered by a
  // per-tool specialised card from `./toolcards/`. Unknown tool names fall
  // back to GenericCard, which keeps the plain `<pre>` behaviour.

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
  import StatusMark from './StatusMark.svelte';
  import ArtifactCard from './ArtifactCard.svelte';
  import { findArtifactLinks } from './artifactLink';
  import type { ToolShell, ToolLines, ToolBrowser, ToolReadImage } from '../panes/chatToolMsg';

  const vscode = getVsCodeApi();
  // Open the tool's file in the editor. The header path is the actionable
  // "where" for every tool kind, so opening from here fixes them all at once.
  // `line` (1-based) jumps to a read card's clamped range start; absent for
  // every other card, which opens as before.
  // CHANGES.md change 46 — the header path REVEALS the file in the OS explorer.
  // A path is the answer to "where is this?", and the owner's answer is the
  // folder, not another editor tab. Deliberately every card kind, not just the
  // image one: one path, one meaning. The host resolves a workspace-relative
  // path the same way `openAbsoluteFile` does (DashboardPanel.ts), and the
  // phone is refused the verb outright (remoteRefusalsTable.ts).
  function revealPath(p: string) {
    if (!p) return;
    vscode.postMessage({ type: 'revealInExplorer', path: p });
  }
  // ...and the RANGE still opens the file in the editor at its start line.
  // The owner's ruling on the port above: a path answers "where is this?" and
  // the answer is the folder, but "(lines 26-61)" answers "what did it read?",
  // and the answer to THAT is the file, open, at that line. Two controls side
  // by side, two jobs, neither standing in for the other.
  function openAtLine(p: string, line?: number) {
    if (!p) return;
    vscode.postMessage(line ? { type: 'openAbsoluteFile', path: p, line } : { type: 'openAbsoluteFile', path: p });
  }

  interface Props {
    title: string;
    kind: string;
    /** Actual tool name from `_meta.origami_tool_name` (acp/tool.ts). Empty
     *  only for non-Origami ACP servers, where dispatch falls through to the
     *  ACP `kind` below. */
    toolName?: string;
    status: string;
    result?: string;
    /** Structured before/after diff for edit tools, from the ACP `{type:'diff'}`
     *  content block. EditCard renders a real line diff; ignored elsewhere. */
    diff?: { path: string; oldText: string; newText: string };
    /** File path the tool acted on (read/write/edit), from ACP locations.
     *  Shown in the header so "write" tells you WHERE it wrote. */
    path?: string;
    /** `task` only: the sub-agent's live output, streamed while it works —
     *  gives the card a body before the sub-agent returns anything. */
    stream?: string;
    /** `task` only: this card continues a sub-agent this chat already showed
     *  rather than spawning a new one. Presentation only. */
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
    /** `read` of an image only: the file the model read, plus this surface's
     *  own `<img src>` for it (absent on the phone — see toolImageCard.ts).
     *  ReadFileCard draws the picture; every other card ignores it. */
    readImage?: ToolReadImage;
    /** `browser` only: the tool's own ok/action/url verdict off its metadata.
     *  Drives the honest icon below — the engine completes a failed browser
     *  call, so status alone would paint it green. */
    browser?: ToolBrowser;
    /** Bash only: the chat session, so a stuck command can be stopped from its
     *  own card instead of the chat bar. */
    sessionId?: string;
    /** Bash only: when the call started, so the card can show its age. */
    startedAt?: number;
    /** This card is history, not a live turn — a sub-agent transcript replayed
     *  from the store. Kill and Stop are dead: both act on whatever is running
     *  now, so on a card from an hour ago they'd cancel an unrelated turn. An
     *  explicit flag rather than leaning on an empty `sessionId`. */
    readOnly?: boolean;
    /** t-l1sovi — a read-image card's picture click, forwarded to
     *  ReadFileCard; every other card ignores it. */
    onImageClick?: (src: string, alt: string) => void;
  }

  // The age + Kill controls live in the header, not the card body, since the
  // body only mounts once the card is expanded — and a card starts collapsed.

  let { title, kind, toolName = '', status, result, diff, path, stream, resumed = false, shell, toolLines, images, readImage, browser, sessionId, startedAt, readOnly = false, onImageClick }: Props = $props();
  // A chart's body is the answer, so it opens by default rather than behind a
  // click; a `read` that produced a picture (t-ffk0qi) is the same case — the
  // owner asked for "no point hiding the image in the collapse". Set once at
  // construction (untracked) so re-deriving it doesn't re-open a card the
  // user had closed.
  let expanded = $state(untrack(() => toolName === 'chart' || !!readImage));
  // t-fh57s9: in the live stream the card is constructed when the call STARTS,
  // and the host stamps `readImage` on a LATER update (chatToolMsg.ts merges
  // into the same row, which ChatTranscript keys by id, so this instance
  // survives and the seed above was already false). Open the card the first
  // time a picture appears, once per card: a card the user then collapses
  // stays collapsed through every later update.
  let openedForImage = false;
  $effect(() => {
    if (!readImage || openedForImage) return;
    openedForImage = true;
    expanded = true;
  });

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

  // A `task`/`task_parallel` call delegates to a sub-agent; give it a distinct
  // icon + "sub-agent" badge in the header.
  let isTask = $derived(toolName === 'task' || toolName === 'task_parallel');
  let icon = $derived(isTask ? '\u{1F91D}' : (kindIcons[kind] || kindIcons.other));
  // Honest status mapping: `completed` is the only green, `failed` is red,
  // pending/in_progress is the spinner. Status alone decides, never "has any
  // result text" — a failed tool's error text also lands in `result`.
  let done = $derived(status === 'completed');
  let failed = $derived(status === 'failed');
  // A bash call always has a body: the IN block (the command) exists before any output.
  let isShell = $derived(toolName === 'bash' || toolName === 'shell' || kind === 'execute');
  // Honest exit: the engine completes a bash call whatever its exit code, so
  // status alone would paint a failing command green.
  let exitFail = $derived(isShell && typeof shell?.exit === 'number' && shell.exit !== 0);
  // t-s49986: a finished artifact_publish / artifact_get carries the version's
  // `origami://artifact` link; it shows as a card under the header, on a
  // collapsed card too. Only these two tools: a `read` of a file that happens
  // to contain such a link is not an artifact the agent made.
  let artifactLinks = $derived(
    (toolName === 'artifact_publish' || toolName === 'artifact_get') && done && result ? findArtifactLinks(result) : [],
  );
  // The browser card, like bash, always has a body: the IN rail exists before the page answers.
  let isBrowser = $derived(toolName === 'browser');
  // `chart` dispatches by name for the same reason `browser` does: its ACP
  // kind is the catch-all `other`, which is the GenericCard bucket.
  let isChart = $derived(toolName === 'chart');
  // The browser's exitFail: a refusal, an unreachable client, and an empty
  // capture all come back completed, so only the metadata flag distinguishes
  // them from a page that loaded.
  let browserFail = $derived(isBrowser && browser?.ok === false);
  // A chart that actually drew — not the same fact as "this tool is called
  // chart". Only the renderer's own parse of the returned spec says a picture exists.
  let chartDrawn = $derived(isChart && done && !!parseSpec(result ?? ''));
  // The engine completes a chart call it refused, so status paints it green.
  let chartFail = $derived(isChart && done && !chartDrawn);
  // A read-image card's body IS the picture: its result text is the one line
  // "Image read successfully", which alone would leave nothing worth expanding.
  let hasBody = $derived(!!result || !!diff || !!stream || isShell || isBrowser || !!readImage);

  // The mark's verdict, and the words behind it. `failed` covers all four
  // dishonest-green cases the header already distinguished — the engine
  // COMPLETES a failed browser call, a refused chart and a non-zero exit, so
  // status alone would paint every one of them with a tick.
  let markStatus: 'done' | 'failed' | 'running' = $derived(
    failed || exitFail || browserFail || chartFail ? 'failed' : done ? 'done' : 'running',
  );
  let markTip = $derived(
    failed ? 'failed'
    : exitFail ? `exit ${shell?.exit}`
    : browserFail ? `browser ${browser?.action ?? 'call'} failed`
    : chartFail ? 'no chart was drawn'
    : done ? 'completed' : 'running',
  );

  // A wedged command is invisible from here: the card says "running…" at
  // second 2 and second 900 in the same words.
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
  // already-old call is correct on its first frame.
  let elapsed = $derived(shellStartedAt ? Math.max(0, Math.floor((now - shellStartedAt) / 1000)) : undefined);
  let outputAge = $derived(shell?.lastOutputAt ? Math.max(0, Math.floor((now - shell.lastOutputAt) / 1000)) : undefined);
  let age = $derived(stuckState({ running: shellRunning && shellState === 'foreground', startedAt: shellStartedAt, now }));
  // CHANGES.md change 18b — a card showing ONLY its header is not a card, it is
  // a line. It loses its box and draws as a compact one-line strip; clicking
  // the header (the product's own expand control) opens the full card and the
  // strip class comes off with it. The condition is the card's OWN state — what
  // it is currently drawing — rather than the mock's measurement of child
  // heights, which is what an override outside the component is reduced to.
  let strip = $derived(!(expanded && hasBody) && !(isShell && shellStartedAt) && !(age.stuck && !readOnly));
  // The extension's existing turn-stop, the same message the chat's own Stop
  // sends: it interrupts the turn, fires the shell tool's ctx.abort arm, and
  // tree-kills the process.
  function kill() {
    if (readOnly || !sessionId) return;
    vscode.postMessage({ type: 'cancel', sessionId });
  }
  function stopBackground() {
    if (readOnly || !sessionId || !shell?.jobId) return;
    vscode.postMessage({ type: 'stopBackgroundShell', sessionId, jobId: shell.jobId });
  }

  // Dispatch: an explicit tool name wins (forward-compat / tests); otherwise
  // the ACP `kind` selects the renderer. Specialised only where the card
  // renders the engine's real output without a false signal.
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
  // `task`/`task_parallel`, `browser` and `chart` dispatch by tool name (their
  // ACP kind buckets them with tools that don't fit); the rest by ACP kind.
  let CardComponent = $derived(
    isTask ? (TOOLCARD_REGISTRY[toolName] ?? GenericCard)
    : isShell ? BashCard
    : isBrowser ? BrowserCard
    : isChart ? ChartCard
    : (KIND_REGISTRY[kind] || GenericCard),
  );
</script>

<div class="tool-card og-spotlight" class:done class:failed class:task={isTask} class:strip use:spotlight>
  <button class="tool-header" onclick={() => expanded = !expanded}>
    <span class="tool-icon">{icon}</span>
    <span class="tool-title">{title}</span>
    {#if isTask}<span class="tool-badge" use:tip={'Delegated to a sub-agent'}>sub-agent</span>{/if}
    {#if isTask && resumed}<span class="tool-resumed" use:tip={'Continues a sub-agent session already used in this chat — not a fresh agent'}>resumed</span>{/if}
    <!-- Keyed on `result`, not `hasBody`: a live stream counts as a body, but a
         sub-agent that returned nothing must still say so. -->
    {#if isTask && done && !result}<span class="tool-empty" use:tip={'The sub-agent finished without returning any text'}>no output</span>{/if}
    {#if path}
      <!-- The path reveals the file in the OS explorer. stopPropagation, or the
           click reaches the header and folds the card instead. Keyboard-
           reachable: a control that only answers a mouse is not a control. -->
      <span
        class="tool-path"
        role="button"
        tabindex="0"
        use:tip={`Reveal ${path} in the file explorer`}
        onclick={(e) => { e.stopPropagation(); revealPath(path); }}
        onkeydown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault(); e.stopPropagation(); revealPath(path);
        }}
      >{path}</span>
      {#if toolLines}
        <!-- The clamped range a read tool returned, and the control that opens
             the file AT it. stopPropagation on both handlers for the same
             reason the path has it, and for one more: these two sit in the same
             header, so a bubbling click would fire the other control too and
             one click would open a tab AND pop an explorer window. -->
        <span
          class="tool-lines"
          role="button"
          tabindex="0"
          use:tip={`Open ${path} at line ${toolLines.start}`}
          onclick={(e) => { e.stopPropagation(); openAtLine(path, toolLines?.start); }}
          onkeydown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault(); e.stopPropagation(); openAtLine(path, toolLines?.start);
          }}
        >(lines {toolLines.start}-{toolLines.end})</span>
      {/if}
    {/if}
    <!-- ONE mark, not one element per state (CHANGES.md change 21): the svg node
         survives the verdict landing, so the tick DRAWS instead of appearing
         already finished. The tooltip stays out here, where each kind of failure
         still says which failure it was. -->
    <span class="tool-status" use:tip={markTip}>
      <StatusMark status={markStatus} />
    </span>
    {#if hasBody}
      <span class="expand-arrow" class:open={expanded}>{'▶'}</span>
    {/if}
  </button>
  {#each artifactLinks as link (`${link.artifactId}?v=${link.version}`)}
    <div class="tool-artifact">
      <ArtifactCard artifactId={link.artifactId} version={link.version} title={link.title ?? ''} />
    </div>
  {/each}
  {#if isShell && shellStartedAt}
    <div class="tool-shell-live">
      <span>{shellState}</span>
      <!-- `elapsed` is a liveness reading, not a duration: a read-only
           historical transcript has no honest start stamp to measure from, so
           this would print "0s elapsed" under every settled command. -->
      {#if !age.stuck && elapsed !== undefined && !readOnly}<span>{elapsed}s elapsed</span>{/if}
      {#if outputAge !== undefined}<span>output {outputAge}s ago</span>{/if}
      {#if shellRunning && shellState !== 'foreground' && shell?.jobId && !readOnly}
        <button class="tool-stuck-kill" use:tip={'Stop this background command'} onclick={stopBackground}>Stop</button>
      {/if}
    </div>
  {/if}
  <!-- Its own strip under the header, not inside it: the header is the expand
       button, and a button inside a button isn't valid. As a sibling of the
       body it shows on a collapsed card too. -->
  <!-- Not in read-only: "has been running for a while" is a claim about now,
       and a finished sub-agent's transcript is not running at all. -->
  {#if age.stuck && !readOnly}
    <div class="tool-stuck">
      <span class="tool-stuck-age" use:tip={'This command has been running for a while'}>{age.elapsed}s elapsed</span>
      {#if sessionId && !readOnly}
        <button class="tool-stuck-kill" use:tip={'Stop the turn and kill this command'} onclick={kill}>Kill</button>
      {/if}
    </div>
  {/if}
  {#if expanded && hasBody}
    <div class="tool-result" class:chart={chartDrawn} class:image={!!readImage}>
      <CardComponent result={result ?? ''} {diff} {path} {title} {stream} {status} {shell} {images} {readImage} {browser} {onImageClick} />
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

  /* CHANGES.md change 18b — a card drawing only its header sheds the box and
     reads as one line. The HEADER keeps the surface, so the row is still a
     target you can see and click; the card around it stops being a frame.
     No size changes: the header's own 4px/8px padding and 11px type are the
     0.4.151 ones, and the strip only takes the border and the fill off the box
     around them. The `.task` spine below deliberately survives — a delegation
     must stay unmistakable whether or not its card happens to be open. */
  .tool-card.strip {
    border: 0;
    background: none;
    margin: 1px 0;
    overflow: visible;
  }
  .tool-card.strip > .tool-header {
    border-radius: 6px;
    background: color-mix(in srgb, var(--og-surface) 60%, transparent);
    transition: background-color 140ms ease;
  }
  .tool-card.strip > .tool-header:hover {
    background: var(--og-surface);
  }
  @media (prefers-reduced-motion: reduce) {
    .tool-card.strip > .tool-header { transition: none; }
  }
  .tool-artifact {
    padding: 0 8px 2px 26px;
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
     and never shrinks (the range itself must stay legible). It is a CONTROL:
     it opens the file at that line, so it reads as one on hover, the same way
     its neighbour does. */
  .tool-lines {
    flex-shrink: 0;
    color: var(--og-text-muted);
    font-family: var(--vscode-editor-font-family, monospace);
    cursor: pointer;
  }
  .tool-lines:hover,
  .tool-lines:focus-visible {
    color: var(--og-accent-2);
    text-decoration: underline;
    outline: none;
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

  /* The ✓ / ✗ / spinner glyphs that lived here are StatusMark.svelte's now, and
     their rules left with them — a rule kept here would simply stop matching,
     silently, since no <style> ever reaches the test DOM to say otherwise.
     Honest failure is still the point and still tested: the mark carries the
     same `check` / `cross` / `spinner` class names, which is what browserCard
     and chartCard assert on to prove a failed call never reads as a green tick. */
  .tool-status {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .tool-card.failed {
    border-color: color-mix(in srgb, var(--og-error) 45%, var(--og-border));
  }

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
  /* A READ-IMAGE card joins the chart on exactly the same reasoning, and it is
     the sharper case of the two (CHANGES.md change 45): a chart clamped to
     200px arrives cropped, but a picture clamped to 200px inside a scroll box
     arrives as a letterbox with its own scrollbar, nested in an already-
     scrolling transcript. The card's body IS the answer. What bounds it now is
     the pane — see readImageFit.ts — not a number in this rule. */
  .tool-result.chart,
  .tool-result.image {
    max-height: none;
    overflow: visible;
  }
</style>
