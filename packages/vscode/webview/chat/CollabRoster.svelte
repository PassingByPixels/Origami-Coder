<script lang="ts">
  // The roster strip: the collab's identity plus each agent's CONTEXT surface.
  //
  // The chip is a BUTTON, not a span: clicking it opens the context drawer. A
  // participant that has never taken a turn carries no `sessionId` — the ordinary
  // early state of every collab — so it says "no context yet" rather than opening
  // an empty drawer or looking broken.
  //
  // The empty-roster coaching line opens the SAME invite list the ＋ trigger does
  // rather than growing a second picker; `pickerOpen` is bound so both affordances
  // drive one popover. The SETUP CARD is mounted from here rather than from the
  // pane because it needs exactly the plumbing this file already holds — the merged
  // candidate list, the invite commit and the lead setter.
  import CollabContextDrawer from './CollabContextDrawer.svelte';
  import CollabRosterChip from './CollabRosterChip.svelte';
  import CollabRosterPicker from './CollabRosterPicker.svelte';
  import CollabSetupCard from './CollabSetupCard.svelte';
  import { archetypeGlyph } from '../dashboard/components/archetypeGlyphs';
  import { collabShortName } from './collabNames';
  import { chipSupervision, ringState, type StopOutcome } from './collabSupervision';
  // CollabAgentStatus is the WIRE's shape; the drawer below reads `activity` off it.
  import type { CollabAgentStatus, CollabCostTotal, PromptCapture } from '../../src/acpExtTypes';
  import type { InviteCandidate } from './collabInvite';

  interface Participant {
    agentSlug: string;
    displayName: string;
    model: string | null;
    removedAt?: string;
    sessionId?: string;
  }
  type AgentStatus = CollabAgentStatus;

  interface Props {
    title: string;
    archived: boolean;
    participants: Participant[];
    agents: AgentStatus[];
    /** slug -> glyph key, merged in host-side; the `collab_agents` wire has no glyph. */
    glyphs: Record<string, string>;
    /** The slug whose context drawer is open, or null for closed. */
    captureSlug: string | null;
    capture: PromptCapture | null;
    captureError: string | null;
    captureLoaded: boolean;
    onContext: (slug: string, sessionId?: string) => void;
    onCloseCapture: () => void;
    /** Re-ask the host for the OPEN drawer's capture. Optional. */
    onRefreshCapture?: () => void;
    /** Reopen an archived collab (collab_unarchive). */
    onUnarchive: () => void;
    /** Who is still invitable — engine-known agents merged with fs-only defs. */
    invitable: InviteCandidate[];
    /** One call per commit, with every slug picked. */
    onInvite: (slugs: string[]) => void;
    /** The lead's slug, or null when the collab has none. ABSENT/null is a real
     *  state — a leadless collab wakes nobody on an unaddressed human message — so
     *  it draws no badge rather than guessing. */
    lead?: string | null;
    /** Make one agent the lead, from its own chip. */
    onSetLead: (slug: string) => void;
    /** The standing objective and its writer, read by the setup card's third step. */
    objective?: string | null;
    onSetObjective: (text: string) => void;
    /** True once the pane's first state snapshot has landed; the setup card arms on it. */
    loaded: boolean;
    /** Per-agent spend, shown in the drawer. ABSENT on an older engine, never zero. */
    costTotals?: CollabCostTotal[];
    /** Stop ONE agent, and correct ONE agent. Both OPTIONAL — a caller that has not
     *  wired them gets today's roster, and the room-level Stop is untouched. */
    onStopAgent?: (slug: string) => void;
    onRedirect?: (slug: string, text: string) => void;
    /** What the engine said the LAST per-agent stop did, or null. It names its own
     *  agent, because `post` fans every reply out and the outcome must land on the
     *  chip it is about. */
    stopOutcome?: (StopOutcome & { agentSlug: string }) | null;
  }
  let {
    title, archived, participants, agents, glyphs,
    captureSlug, capture, captureError, captureLoaded,
    onContext, onCloseCapture, onRefreshCapture, onUnarchive, invitable, onInvite, lead = null, onSetLead,
    objective = null, onSetObjective, loaded, costTotals,
    onStopAgent, onRedirect, stopOutcome = null,
  }: Props = $props();

  /** The ONE chip whose correction box is open — two would be two drafts. */
  let redirectingSlug = $state<string | null>(null);

  /** One chip's Stop/Redirect pair — every rule in collabSupervision.ts. */
  const superviseOf = (p: Participant, st: AgentStatus | undefined) => chipSupervision({
    archived, removed: !!p.removedAt, name: nameOf(p), slug: p.agentSlug, state: st?.state ?? 'idle', stopOutcome, onStopAgent, onRedirect,
  });

  /** Shared by the ＋ trigger and the empty-roster coaching line, so both open ONE
   *  popover rather than two lists disagreeing about what is picked. */
  let pickerOpen = $state(false);
  /** Whether the setup card below is on screen — the card owns the decision. */
  let cardShowing = $state(false);

  const statusOf = (slug: string): AgentStatus | undefined => agents.find((a) => a.slug === slug);
  /** The glyph key, or null when nothing drawable resolves — the chip decides
   *  nothing, it just draws what it is handed. */
  const glyphIdOf = (slug: string): string | null => {
    const id = glyphs[slug] || slug;
    return archetypeGlyph(id) === null ? null : id;
  };
  /** SHORT name on the chip — the full def reads as a screed there, so it moves
   *  into chipTitle below instead. */
  const nameOf = (p: Participant): string => collabShortName(p.agentSlug, p.displayName);
  const fullNameOf = (p: Participant): string => p.displayName || p.agentSlug;

    /** The chip's hover text: the description, then the facts the chip cannot show. */
  const chipTitle = (p: Participant): string =>
    `${fullNameOf(p)} — ${p.model ?? 'no pinned model'} — ${p.sessionId ? 'click for its last prompt' : 'no context yet'}${lead === p.agentSlug ? ' — lead' : ''}`;

  const openParticipant = $derived(participants.find((p) => p.agentSlug === captureSlug) ?? null);
