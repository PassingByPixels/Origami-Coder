<script lang="ts">
  // Collabs M2 — ONE collab's stream, given a whole editor tab. Mounted by
  // ChatView's __ORIGAMI_COLLAB__ branch, seeded with the collab IDENTITY only:
  // everything on screen comes from the poll below, so a tab left open all
  // afternoon is never showing what it was seeded with.
  //
  // THE PANE OWNS THE FAST POLL. `collabPoll` goes out on this component's own
  // interval while it is mounted and is cleared on teardown — faster while an
  // agent is running (a stream you are watching move), slower when everything is
  // idle. The cadence rule itself lives in collabPollLoop.ts.
  //
  // It is no longer the only poll. The extension host runs a slower watch of its
  // own (src/dashboard/collabWatch.ts) so a room whose tab is SHUT keeps
  // reporting and its sidebar ring stays alive. Both produce the same
  // `collabStateData` payload, and `applyState` below is written to fold either
  // one in — which is why every append is guarded on seq.
  //
  // `post()` fans EVERY reply out to EVERY attached webview, so two collab tabs
  // open at once both see both streams' replies. Every handler below therefore
  // filters on `collabId` first; a payload for another collab is dropped, never
  // rendered.
  //
  // M2 split the two big presentational blocks out (CollabRoster / CollabStream)
  // when this file hit its architecture cap. What stays here is what only the
  // owner of the poll can own: the wire, the fold-in rules, what a composed
  // line MEANS, and the loop-breaker control. The composer itself is the chat's
  // InputBar in bare mode — one box, one set of habits, in both surfaces.
  //
  // Flock M4 (X2): the pane also owns the collab's BOARD state — lead,
  // objective, tasks, per-agent spend and the hop budget. All of it arrives on
  // the same poll, and every field is OPTIONAL by contract: an older engine
  // sends none of them, so each is folded in only when it is actually present
  // and nothing here ever synthesises one.
  import { getVsCodeApi } from '../shared/vscodeApi';
  import { onMount } from 'svelte';
  import CollabBanners from './CollabBanners.svelte';
  import CollabComposer from './CollabComposer.svelte';
  import CollabControls from './CollabControls.svelte';
  import CollabHopBar from './CollabHopBar.svelte';
  import CollabRoster from './CollabRoster.svelte';
  import CollabStream from './CollabStream.svelte';
  import CollabTaskDrawer from './CollabTaskDrawer.svelte';
  import { makeCollabActions } from './collabActions';
  import { makeCollabPollLoop } from './collabPollLoop';
  import { parseCollabSlash, type CollabSlashAction } from './collabSlash';
  import { collabSlashMessage } from './collabDispatch';
  import { collabShortName } from './collabNames';
  import { renderCollabMarkdown } from './collabExport';
  import type { StopOutcome } from './collabSupervision';
  import { mergeInviteCandidates, parseEngineAgents, parseFsAgents, type EngineAgent, type FsAgentDef } from './collabInvite';
  import type { ProviderLiveness } from './collabHealth';
  import type {
    CollabAgentStatus, CollabCostTotal, CollabHopState, LedgerEntry, PromptCapture, TaskEntry,
    CollabMessage as Message, CollabSummary as Summary,
  } from '../../src/acpExtTypes';

  const vscode = getVsCodeApi();

  interface CollabIdentity { id: string; title: string }
  interface Participant { agentSlug: string; displayName: string; model: string | null; removedAt?: string; sessionId?: string }
  /** The wire's own shape. `liveActivity` rides along untouched — CollabStream
   *  is where it is validated, next to the pill that draws it. */
  type AgentStatus = CollabAgentStatus;

  let identity = $state<CollabIdentity>({ id: '', title: '' });
  let summary = $state<Summary | null>(null);
  let participants = $state<Participant[]>([]);
  let messages = $state<Message[]>([]);
  let agents = $state<AgentStatus[]>([]);
  let suspended = $state(false);
  let error = $state('');
  /** The engine's routing notice CODE — CollabBanners words it. NOT an error:
   *  the message landed, it just woke nobody. */
  let notice = $state('');
  /** Highest seq rendered. The poll asks for `> this`, so a settled stream
   *  costs one near-empty round trip instead of the whole transcript. */
  let lastSeq = $state(0);
  let loaded = $state(false);
  /** slug -> glyph key, merged in host-side from the agent def files. The
   *  `collab_agents` wire has no glyph field, so this is the only way a
   *  user-authored `glyph:` line reaches the roster. */
  let glyphs = $state<Record<string, string>>({});
  /** Every collab-capable slug the engine can see, with displayName — the
   *  roster's Invite popover (M3) and the `/invite` vocabulary. */
  let engineAgents = $state<EngineAgent[]>([]);
  /** Fs-only defs the engine hasn't loaded yet — collabInvite.ts's other merge half. */
  let fsAgents = $state<FsAgentDef[]>([]);
  /** Provider liveness, so the invite list can say whether a candidate will
   *  actually run (report 1.4). EMPTY until the host's probe answers, and
   *  collabHealth reads empty as "unknown", never as "everything is down". */
  let providerStatus = $state<ProviderLiveness[]>([]);

  // --- Flock M4 board state. Every one of these is ABSENT on an older engine
  // and stays at its initial value then; `tasks`/`costTotals` are UNDEFINED
  // until a payload carries them, which is what lets the board say "this
  // engine has no board" instead of "no tasks".
  let lead = $state<string | null>(null);
  let objective = $state<string | null>(null);
  let tasks = $state<TaskEntry[] | undefined>(undefined);
  let costTotals = $state<CollabCostTotal[] | undefined>(undefined);
  let hopState = $state<CollabHopState | null>(null);
  let ledger = $state<LedgerEntry[]>([]);
  let ledgerLoaded = $state(false);
  /** W3 (report 2.4): what the engine said the last PER-AGENT stop did. It
   *  names its own agent, so the roster can land the sentence on that chip. */
  let stopOutcome = $state<(StopOutcome & { agentSlug: string }) | null>(null);

  // The context drawer: ONE agent's last real prompt at a time. Held here, not
  // in the roster, because the reply arrives on the same fanned-out wire as
  // everything else and has to be filtered on collabId before anything renders.
  let captureSlug = $state<string | null>(null);
  let capture = $state<PromptCapture | null>(null);
  let captureError = $state<string | null>(null);
  let captureLoaded = $state(false);

  const busy = $derived(agents.some((a) => a.state === 'running' || a.state === 'queued'));
  const archived = $derived(!!summary?.archivedAt);
  const names = $derived(Object.fromEntries(participants.map((p) => [p.agentSlug, p.displayName || p.agentSlug])));
  const invitable = $derived(mergeInviteCandidates(engineAgents, fsAgents, participants, providerStatus));

  /** The ACTIVE roster — who an `@` can name, and the exact set a mention is
   *  validated against. A removed participant is deliberately absent: the
   *  engine refuses the post outright for one, taking the whole message with it. */
  const roster = $derived(
    participants.filter((p) => !p.removedAt).map((p) => ({ slug: p.agentSlug, name: collabShortName(p.agentSlug, p.displayName) })),
  );

  function poll() {
    if (!identity.id) return;
    vscode.postMessage({ type: 'collabPoll', collabId: identity.id, sinceSeq: lastSeq });
  }

  // The cadence and its re-arm rule live in collabPollLoop.ts. Armed from an
  // $effect (reading `busy` is what subscribes it), so the rate changes the
  // moment an agent starts or stops, and the effect's teardown is the pane's
  // only timer teardown.
  const pollLoop = makeCollabPollLoop(poll);
  $effect(() => {
    pollLoop.arm(busy);
    return () => pollLoop.stop();
  });

  /** Ask the host for one participant's last real prompt. An agent with no
   *  engine session yet is still OPENED — the drawer states that plainly
   *  instead of the click doing nothing, which reads as a broken control. */
  function openContext(slug: string, sessionId?: string) {
    if (captureSlug === slug) { closeContext(); return; }
    captureSlug = slug;
    capture = null;
    captureError = null;
    captureLoaded = false;
    if (sessionId) vscode.postMessage({ type: 'collabPromptCapture', collabId: identity.id, sessionId, slug });
    else captureLoaded = true;
  }
  function closeContext() { captureSlug = null; capture = null; captureError = null; captureLoaded = false; }
  /** F14: the OPEN drawer re-asks on its own cadence. Same wire the open used;
   *  a slug with no engine session has nothing to re-fetch, so it is skipped. */
  function refreshContext() {
    const p = participants.find((x) => x.agentSlug === captureSlug);
    if (p?.sessionId) vscode.postMessage({ type: 'collabPromptCapture', collabId: identity.id, sessionId: p.sessionId, slug: p.agentSlug });
  }

  /** The roster's + button and the setup card, which both commit a MULTI-select
   *  now (report 1.3). Same wire the `/invite` command already uses — dispatch
   *  handles each post, and one re-poll at the end shows every new chip without
   *  waiting for the next timer tick. */
  function inviteAgents(slugs: string[]) {
    for (const slug of slugs) dispatch({ kind: 'invite', slug });
    poll();
  }

  /** Enact a parsed composer line. Every branch is a host message and a
   *  re-poll: the engine owns the result, and nothing is spliced in locally, so
   *  a refused rename cannot leave the new title on screen. WHICH message a
   *  line becomes is collabDispatch.ts's, pure and testable with no render;
   *  `/context` comes back as a request because the drawer is this file's. */
  function dispatch(action: CollabSlashAction, images: string[] = []) {
    const out = collabSlashMessage(action, { roster: roster.map((r) => r.slug), images });
    if (!out) return;
    if ('context' in out) {
      const p = participants.find((x) => x.agentSlug === out.context);
      if (p) openContext(p.agentSlug, p.sessionId);
      else error = `No participant named "${out.context}" in this collab.`;
      return;
    }
    vscode.postMessage({ ...out.post, collabId: identity.id });
  }

  /** One composed line and whatever was attached to it. Returning FALSE is the
   *  composer's keep-the-draft signal — the draft being the text AND its
   *  images, kept or cleared together. `mode` is the chat's slot on `onSend`
   *  and means nothing here. */
  function submit(text: string, _mode?: string, images?: { dataUrl: string; name: string }[]): boolean {
    if (!identity.id) return false;
    const action = parseCollabSlash(text);
    if (action.kind === 'error') { error = action.message; return false; }
    // Both refusals are SYNCHRONOUS on purpose. The engine refuses a 5th image
    // too (CollabStore.IMAGE_LIMIT), but its answer arrives a round trip later,
    // by which time the composer has cleared — so the message and the pictures
    // would both be gone. Mirrored here, the draft survives the mistake.
    const pics = (images ?? []).map((i) => i.dataUrl);
    const refusal = pics.length > 4 ? `A message may carry at most 4 images — this one has ${pics.length}.`
      : pics.length && action.kind !== 'post' ? 'Images can only ride an ordinary message. Remove them, or send the command on its own line.' : '';
    if (refusal) { error = refusal; return false; }
    dispatch(action, pics);
    poll();
    return true;
  }

  /** The stream as a markdown file. Rendered HERE — only the webview holds the
   *  polled snapshot and the roster names an attributed transcript needs — and
   *  written by the host, the same split exportLabyrinth takes.
   *
   *  The BOARD goes with it: a collab's tasks are half of what happened in the
   *  room, and a transcript that drops them exports the talking and none of the
   *  work. Both fields stay UNDEFINED on an engine with no board, and the
   *  renderer emits no section at all then. */
  function exportCollab() {
    const title = summary?.title || identity.title;
    vscode.postMessage({
      type: 'exportCollab',
      collabId: identity.id,
      title,
      markdown: renderCollabMarkdown(title, names, messages, { tasks, costTotals }),
    });
  }

  // --- The board's mutations, and the two board settings the roster and the
  // controls strip now write (lead, objective). Every one is a host message and
  // a re-poll: the engine owns the transitions, so nothing is spliced in
  // locally and a refused accept cannot leave a closed task on screen. The
  // rules live in collabActions.ts.
  const { send, setCap, setConcurrency, setFlavor, addTask, updateTask, loadLedger, stopAgent, redirect, review } =
    makeCollabActions({ post: (m) => vscode.postMessage(m), collabId: () => identity.id, poll });
  const setLead = (slug: string) => send({ type: 'collabSetLead', agentSlug: slug });
  const setObjective = (text: string) => send({ type: 'collabSetObjective', objective: text });

  /** Fold an incoming state payload in. A `sinceSeq` of 0 is a FULL snapshot
   *  and replaces the stream; anything else appends. Appending is guarded on
   *  seq so a duplicated poll reply cannot double-print a message, and on
   *  `loaded` because the HOST polls this collab too and keeps its own seq
   *  count — one of its increments can reach a pane whose own snapshot has not
   *  answered yet, and appending that would start the transcript in the middle.
   *  Everything BELOW the stream is folded in either way: the roster and the
   *  rings are as true from a host increment as from the pane's own poll. */
  function applyState(msg: Record<string, unknown>) {
    const incoming = (Array.isArray(msg.messages) ? msg.messages : []) as Message[];
    if (Number(msg.sinceSeq ?? 0) === 0) {
      messages = incoming;
      loaded = true;
    } else if (incoming.length && loaded) {
      const known = new Set(messages.map((x) => x.seq));
      messages = [...messages, ...incoming.filter((x) => !known.has(x.seq))];
    }
    for (const x of messages) if (x.seq > lastSeq) lastSeq = x.seq;
    if (msg.collab && typeof msg.collab === 'object') summary = msg.collab as Summary;
    if (Array.isArray(msg.participants)) participants = msg.participants as Participant[];
    if (Array.isArray(msg.agents)) agents = msg.agents as AgentStatus[];
    suspended = msg.suspended === true;
    // The M4 board. Each field is taken only when the payload carries it, and
    // the collab summary is the fallback for lead/objective — the engine sets
    // both places, and a build that fills only one must still render.
    const sum = summary as (Summary & { lead?: string | null; objective?: string | null }) | null;
    lead = typeof msg.lead === 'string' ? msg.lead : (msg.lead === null ? null : sum?.lead ?? lead);
    objective = typeof msg.objective === 'string' ? msg.objective : (msg.objective === null ? null : sum?.objective ?? objective);
    // A room that has gained a lead can answer, so the no-lead line stops being
    // true — drop it here rather than leaving it up until the next post.
    if (lead) notice = '';
    if (Array.isArray(msg.tasks)) tasks = msg.tasks as TaskEntry[];
    if (Array.isArray(msg.costTotals)) costTotals = msg.costTotals as CollabCostTotal[];
    if (msg.hopState && typeof msg.hopState === 'object') hopState = msg.hopState as CollabHopState;
    error = typeof msg.error === 'string' ? msg.error : '';
  }

  onMount(() => {
    const seeded = (window as unknown as { __ORIGAMI_COLLAB__?: CollabIdentity | null }).__ORIGAMI_COLLAB__;
    if (seeded && typeof seeded.id === 'string') identity = { id: seeded.id, title: String(seeded.title ?? seeded.id) };

    const onMsg = (ev: MessageEvent) => {
      const msg = (ev.data || {}) as Record<string, unknown>;
      // `collabAgents` and `collabAgentDefs` are workspace-wide, not per collab
      // — neither carries a collabId, so both must be handled BEFORE the
      // ownership filter below (or every reply would be dropped as "not ours").
      if (msg.type === 'collabAgents') {
        engineAgents = parseEngineAgents(msg.agents);
        glyphs = (msg.glyphs && typeof msg.glyphs === 'object' ? msg.glyphs : {}) as Record<string, string>;
        // A failed fetch must not silently strand the invite list at whatever
        // it last held — this is the exact class of swallow Goal 3 exists for.
        if (typeof msg.error === 'string' && msg.error) error = msg.error;
        return;
      }
      if (msg.type === 'collabAgentDefs') {
        fsAgents = parseFsAgents(msg.defs);
        if (typeof msg.error === 'string' && msg.error) error = msg.error;
        return;
      }
      // Workspace-wide too, and the same broadcast the agents pane already
      // drives — this pane only listens to it.
      if (msg.type === 'providerStatus') {
        providerStatus = (Array.isArray(msg.providers) ? msg.providers : []) as ProviderLiveness[];
        return;
      }
      // Every collab reply is fanned out to every view — take only our own.
      if (msg.collabId && msg.collabId !== identity.id) return;
      switch (msg.type) {
        case 'collabStateData':
          applyState(msg);
          break;
        case 'collabPosted':
          // Set AND cleared on every post reply — a second message into a room
          // that has since gained a lead takes the line away again.
          notice = typeof msg.notice === 'string' ? msg.notice : '';
          if (typeof msg.error === 'string' && msg.error) error = msg.error;
          poll();
          break;
        case 'collabCapSet':
        case 'collabOpResult':
        case 'collabTaskResult':
          // A refusal has to reach the user; a success needs no announcement,
          // the very next poll shows it.
          if (typeof msg.error === 'string' && msg.error) error = msg.error;
          poll();
          break;
        case 'collabLedgerData':
          // The per-turn rows. `loaded` is set either way, so "asked and there
          // is nothing" reads differently from "never asked".
          ledger = Array.isArray(msg.entries) ? (msg.entries as LedgerEntry[]) : [];
          if (Array.isArray(msg.totals)) costTotals = msg.totals as CollabCostTotal[];
          if (typeof msg.error === 'string' && msg.error) error = msg.error;
          ledgerLoaded = true;
          break;
        case 'collabStopAgentResult':
          // Kept until the NEXT per-agent stop: it is the answer to something
          // the user did, and a line that vanished on the next 1.2s poll would
          // be gone before it was read.
          stopOutcome = {
            agentSlug: typeof msg.agentSlug === 'string' ? msg.agentSlug : '',
            interrupted: msg.interrupted === true,
            dequeued: msg.dequeued === true,
            ...(typeof msg.error === 'string' && msg.error ? { error: msg.error } : {}),
          };
          poll();
          break;
        case 'collabRedirectResult':
        case 'collabReviewResult':
          // A refusal has to reach the user; a success needs no announcement —
          // the correction and the reopened task both arrive on the next poll.
          if (typeof msg.error === 'string' && msg.error) error = msg.error;
          poll();
          break;
        case 'collabPromptCaptureData':
          // Late reply for a drawer that has since been closed, or reopened on
          // a different agent: drop it rather than paint one agent's prompt
          // under another agent's name.
          if (msg.slug !== captureSlug) break;
          capture = (msg.capture ?? null) as PromptCapture | null;
          captureError = typeof msg.error === 'string' && msg.error ? msg.error : null;
          captureLoaded = true;
          break;
      }
    };
    window.addEventListener('message', onMsg);

    poll();
    // The `/invite` vocabulary, the roster glyphs, and the Invite popover's
    // two sources — all workspace-wide, not this collab's alone.
    vscode.postMessage({ type: 'requestCollabAgents' });
    vscode.postMessage({ type: 'listCollabAgentDefs' });
    vscode.postMessage({ type: 'requestProviderStatus' });
    return () => window.removeEventListener('message', onMsg);
  });
