<script lang="ts">
  // Collabs M2 — the stream, extracted from CollabPane.svelte (at its cap) and
  // rebuilt as a Slack-style transcript rather than a list of titled cards.
  //
  // GROUPING IS THE POINT. An agent that answers in four paragraphs used to
  // print four identical author/time headers, which reads as four people. Runs
  // of consecutive messages from the SAME author collapse under one header, so
  // vertical space goes to what was said rather than to who said it, and a real
  // change of speaker is the only thing that draws a new header.
  //
  // Grouping is on the AUTHOR ONLY, deliberately not on a time window: a collab
  // turn can take minutes, and splitting a single agent's reply because it
  // straddled a five-minute boundary would invent a speaker change that never
  // happened. Every message keeps its own timestamp in the gutter, so the
  // elapsed time inside a group is still readable.
  //
  // Flock M4: the stream carries a PROTOCOL now, not only prose. The grouping
  // and the kind vocabulary both moved to collabKinds.ts (a pure leaf, tested
  // with no DOM) so this file stays markup: a system row breaks a run rather
  // than joining it, and ask/handoff/answer reach the bubble already
  // interpreted as a tone and a label.
  //
  // W5-L2: with COUNCIL rounds the file became a ROUTER over row kinds, and the
  // speaker's run moved out to CollabGroupRow.svelte to pay for the round's
  // branch. Each kind's markup now lives with the CSS that draws it, and the
  // decisions above them all stay in the two pure leaves.
  import CollabAvatar from './CollabAvatar.svelte';
  import CollabFailureRow from './CollabFailureRow.svelte';
  import CollabGroupRow from './CollabGroupRow.svelte';
  import CollabLivePill from './CollabLivePill.svelte';
  import CollabReviewRow from './CollabReviewRow.svelte';
  import CollabRoundGroup from './CollabRoundGroup.svelte';
  import { livePills } from './collabActivity';
  import { collabShortName } from './collabNames';
  import { buildCouncilRows } from './collabCouncil';
  import CollabSystemRow from './CollabSystemRow.svelte';
  import CollabWaitingRow from './CollabWaitingRow.svelte';
  import { buildStreamRows, kindLabel } from './collabKinds';
  import { makeStreamFollow } from './collabStreamFollow';
  import { fmtTime } from './collabStreamMarks';
  import { agentFailures, reviewableTaskId } from './collabSupervision';
  import { openAsks } from './collabWaiting';
  import type { CollabAgentStatus, CollabMessage as Message, TaskEntry } from '../../src/acpExtTypes';

  interface Props {
    messages: Message[];
    loaded: boolean;
    /** slug -> display name, off the roster. Falls back to the slug. */
    names: Record<string, string>;
    /** slug -> glyph key, where a def declared one (`glyph:` frontmatter). The
     *  `collab_agents` wire has no glyph field, so this is merged in fs-side by
     *  the host; a slug missing here still resolves by its own name. */
    glyphs: Record<string, string>;
    /** Per-agent status off the same poll the messages arrive on. Absent on a
     *  build that does not thread it through — no statuses, no pills. */
    agents?: CollabAgentStatus[];
    /** W3 (report 2.4): the board, so a `task_done` row knows whether its task
     *  is still awaiting a verdict. ABSENT = the engine has no board, never
     *  "no tasks" — and a verdict button would then post into nothing. */
    tasks?: TaskEntry[];
    archived?: boolean;
    /** The human's verdict wire (`collab_review`). Absent on a caller that has
     *  not wired it, which draws today's read-only rows. */
    onReview?: (taskId: string, verdict: 'approve' | 'reject', note?: string) => void;
  }
  let { messages, loaded, names, glyphs, agents = [], tasks, archived = false, onReview }: Props = $props();

  // The LIVE PILLS. Which agents get one, and what a pill may say, are
  // collabActivity.ts's rules — pure, so the defensive read of a brand-new
  // optional wire field is testable with no DOM. The row itself is
  // CollabLivePill.svelte; this file only places it.
  const pills = $derived(livePills(agents));

  // Keyed on the FIRST message's seq: seqs are monotonic per collab, so a key
  // is stable across re-renders and two rows cannot swap identity.
  //
  // A COUNCIL round is folded on top of that model rather than instead of it —
  // collabExport.ts renders a shipped transcript from the same builder, and a
  // discuss room comes back out of the fold untouched.
  const rows = $derived(buildCouncilRows(buildStreamRows(messages)));

  /** The SHORT name for a header or a system row — a full description would
   *  read as a screed next to a run of messages, not an author line. */
  const shortOf = (slug: string): string => collabShortName(slug, names[slug]);
  const nameOf = (id: string, kind: 'human' | 'agent'): string => (kind === 'human' ? 'You' : shortOf(id));
  /** The full text the short name was mined from — surfaced as the header's
   *  tooltip, never dropped, just moved off the row itself. */
  const fullNameOf = (id: string): string => names[id] || id;

  // The clock is collabStreamMarks.ts; the speaker's MARK (brand animal or
  // letter disc, and the per-slug tone under it) is CollabAvatar.svelte. Both
  // were extracted so the follow rule and the flow rail could land inside the
  // cap — see each file's header.

  // THE FOLLOW (report 1.11 / F10). The rule is the chat's, lifted verbatim —
  // see collabStreamFollow.ts, and chatScroll.ts under it. The effect reads
  // `rows` AND `pills`, because an agent can start working with no new message
  // behind it and the pill is the row that would then be under the fold.
  let streamEl = $state<HTMLDivElement | null>(null);
  const follow = makeStreamFollow();
  $effect(() => {
    const last = messages[messages.length - 1];
    follow.bind(streamEl);
    void rows.length; void pills.length;
    follow.follow(last?.seq ?? 0, last?.authorKind === 'human');
  });

  /** What the room is still blocked on (2.3) — pure, in collabWaiting.ts. */
  const waiting = $derived(openAsks(messages));
  const flowNameOf = (id: string): string => (id === 'user' ? 'You' : shortOf(id));

  /** F13: which agents' last turns failed. Off the STATUSES, not the messages
   *  — a failure is never appended to the transcript. */
  const failures = $derived(agentFailures(agents));
  /** The task a `task_done` row may take a verdict on, or null. The rule (only
   *  a completed task, only a live room) is collabSupervision.ts's. */
  const verdictFor = (m: Message): string | null =>
    !onReview || archived ? null : reviewableTaskId(m, tasks);