</script>

<div class="roster" role="list" aria-label="Collab participants">
  <span class="roster-title">{title}</span>
  {#if archived}
    <span class="roster-archived">archived</span>
    <button class="roster-resume" onclick={onUnarchive} title="Reopen this collab so it can post again">Resume</button>
  {/if}
  {#if participants.length === 0}
    <!-- The next ACTION, not the fact. This drives the same popover the ＋ trigger
         opens, and stands down while the setup card is up: its first step is this list. -->
    <span class="roster-empty">Invite an agent and it starts answering here.</span>
    {#if !archived && !cardShowing}
      <button class="roster-invite" onclick={() => (pickerOpen = true)}>Invite agents to this collab</button>
    {/if}
  {:else}
    {#each participants as p (p.agentSlug)}
      {@const st = statusOf(p.agentSlug)}
      <CollabRosterChip
        name={nameOf(p)}
        title={chipTitle(p)}
        agentState={ringState(st)}
        removed={!!p.removedAt}
        open={captureSlug === p.agentSlug}
        isLead={lead === p.agentSlug}
        glyphId={glyphIdOf(p.agentSlug)}
        lastError={st?.lastError}
        onOpen={() => onContext(p.agentSlug, p.sessionId)}
        onSetLead={p.removedAt || lead === p.agentSlug ? null : () => onSetLead(p.agentSlug)}
        supervise={superviseOf(p, st)}
        redirecting={redirectingSlug === p.agentSlug}
        onRedirectingChange={(on: boolean) => (redirectingSlug = on ? p.agentSlug : null)}
      />
    {/each}
  {/if}
  <!-- Archived is a closed room — nothing joins it, same as nothing posts to it. -->
  {#if !archived}
    <CollabRosterPicker bind:open={pickerOpen} candidates={invitable} {onInvite} />
  {/if}
</div>

<!-- The onboarding guide for a room that opened EMPTY. It decides its own
     visibility, and it GATES NOTHING — the composer, the invite popover above and
     every control below stay live with it up. -->
<CollabSetupCard
  bind:showing={cardShowing}
  {participants} {lead} {objective} {archived} {loaded} candidates={invitable}
  {onInvite} {onSetLead} {onSetObjective}
/>

{#if participants.length > 0}
  <!-- The presets deny `send_message`, so this is a mechanical fact about the room,
       not advice. Said once, quietly, where someone wondering is already looking. -->
  <div class="roster-sealed">Agents in this collab coordinate only through this room — they cannot message other chats.</div>
{/if}

{#if captureSlug}
  <!-- What the engine last sent THIS agent, plus the collab's spend. Under the
       roster rather than in a modal, so the stream stays readable beside it. -->
  <CollabContextDrawer
    slug={captureSlug}
    name={openParticipant ? nameOf(openParticipant) : captureSlug}
    hasSession={!openParticipant || !!openParticipant.sessionId}
    {capture}
    {captureError}
    {captureLoaded}
    {costTotals}
    activity={agents.find((a) => a.slug === captureSlug)?.activity}
    onRefresh={onRefreshCapture}
    onClose={onCloseCapture}
  />
{/if}

<style>
  .roster {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
  }
  .roster-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--og-text);
    margin-right: 6px;
  }
  .roster-archived {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 8px;
    color: var(--og-text-muted);
    border: 1px solid var(--og-border);
  }
  /* The archived-room resume action (collab-resume) — a small outline pill
     next to the tag it undoes, not styled as loud as an invite/primary action. */
  .roster-resume {
    font-size: 10px;
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--og-accent);
    background: transparent;
    color: var(--og-accent);
    cursor: pointer;
    font-family: inherit;
  }
  .roster-resume:hover { background: color-mix(in srgb, var(--og-accent) 16%, transparent); }
  .roster-empty {
    font-size: 11px;
    font-style: italic;
    color: var(--og-text-muted);
  }
  .roster-invite {
    font-size: 10px;
    padding: 2px 9px;
    border-radius: 999px;
    border: 1px solid var(--og-accent);
    background: transparent;
    color: var(--og-accent);
    cursor: pointer;
    font-family: inherit;
  }
  .roster-invite:hover { background: color-mix(in srgb, var(--og-accent) 16%, transparent); }
  /* Muted and borderless: a standing property of the room, never an event. */
  .roster-sealed {
    padding: 3px 12px;
    font-size: 10px;
    color: var(--og-text-muted);
    border-bottom: 1px solid var(--og-border);
    flex-shrink: 0;
  }

  /* The chip's own rules moved to CollabRosterChip.svelte, and the drawer's to
     CollabContextDrawer.svelte, with their markup. */
</style>
