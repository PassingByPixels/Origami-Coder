<script lang="ts">
  // ONE running agent's live row, extracted from CollabStream.svelte — which
  // was 36 lines over its 250-line cap once the pill landed, and the ratchet's
  // remedy is a component, not a raise.
  //
  // It draws on the AGENT SIDE, in the slot the agent's next bubble will take,
  // so the row it stands in for is the row it becomes.
  //
  // The mark is the rotating ThinkingGlyph — this surface has no per-turn
  // stream indicator of its own (the chat's does, which is why the chat's
  // thought keeps a static brain instead). A `thought` adds the brain after it,
  // so the two kinds are told apart by the mark as well as by the typography.
  //
  // M4.2: when the engine also sends the WHOLE reasoning (`liveThought`), the
  // block's BODY becomes that thought and its summary stays the one-line
  // activity — collapsed, so the transcript does not jump while the text grows
  // under it, and expandable for anyone who wants to read along. The summary
  // and the body are then two different facts (the newest line, and everything
  // said so far), which is exactly why the engine sends two fields.
  //
  // An engine that sends only an activity keeps today's pill verbatim; one that
  // sends neither still says "thinking…" rather than drawing a blank row.
  //
  // The avatar comes down as a SNIPPET rather than being drawn again here: an
  // agent that is a brand animal in the transcript must not become a letter
  // disc in its own pill.
  import type { Snippet } from 'svelte';
  import ThinkingGlyph from '../dashboard/components/ThinkingGlyph.svelte';
  import ThoughtPill from '../dashboard/components/ThoughtPill.svelte';
  import type { LivePill } from './collabActivity';

  interface Props {
    pill: LivePill;
    /** The agent's short name, resolved by the stream. */
    name: string;
    avatar: Snippet<[string, 'human' | 'agent']>;
  }
  let { pill, name, avatar }: Props = $props();
</script>

<div class="cs-group cs-pill">
  <div class="cs-avatar" aria-hidden="true">{@render avatar(pill.slug, 'agent')}</div>
  <div class="cs-body">
    <div class="cs-head"><span class="cs-author">{name}</span></div>
    {#snippet liveMark()}
      <span class="cs-pill-mark"><ThinkingGlyph active={true} size={13} /></span>
      {#if pill.kind === 'thought' || pill.thought}<span aria-hidden="true">🧠</span>{/if}
    {/snippet}
    <!-- Report 1.12: OPEN while there is reasoning to read, and only then —
         with no thought the body is the "nothing reported yet" placeholder,
         which says less than the summary already does. The block goes when the
         pill does, so a finished turn leaves nothing expanded behind. -->
    <ThoughtPill
      live
      open={!!pill.thought}
      mark={liveMark}
      mono={pill.kind === 'tool'}
      label={pill.text || 'thinking…'}
      text={pill.thought || pill.text || 'Nothing reported yet — this agent is running, and the engine has not said what it is on.'}
    />
  </div>
</div>

<style>
  /* The group/avatar/body geometry is CollabStream's; Svelte scopes styles per
     component, so the few rules this row needs are repeated here rather than
     inherited from a parent that no longer draws it. The max-width in
     particular MUST match the stream's — this row stands in the slot the
     agent's next bubble takes, and a pill narrower than the message it becomes
     would visibly jump on arrival. */
  .cs-group {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 94%;
    padding: 2px;
    border-radius: 6px;
  }
  .cs-avatar {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }
  .cs-body { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-width: 0; }
  .cs-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 1px; }
  .cs-author { font-size: 11px; font-weight: 600; color: var(--og-text); }
  .cs-pill-mark { display: inline-flex; vertical-align: middle; margin-right: 4px; }
</style>
