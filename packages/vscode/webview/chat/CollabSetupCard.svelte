<script lang="ts">
  // The guided card a room opened with an EMPTY roster offers (report S2).
  //
  // Create is title-only by design (M3): the room appears with nobody in it and
  // a composer that reaches nobody, and the three things that fix that — a
  // roster, a lead, an objective — were spread across a popover and two slash
  // commands. This card walks all three in one place.
  //
  // IT GATES NOTHING, AND THAT IS THE POINT. The M3 bug it is written against
  // was a Create button DISABLED by a roster list that had not arrived: a
  // disabled button fires no click, so the form's own refusal never ran, and
  // nothing on screen said why. So: no backdrop, no dialog role, no step is
  // another step's precondition, and dismissing costs nothing. The room works
  // identically with the card up, shut, or never looked at.
  //
  // The visual language is the product's question UI (QuestionModal.svelte) —
  // a header with a counter and a close, numbered blocks, a footer stepper —
  // ADAPTED, not imported: that component is a modal with a backdrop, in the
  // dashboard bundle, and a modal is the one thing this must not be.
  //
  // WHEN IT SHOWS. `armed` latches the first time a LOADED live room is seen
  // with an empty roster, and the card then stays through the steps it is
  // guiding, so step 2 becomes real as agents join. A room that already has a
  // roster never arms it, and an archived room never does either — there is
  // nothing left to set up.
  //
  // `loaded` is load-bearing, not defensive: the pane starts with an empty
  // participants array and fills it from its FIRST poll reply, so arming on
  // "the roster is empty" alone would flash this guide over every existing room
  // for one round trip.
  //
  // Step 1 mounts the SAME multi-select list the roster's ＋ popover does
  // (CollabInviteList.svelte) — one invite control, not two that can disagree —
  // and LEAVING step 1 sends its ticks through that list's own `commit` (W8:
  // Next walked past them, and the step change then dropped the selection).
  import CollabInviteList from './CollabInviteList.svelte';
  import { collabShortName } from './collabNames';
  import type { InviteCandidate } from './collabInvite';

  interface Participant { agentSlug: string; displayName: string; removedAt?: string }
  interface Props {
    participants: Participant[];
    candidates: InviteCandidate[];
    lead?: string | null;
    objective?: string | null;
    archived: boolean;
    /** True once the pane's first `collab_state` snapshot has been folded in.
     *  See the note above — this is what stops the guide flashing over an
     *  existing room while its roster is still on the wire. */
    loaded: boolean;
    onInvite: (slugs: string[]) => void;
    onSetLead: (slug: string) => void;
    onSetObjective: (text: string) => void;
    /** BINDABLE, read-only to the caller: whether the card is on screen. The
     *  roster uses it to keep its own inline invite button OUT of the way
     *  while step 1's list is showing — two invite lists on one screen is the
     *  duplication this card exists to remove, not create. */
    showing?: boolean;
  }
  let {
    participants, candidates, lead = null, objective = null, archived, loaded,
    onInvite, onSetLead, onSetObjective, showing = $bindable(false),
  }: Props = $props();

  let dismissed = $state(false);
  let armed = $state(false);
  let current = $state(0);
  let draftObjective = $state('');
  let inviteList = $state<CollabInviteList | undefined>(undefined);

  const active = $derived(participants.filter((p) => !p.removedAt));

  $effect(() => {
    if (loaded && !archived && active.length === 0) armed = true;
  });

  const STEPS = [
    { title: 'Invite the agents', hint: 'Pick one or more. You can add more at any time from the ＋ beside the roster.' },
    { title: 'Pick who leads', hint: 'The lead answers every message that names nobody.' },
    { title: 'Say what the room is for', hint: 'A standing objective every agent sees on every turn.' },
  ];
  const done = $derived([active.length > 0, !!lead, !!objective]);
  const show = $derived(armed && !dismissed && !archived);
  $effect(() => { showing = show; });

  /** Every exit from step 1 SENDS its ticks first — Next, and the stepper dots
   *  beside it. Empty sends nothing and still walks: this card gates nothing. */
  function goto(i: number) { if (current === 0) inviteList?.commit(); current = i; }

  function commitObjective() {
    const text = draftObjective.trim();
    if (text) onSetObjective(text);
    draftObjective = '';
  }

  /** The last step's finisher. It COMMITS a typed-but-unsent objective first:
   *  the box is on screen with the user's words in it, and a Done that threw
   *  them away would be the card losing work at the exact moment it claims the
   *  setup is finished. An empty box commits nothing, which is why this is
   *  commitObjective and not a second write. */
  function finish() {
    commitObjective();
    dismissed = true;
  }
</script>

