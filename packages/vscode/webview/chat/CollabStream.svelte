<script lang="ts">
  // Messages group by author only, not by a time window, so one agent's long
  // reply never splits into a false speaker change. Each message keeps its
  // own timestamp so elapsed time within a group stays visible.
  // Grouping rules and the kind vocabulary live in collabKinds.ts; this file
  // renders markup only, routed by row kind.
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

  // Which agents get a live pill, and what it says, is collabActivity.ts's
  // rule — pure logic, testable with no DOM.
  const pills = $derived(livePills(agents));

  // Rows key on the first message's seq (monotonic per collab), so keys stay
  // stable across re-renders. A council round folds on top of the same
  // builder, so collabExport.ts can render from it too.
  const rows = $derived(buildCouncilRows(buildStreamRows(messages)));

  /** The SHORT name for a header or a system row — a full description would
   *  read as a screed next to a run of messages, not an author line. */
  const shortOf = (slug: string): string => collabShortName(slug, names[slug]);
  const nameOf = (id: string, kind: 'human' | 'agent'): string => (kind === 'human' ? 'You' : shortOf(id));
  /** The full text the short name was mined from; used as the header tooltip. */
  const fullNameOf = (id: string): string => names[id] || id;


  // The follow effect reads `rows` AND `pills`: an agent can start working
  // with no new message, and the pill is what would then sit below the fold.
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
  onwheel={(e) => follow.onWheel(e.deltaY, e.target)}
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

  <!-- A live pill per running agent, at the foot on the agent side, so a
       room with work in flight never reads as a dead room. -->
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

<!-- The avatar column, shared by a message group and a pill: one agent's
     mark must look the same in the transcript and in its own pill. -->
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