</script>

<div
  class="stream"
  role="log"
  aria-label="Collab messages"
  bind:this={streamEl}
  onscroll={follow.onScroll}
  onwheel={(e) => follow.onWheel(e.deltaY)}
>
  {#if messages.length === 0}
    <div class="stream-empty">{loaded ? 'Nothing said yet. Post the first message below.' : 'Loading…'}</div>
  {:else}
    {#each rows as r (r.key)}
      {#if r.row === 'system'}
        <!-- Bookkeeping (task_*/system): full width, no avatar, no bubble. -->
        <CollabSystemRow
          msg={r.msg}
          name={nameOf(r.msg.authorId, r.msg.authorKind)}
          label={kindLabel(r.msg, shortOf, nameOf(r.msg.authorId, r.msg.authorKind))}
        />
        <!-- The flow rail says this went to the BOARD; the verdict is how the
             human answers it without leaving the stream (report 2.4). -->
        {@const verdict = verdictFor(r.msg)}
        {#if verdict && onReview}
          <CollabReviewRow taskId={verdict} name={nameOf(r.msg.authorId, r.msg.authorKind)} {onReview} />
        {/if}
      {:else if r.row === 'round'}
        <!-- One COUNCIL round as one block: every member's independent answer
             collapsed to a line, the room's n-of-m record, and the
             reconciliation under them. -->
        <CollabRoundGroup round={r} {shortOf} {avatar} />
      {:else}
        <CollabGroupRow
          authorId={r.authorId}
          authorKind={r.authorKind}
          msgs={r.msgs}
          name={nameOf(r.authorId, r.authorKind)}
          fullName={fullNameOf(r.authorId)}
          {shortOf}
          {avatar}
        />
      {/if}
    {/each}
  {/if}

  <!-- One pill per RUNNING agent, at the foot of the transcript and on the
       agent SIDE, so a room with work in flight never reads as a dead room.
       Rendered outside the empty-stream branch on purpose: an agent can be
       working before it has said anything at all, and that is exactly the
       stretch the pill exists for. -->
  {#each pills as p (p.slug)}
    <CollabLivePill pill={p} name={shortOf(p.slug)} {avatar} />
  {/each}

  <!-- ...and BELOW the pills, the wait itself: an idle room and a blocked one
       look identical without it. -->
  <CollabWaitingRow asks={waiting} nameOf={flowNameOf} />

  <!-- Last, and drawn from the STATUSES rather than the transcript: a failed
       turn appends nothing to the log by design (F13). -->
  <CollabFailureRow {failures} nameOf={shortOf} />
</div>

<!-- The avatar column, shared by a message group and a pill: one agent must
     not be a brand animal in the transcript and a letter disc in its own
     pill. -->
{#snippet avatar(id: string, kind: 'human' | 'agent')}
  <CollabAvatar {id} {kind} name={nameOf(id, kind)} glyphKey={glyphs[id] || id} />
{/snippet}

<style>
  .stream {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
  }
  .stream-empty {
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
  }

  /* The speaker's run and its `.cs-group` / `.cs-avatar` / `.cs-body` rules
     moved to CollabGroupRow.svelte with the markup they draw. CollabLivePill
     re-declares the same class names for the pill it stands in for, which is
     why they are not in a shared sheet: Svelte scopes styles per component, so
     each surface has always carried its own copy. */
</style>