</script>

<div class="collab">
  <CollabRoster
    title={summary?.title || identity.title}
    {archived} {participants} {agents} {glyphs} {lead} {costTotals} {invitable}
    {captureSlug} {capture} {captureError} {captureLoaded}
    {objective} {loaded}
    onContext={openContext} onCloseCapture={closeContext} onInvite={inviteAgents} onSetLead={setLead} onRefreshCapture={refreshContext}
    onSetObjective={setObjective} onUnarchive={() => send({ type: 'collabUnarchive' })}
    onStopAgent={stopAgent} onRedirect={redirect} {stopOutcome}
  />

  <CollabBanners {error} {notice} />

  <CollabControls {suspended} {hopState} {objective} {archived} onSetObjective={setObjective} />

  <CollabStream {messages} {loaded} {names} {glyphs} {agents} {tasks} {archived} onReview={review} />

  <!-- The board FLOATS over the stream as a right-edge drawer rather than
       taking a band of height from it — see CollabTaskDrawer.svelte. -->
  <CollabTaskDrawer
    {tasks} {costTotals} {ledger} {ledgerLoaded} {archived}
    onAdd={addTask} onUpdate={updateTask} onExpand={loadLedger}
  />

  <!-- THE CHAT COMPOSER, bare: one box with one set of habits in both surfaces.
       Posting while the agents are working is legal — it is how the loop breaker
       gets un-paused — so the box is never locked by a running turn, only by an
       archived collab. The box itself and the C14 preview line under it are
       CollabComposer's; this file was 3 lines from its cap. -->
  <CollabComposer
    collabId={identity.id}
    {archived}
    {roster}
    onSend={submit}
    onExport={exportCollab}
    canExport={messages.length > 0}
  />

  <!-- BELOW the composer, deliberately: the budget is spent by posting, and
       STOP is reached for while looking at the box you just typed in. -->
  <CollabHopBar
    cap={summary?.loopBreakerCap ?? null}
    concurrency={summary?.concurrency ?? null} flavor={summary?.flavor ?? 'discuss'}
    {hopState} {archived}
    onSetCap={setCap} onSetConcurrency={setConcurrency} onSetFlavor={setFlavor} onStop={() => send({ type: 'collabStop' })}
  />
</div>

<style>
  .collab {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--og-bg);
    color: var(--og-text);
    /* The task drawer floats against this box, not the viewport. */
    position: relative;
  }

  /* The composer and its `/` palette are InputBar's; the error and notice lines
     are CollabBanners', the suspended banner and the objective line
     CollabControls', the cap/Stop row CollabHopBar's, and the drawer geometry
     CollabTaskDrawer's — styles included. */
</style>