{#if show}
  <div class="sc-card">
    <div class="sc-head">
      <span class="sc-title">Set this collab up</span>
      <span class="sc-counter">{current + 1} of {STEPS.length}</span>
      <button class="sc-close" onclick={() => (dismissed = true)} title="Dismiss this guide" aria-label="Dismiss the setup guide">&#10005;</button>
    </div>

    <div class="sc-body">
      <div class="sc-q-head">
        <span class="sc-q-num">{current + 1}.</span>
        <span class="sc-q-title">{STEPS[current].title}</span>
      </div>
      <div class="sc-hint">{STEPS[current].hint}</div>

      {#if current === 0}
        <CollabInviteList bind:this={inviteList} {candidates} {onInvite} showInvite={false} />
      {:else if current === 1}
        {#if active.length === 0}
          <div class="sc-note">Nobody has joined yet — the first agent to join takes the lead automatically, and you can change it here or from its chip.</div>
        {:else}
          <div class="sc-picks">
            {#each active as p (p.agentSlug)}
              <button class="sc-pick" class:on={lead === p.agentSlug} onclick={() => onSetLead(p.agentSlug)}>
                {collabShortName(p.agentSlug, p.displayName)}
              </button>
            {/each}
          </div>
        {/if}
      {:else}
        {#if objective}
          <div class="sc-note">Now: “{objective}”. Type below to replace it.</div>
        {/if}
        <input
          class="sc-input"
          bind:value={draftObjective}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitObjective(); } }}
          placeholder="What this room is for"
          aria-label="Collab objective" />
      {/if}
    </div>

    <div class="sc-foot">
      <button class="sc-btn" onclick={() => (dismissed = true)}>Dismiss</button>
      <div class="sc-stepper">
        {#each STEPS as s, i}
          <button
            class="sc-step"
            class:active={i === current}
            data-done={done[i] ? 'true' : 'false'}
            onclick={() => goto(i)}
            title={s.title}
            aria-label={`Step ${i + 1}: ${s.title}`}
          ><span class="sc-dot" class:filled={done[i]}></span></button>
        {/each}
      </div>
      <div class="sc-nav">
        <button class="sc-btn" onclick={() => goto(Math.max(0, current - 1))} disabled={current === 0}>Back</button>
        <!-- THE LAST STEP FINISHES (W6 owner UAT). It used to be a Next that
             was disabled on step 3, so the walk ended on a dead button and the
             only way out was Dismiss — which reads as "abandon this", not as
             "I am done". Done CLOSES the card, and it is deliberately NOT
             conditional on the three steps being satisfied: this card gates
             nothing, and a finisher that refused to finish would be the M3 bug
             the whole component is written against, in a new place. -->
        {#if current === STEPS.length - 1}
          <button class="sc-btn primary" onclick={finish}>Done</button>
        {:else}
          <button class="sc-btn primary" onclick={() => goto(current + 1)}>Next</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* An inline band under the roster — NOT an overlay. Nothing here is
     positioned over the pane, which is what keeps every control below it live. */
  .sc-card {
    flex-shrink: 0;
    margin: 6px 12px;
    border: 1px solid var(--og-chat);
    border-radius: 6px;
    background: var(--og-surface);
    display: flex;
    flex-direction: column;
  }
  .sc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--og-btn-bg);
    border-bottom: 1px solid var(--og-border);
  }
  .sc-title { font-weight: 600; font-size: 11px; color: var(--og-chat); }
  .sc-counter { font-size: 10px; color: var(--og-text-muted); font-variant-numeric: tabular-nums; margin-right: auto; }
  .sc-close {
    width: 18px; height: 18px; padding: 0; line-height: 1;
    background: transparent; border: 1px solid var(--og-border); border-radius: 3px;
    color: var(--og-text-muted); cursor: pointer; font-size: 10px; font-family: inherit;
  }
  .sc-close:hover { color: var(--og-text); background: var(--og-btn-bg); }
  .sc-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .sc-q-head { display: flex; align-items: baseline; gap: 6px; }
  .sc-q-num { font-weight: 700; font-size: 11px; color: var(--og-chat); }
  .sc-q-title { font-weight: 600; font-size: 11px; color: var(--og-text); }
  .sc-hint { font-size: 10px; color: var(--og-text-muted); }
  .sc-note { font-size: 10px; color: var(--og-text-secondary); }
  .sc-picks { display: flex; flex-wrap: wrap; gap: 6px; }
  .sc-pick {
    font-size: 11px; padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--og-border); background: var(--og-btn-bg);
    color: var(--og-text); cursor: pointer; font-family: inherit;
  }
  .sc-pick:hover { border-color: var(--og-accent); }
  .sc-pick.on { border-color: var(--og-warning); color: var(--og-warning); }
  .sc-input {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 11px;
    color: var(--og-text); background: var(--og-btn-bg);
    border: 1px solid var(--og-border); border-radius: 4px; padding: 4px 8px; outline: none;
  }
  .sc-input:focus { border-color: var(--og-accent); }
  .sc-foot {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-top: 1px solid var(--og-border);
  }
  .sc-btn {
    font-size: 10px; padding: 3px 10px; border-radius: 5px;
    border: 1px solid var(--og-border); background: var(--og-btn-bg);
    color: var(--og-text-secondary); cursor: pointer; font-family: inherit;
  }
  .sc-btn:hover:not(:disabled) { border-color: var(--og-chat); color: var(--og-text); }
  .sc-btn:disabled { opacity: 0.4; cursor: default; }
  .sc-btn.primary { color: var(--og-text); border-color: var(--og-chat); }
  .sc-stepper { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: center; }
  .sc-step { padding: 0; background: none; border: none; cursor: pointer; display: flex; font-family: inherit; }
  .sc-dot { width: 9px; height: 9px; border-radius: 2px; background: var(--og-border); }
  .sc-step.active .sc-dot { background: var(--og-chat); }
  .sc-dot.filled { background: var(--og-success); }
  .sc-nav { display: flex; gap: 6px; }
</style>
